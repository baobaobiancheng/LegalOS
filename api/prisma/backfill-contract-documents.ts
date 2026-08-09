import 'dotenv/config';
import { PrismaClient, ContractDocumentType } from '@prisma/client';

/**
 * P1-05 合同文档存量回填脚本（可重复执行，支持 --dry-run）。
 *
 * 规则（任务书 9.4）：
 * - 只处理 Project.kind='contract'。
 * - 排除 label='AI 风险审查' 的消息（风险报告不是合同正文）。
 * - label='修订版文本' → revised；label='终稿文本' → final。
 * - 无 label 的 assistant 消息确定为合同草稿 → draft。
 * - 其余带未知 label 的 assistant 消息 → 歧义，记录不创建（禁止猜测）。
 * - 同一项目按消息创建时间分配递增版本号。
 * - 幂等：项目已存在 ContractDocument（含新代码写入或上次回填）→ 跳过整个项目。
 *
 * 用法：
 *   npx ts-node prisma/backfill-contract-documents.ts --dry-run   # 试运行，不写库
 *   npx ts-node prisma/backfill-contract-documents.ts              # 实际回填
 */
const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface PendingDoc {
  documentType: ContractDocumentType;
  content: string;
  messageId: string;
  label: string | null;
}

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { kind: 'contract' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  let scanned = 0;
  let created = 0;
  let skippedProjects = 0;
  let skippedMessages = 0;
  const ambiguous: Array<{ projectId: string; messageId: string; label: string | null }> = [];

  for (const project of projects) {
    scanned++;

    // 幂等：已存在 ContractDocument（新代码写入或上次回填）→ 跳过
    const docCount = await prisma.contractDocument.count({ where: { projectId: project.id } });
    if (docCount > 0) {
      skippedProjects++;
      continue;
    }

    const docs: PendingDoc[] = [];
    for (const m of project.messages) {
      if (m.role !== 'assistant') {
        skippedMessages++;
        continue;
      }
      if (m.label === 'AI 风险审查') {
        skippedMessages++; // 风险报告不是合同正文
        continue;
      }
      if (!m.text || !m.text.trim()) {
        skippedMessages++; // 不创建空文档
        continue;
      }
      let documentType: ContractDocumentType;
      if (m.label === '修订版文本') documentType = 'revised';
      else if (m.label === '终稿文本') documentType = 'final';
      else if (m.label === null || m.label === '') documentType = 'draft';
      else {
        // 无法可靠判断的 label → 歧义，禁止猜测
        ambiguous.push({ projectId: project.id, messageId: m.id, label: m.label });
        continue;
      }
      docs.push({ documentType, content: m.text, messageId: m.id, label: m.label });
    }

    if (docs.length === 0) continue;

    if (DRY_RUN) {
      created += docs.length;
      continue;
    }

    // 事务内按创建时间分配递增版本号；并发撞唯一约束(P2002) → 视为已被并发回填，跳过
    try {
      await prisma.$transaction(async (tx) => {
        let version = 1;
        for (const d of docs) {
          await tx.contractDocument.create({
            data: {
              projectId: project.id,
              documentType: d.documentType,
              version,
              content: d.content,
              createdBy: project.creatorId,
            },
          });
          version++;
        }
      });
      created += docs.length;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        skippedProjects++; // 并发回填已创建
        console.warn(`[跳过] 项目 ${project.id} 已被并发回填（版本冲突）`);
      } else {
        throw e;
      }
    }
  }

  console.log('===== 合同文档回填报告 =====');
  console.log(`扫描工单：${scanned}`);
  console.log(`创建文档：${created}${DRY_RUN ? '（--dry-run 未写库）' : ''}`);
  console.log(`跳过（已有文档的项目）：${skippedProjects}`);
  console.log(`跳过（非文档消息/空正文）：${skippedMessages}`);
  console.log(`歧义消息：${ambiguous.length}`);
  for (const a of ambiguous) {
    console.log(`  - projectId=${a.projectId} messageId=${a.messageId} label=${a.label ?? ''}`);
  }
  if (ambiguous.length) {
    console.warn(`警告：${ambiguous.length} 条消息无法可靠判断文档类型，未创建（禁止猜测）。如需处理请人工确认。`);
  }
}

main()
  .catch((e) => {
    console.error('回填失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
