import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Response } from 'express';
import { ChildProcess } from 'child_process';
import {
  existsSync,
  statSync,
  createReadStream,
  unlinkSync,
} from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import * as mammoth from 'mammoth';
import { PrismaService } from '../../prisma/prisma.service';
import { CodexService } from '../../common/services/codex.service';
import { injectSkillSection } from '../../common/utils/skill-prompt';
import { DINGTALK_ADAPTER, DingTalkAdapter } from '../project/adapters/adapter.interfaces';
import { ContractTemplateService } from './contract-template.service';
import { CreateContractDto, ContractElementsDto } from './dto/create-contract.dto';
import { Prisma, ContractDocumentType } from '@prisma/client';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';
import { CreateProjectUseCase } from '../project/application/create-project.use-case';

/**
 * 合同协作服务。
 *
 * 数据流（ASCII 图）：
 *   generateDraft（复用 CreateProjectUseCase 事务建单，P1-03；绕过咨询 riskService/prompt）
 *     → executeStream(合同起草 prompt, timeout 600s) → SSE 推前端
 *     → 流结束: ContractDocument(type=draft, version=N) 落库 + assistant 消息 + status→待复核
 *   submitReview（business 发起法务审阅，统一 Policy 校验）
 *   reviewContract（legal AI 风险审查，P1-05）
 *     → 显式 sourceDocumentId（缺省取项目最新可审查 ContractDocument，不再按 role/label 推断）
 *     → 先创建 ContractReviewRun(queued/running, sourceDocumentId) 再启动 Codex
 *     → 风险报告只进 ReviewRun.result，绝不创建为 ContractDocument
 *   uploadFile / downloadFile（附件，diskStorage 落盘 + 统一 Policy；revised/final+docx 抽取
 *     文本 → ContractDocument(type=revised/final)）
 */
@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly codexService: CodexService,
    private readonly templateService: ContractTemplateService,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    private readonly createProjectUseCase: CreateProjectUseCase,
    private readonly accessPolicy: ProjectAccessPolicy,
  ) {
    this.storageDir = process.env.CONTRACT_STORAGE_DIR
      || join(process.cwd(), 'storage', 'contracts');
  }

  // ═══════════════════════════════════════════
  // 生成合同草稿
  // ═══════════════════════════════════════════

  /**
   * 生成合同草稿。新建工单复用 CreateProjectUseCase（事务 + 幂等 + Outbox，P1-03），
   * 不再手工分步创建。返回 SSE 子进程供 controller 推送。
   */
  async generateDraft(
    dto: CreateContractDto,
    actor: ProjectActor,
    signal?: AbortSignal,
  ): Promise<{ projectId: string; stream: ChildProcess }> {
    const template = await this.templateService.findBySlug(dto.templateSlug);
    const elements = dto.elements || {};

    // 空要素校验（测试用例 #13）
    if (!this.hasAnyElement(elements)) {
      throw new BadRequestException('请至少填写一个合同要素');
    }

    let projectId: string;
    if (dto.projectId) {
      const existing = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
      if (!existing) throw new NotFoundException('工单不存在');
      this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, existing);
      if (existing.route !== 'llm') {
        throw new ConflictException('该工单已进入法务流程，无法继续生成'); // 升级守卫
      }
      projectId = existing.id;
      await this.prisma.projectMessage.create({
        data: { projectId, role: 'user', text: this.buildElementsText(elements) },
      });
    } else {
      const { project } = await this.createProjectUseCase.execute({
        kind: 'contract',
        title: `合同草稿·${template.name}`,
        input: this.buildElementsText(elements),
        creatorId: actor.id,
        risk: 'P2',
        route: 'llm',
        legalBpId: null,
        idempotencyKey: dto.idempotencyKey ?? null,
        contractTemplateSlug: template.slug,
        events: [this.formatTime() + ' · AI 正在生成合同草稿…'],
      });
      projectId = project.id;
    }

    const prompt = this.buildDraftPrompt(template.prompt, elements, template.slug, template.name);
    // 合同草稿远长于咨询回复：timeout 放宽到 600s（实测超时根因，2026-08-03）
    const stream = await this.codexService.executeStream(prompt, {
      timeout: 600_000,
      sessionId: projectId,
      signal,
    });

    let fullText = '';
    stream.stdout?.on('data', (chunk: Buffer) => { fullText += chunk.toString(); });

    stream.on('close', async (code) => {
      // 连接断开主动取消 → 不写失败状态（刷新 ≠ 生成失败）
      if ((stream as any).__cancelled) return;
      if (code === 0 && fullText.trim()) {
        try {
          await this.prisma.$transaction(async (tx) => {
            // AI 草稿 → ContractDocument(type=draft, version=N)；消息仅供 UI，不是审查数据源
            await this.createContractDocument(tx, {
              projectId,
              documentType: 'draft',
              content: fullText.trim(),
              createdBy: actor.id,
            });
            await tx.projectMessage.create({
              data: { projectId, role: 'assistant', text: fullText.trim() },
            });
            await tx.project.update({
              where: { id: projectId },
              data: { status: '待复核', result: fullText.trim() },
            });
          });
          await this.addEvent(projectId, this.formatTime() + ' · 合同草稿已生成');
          // 独立提示消息（不放入合同正文）
          const pendingCount = (fullText.match(/【待补充】/g) || []).length;
          await this.addEvent(
            projectId,
            `本稿共 ${pendingCount} 处【待补充】，需双方确认后填写。本稿由 AI 生成，仅供参考，需经法务审阅后生效。`,
          );
        } catch (err) {
          this.logger.error(`合同草稿落库失败：${err}`);
        }
      } else {
        this.logger.error(`合同草稿生成失败，code=${code}`);
        try {
          await this.prisma.project.update({
            where: { id: projectId },
            data: { status: '待处理', isFailed: true },
          });
          await this.addEvent(projectId, this.formatTime() + ' · 合同草稿生成失败，已转人工处理');
        } catch (err) {
          this.logger.error(`失败状态更新失败：${err}`);
        }
      }
    });

    return { projectId, stream };
  }

  // ═══════════════════════════════════════════
  // 发起法务审阅 / AI 风险审查
  // ═══════════════════════════════════════════

  /** business 发起法务审阅 — 原子守卫 WHERE route=llm 防重复提交（统一 Policy 校验） */
  async submitReview(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.SubmitReview, project);

    const updated = await this.prisma.project.updateMany({
      where: { id: projectId, route: 'llm' },
      data: { route: 'legalbp', status: '待复核' },
    });
    if (updated.count === 0) throw new ConflictException('该工单已进入法务流程');

    await this.addEvent(projectId, this.formatTime() + ' · 已发起法务审阅，通知法务BP');
    try {
      await this.dingtalk.sendNotification(
        project.dingtalkChatId || 'contract-review',
        `合同协作工单待审阅：${project.title}`,
      );
    } catch (e) {
      this.logger.warn(`钉钉通知失败（Mock）：${e}`);
    }
    return { projectId, status: '待复核' };
  }

  /**
   * legal AI 风险审查（P1-05）：显式 sourceDocumentId，缺省取项目最新可审查 ContractDocument。
   * 风险报告永远只进 ContractReviewRun.result，绝不创建为 ContractDocument。
   */
  async reviewContract(
    projectId: string,
    actor: ProjectActor,
    skillId?: string,
    sourceDocumentId?: string,
    signal?: AbortSignal,
  ): Promise<{
    projectId: string;
    stream: ChildProcess;
    reviewRunId: string;
    sourceDocumentId: string;
    sourceVersion: number;
  }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    if (project.kind !== 'contract') throw new BadRequestException('非合同工单');
    if (project.status !== '待复核') throw new BadRequestException('当前状态不可发起审查');
    this.accessPolicy.assertCan(actor, ProjectAction.ReviewContract, project);

    // 技能解析（审查时选技能 → 读实时 prompt；可用范围 = 公有 + 自己的私有）
    let skillName: string | null = null;
    let skillPrompt: string | null = null;
    if (skillId) {
      const skill = await this.prisma.skill
        .findFirst({
          where: {
            id: skillId,
            isActive: true,
            OR: [{ visibility: 'public' }, { creatorId: actor.id, visibility: 'private' }],
          },
        })
        .catch(() => null);
      if (skill) {
        skillName = skill.name;
        skillPrompt = skill.prompt;
      } else {
        this.logger.warn(`审查技能 skillId=${skillId} 解析失败，按无技能审查`);
      }
    }
    if (skillName) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { skillId: skillId ?? null, skillName },
      });
    }

    // 解析源文档：显式 sourceDocumentId 必须属于当前项目；缺省取最新可审查文档
    const sourceDoc = await this.resolveSourceDocument(projectId, sourceDocumentId);
    if (!sourceDoc) throw new BadRequestException('未找到可审查的合同文档');

    // 先创建 ContractReviewRun 再启动 Codex（9.3-5）
    const reviewRun = await this.prisma.contractReviewRun.create({
      data: {
        projectId,
        sourceDocumentId: sourceDoc.id,
        status: 'running',
        startedAt: new Date(),
        skillId: skillId ?? null,
        createdBy: actor.id,
      },
    });

    const prompt = this.buildReviewPrompt(
      sourceDoc.content,
      skillName ?? undefined,
      skillPrompt ?? undefined,
    );

    let stream: ChildProcess;
    try {
      stream = await this.codexService.executeStream(prompt, {
        timeout: 600_000,
        sessionId: projectId,
        signal,
      });
    } catch (e) {
      // 队列繁忙/排队超时：审查未开始，标记 failed（SSE 开始前返回 HTTP 错误）
      await this.prisma.contractReviewRun
        .update({
          where: { id: reviewRun.id },
          data: {
            status: 'failed',
            errorMessage: String((e as Error)?.message ?? e).slice(0, 200),
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw e;
    }

    let fullText = '';
    stream.stdout?.on('data', (chunk: Buffer) => { fullText += chunk.toString(); });

    stream.on('close', async (code) => {
      if ((stream as any).__cancelled) {
        await this.prisma.contractReviewRun
          .update({
            where: { id: reviewRun.id },
            data: { status: 'cancelled', errorMessage: '审查已取消', completedAt: new Date() },
          })
          .catch(() => undefined);
        return;
      }
      if (code === 0 && fullText.trim()) {
        try {
          // 风险报告只进 ReviewRun.result（9.3-6）；另写 ProjectMessage 供 UI 展示
          await this.prisma.$transaction([
            this.prisma.contractReviewRun.update({
              where: { id: reviewRun.id },
              data: { status: 'succeeded', result: fullText.trim(), completedAt: new Date() },
            }),
            this.prisma.projectMessage.create({
              data: { projectId, role: 'assistant', text: fullText.trim(), label: 'AI 风险审查' },
            }),
          ]);
          await this.addEvent(projectId, this.formatTime() + ' · AI 风险审查完成');
        } catch (err) {
          this.logger.error(`审查结果落库失败：${err}`);
        }
      } else {
        await this.prisma.contractReviewRun
          .update({
            where: { id: reviewRun.id },
            data: { status: 'failed', errorMessage: 'Codex 审查失败或超时', completedAt: new Date() },
          })
          .catch(() => undefined);
        await this.addEvent(projectId, this.formatTime() + ' · AI 风险审查失败，请人工审阅');
      }
    });

    return {
      projectId,
      stream,
      reviewRunId: reviewRun.id,
      sourceDocumentId: sourceDoc.id,
      sourceVersion: sourceDoc.version,
    };
  }

  // ═══════════════════════════════════════════
  // 附件（上传 / 列表 / 下载）
  // ═══════════════════════════════════════════

  /** 上传合同附件（multer diskStorage 已落盘到 file.path；统一 Policy 校验） */
  async uploadFile(
    projectId: string,
    file: Express.Multer.File,
    kind: string,
    actor: ProjectActor,
  ) {
    if (!file) throw new BadRequestException('未收到文件');
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);

    // 类型白名单（不信任 mimetype，工程评审决策 #6）
    const ext = extname(file.originalname).toLowerCase();
    const allowed = ['.docx', '.pdf', '.txt', '.md'];
    if (!allowed.includes(ext)) {
      this.tryCleanup(file.path);
      throw new BadRequestException('不支持的文件类型，仅支持 .docx/.pdf/.txt/.md');
    }
    if (file.size > 20 * 1024 * 1024) {
      this.tryCleanup(file.path);
      throw new BadRequestException('文件超过 20MB 限制');
    }
    if (kind !== 'revised' && kind !== 'final') {
      this.tryCleanup(file.path);
      throw new BadRequestException('kind 仅支持 revised / final');
    }

    let record;
    try {
      record = await this.prisma.contractFile.create({
        data: {
          projectId,
          kind,
          originalName: file.originalname,
          storedName: file.filename || `${randomUUID()}${ext}`,
          mimeType: file.mimetype,
          size: file.size,
          uploadedBy: actor.id,
        },
      });
    } catch (e) {
      this.tryCleanup(file.path);
      this.logger.error(`附件记录落库失败：${e}`);
      throw new InternalServerErrorException('附件保存失败');
    }

    // revised/final + .docx：mammoth 抽取正文 → ContractDocument（9.3-2/9.3-3）。
    // 抽取失败不得创建空文档，返回 textExtracted=false 让前端可识别"暂不可审查"。
    let textExtracted = false;
    if ((kind === 'revised' || kind === 'final') && ext === '.docx') {
      try {
        const result = await mammoth.extractRawText({ path: file.path });
        const text = result.value.trim();
        if (text) {
          textExtracted = true;
          await this.prisma.$transaction(async (tx) => {
            await this.createContractDocument(tx, {
              projectId,
              documentType: kind as ContractDocumentType,
              content: text,
              sourceFileId: record.id,
              createdBy: actor.id,
            });
            await tx.projectMessage.create({
              data: {
                projectId,
                role: 'assistant',
                text,
                label: kind === 'revised' ? '修订版文本' : '终稿文本',
              },
            });
          });
        }
      } catch (e) {
        this.logger.warn(`mammoth 抽取失败（不影响上传）：${e}`);
      }
    }

    await this.addEvent(projectId, this.formatTime() + ` · 上传了合同文件：${file.originalname}`);
    return {
      fileId: record.id,
      originalName: record.originalName,
      size: record.size,
      kind: record.kind,
      textExtracted,
    };
  }

  /** 附件列表（含上传人显示名） */
  async listFiles(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);
    return this.prisma.contractFile.findMany({
      where: { projectId },
      include: { uploader: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 下载附件 — 读磁盘流，RFC5987 filename* 支持中文名（工程评审决策 #9） */
  async downloadFile(
    projectId: string,
    fileId: string,
    actor: ProjectActor,
    res: Response,
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);

    const file = await this.prisma.contractFile.findFirst({
      where: { id: fileId, projectId },
    });
    if (!file) throw new NotFoundException('文件不存在');

    const targetPath = join(this.storageDir, projectId, file.storedName);
    if (!existsSync(targetPath)) throw new NotFoundException('文件已丢失');

    const stat = statSync(targetPath);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    );
    res.setHeader('Content-Length', stat.size);
    createReadStream(targetPath).pipe(res);
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /**
   * 解析审查源文档（P1-05）：显式 sourceDocumentId 必须属于当前项目；
   * 缺省取项目最新 ContractDocument（风险报告只进 ReviewRun，不会混入文档表，
   * 因此不会把上一次风险报告当合同正文）。
   */
  private async resolveSourceDocument(
    projectId: string,
    sourceDocumentId?: string,
  ): Promise<{ id: string; content: string; version: number } | null> {
    if (sourceDocumentId) {
      const doc = await this.prisma.contractDocument.findFirst({
        where: { id: sourceDocumentId, projectId },
        select: { id: true, content: true, version: true },
      });
      if (!doc) throw new BadRequestException('源文档不存在或不属于当前工单');
      return doc;
    }
    return this.prisma.contractDocument.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true, version: true },
    });
  }

  /**
   * 版本号安全分配（9.3-4）：事务内 count+1；并发唯一冲突(P2002)重试，不覆盖旧版本。
   */
  private async createContractDocument(
    tx: Prisma.TransactionClient,
    data: {
      projectId: string;
      documentType: ContractDocumentType;
      content: string;
      sourceFileId?: string | null;
      createdBy?: string | null;
    },
    attempts = 0,
  ): Promise<any> {
    const count = await tx.contractDocument.count({ where: { projectId: data.projectId } });
    const version = count + 1;
    try {
      return await tx.contractDocument.create({ data: { ...data, version } });
    } catch (e: any) {
      if (e?.code === 'P2002' && attempts < 5) {
        return this.createContractDocument(tx, data, attempts + 1);
      }
      throw e;
    }
  }

  private hasAnyElement(e: ContractElementsDto): boolean {
    return !!(e.partyA || e.partyB || e.amount || e.term || e.clauses);
  }

  private buildElementsText(e: ContractElementsDto): string {
    const fields: [string, string | undefined][] = [
      ['甲方', e.partyA], ['乙方', e.partyB], ['金额', e.amount], ['期限', e.term],
      ['甲方通讯地址', e.partyAAddress], ['甲方授权代表', e.partyARepresentative],
      ['甲方经办人', e.partyAContact], ['甲方联系电话', e.partyATel], ['甲方电子邮件', e.partyAEmail],
      ['乙方通讯地址', e.partyBAddress], ['乙方联系人', e.partyBContact], ['乙方联系电话', e.partyBTel],
      ['服务内容', e.serviceContent], ['结算方式', e.settlement], ['特殊条款', e.specialClauses],
      ['保密信息范围', e.confidentialScope], ['项目名称', e.projectName],
      ['经费与支付方式', e.payment], ['交付物与验收', e.deliverable], ['知识产权', e.ipOwnership],
      ['主要条款', e.clauses],
    ];
    const filled = fields.filter(([, v]) => v && v.trim());
    return '合同要素摘要：\n' + filled.map(([k, v]) => `${k}：${v}`).join('\n');
  }

  /** 用模板 prompt + 要素填充起草 prompt（⚠️ 必须覆盖所有模板占位符，漏掉则 AI 看到字面量） */
  private buildDraftPrompt(
    templatePrompt: string,
    e: ContractElementsDto,
    slug?: string,
    name?: string,
  ): string {
    const fill = (s?: string) => (s && s.trim()) || '【待补充】';
    let filled = templatePrompt
      .split('{partyA}').join(fill(e.partyA))
      .split('{partyB}').join(fill(e.partyB))
      .split('{amount}').join(fill(e.amount))
      .split('{term}').join(fill(e.term))
      .split('{clauses}').join(fill(e.clauses))
      .split('{serviceContent}').join(fill(e.serviceContent))
      .split('{settlement}').join(fill(e.settlement))
      .split('{specialClauses}').join(fill(e.specialClauses))
      .split('{confidentialScope}').join(fill(e.confidentialScope))
      .split('{projectName}').join(fill(e.projectName))
      .split('{payment}').join(fill(e.payment))
      .split('{deliverable}').join(fill(e.deliverable))
      .split('{ipOwnership}').join(fill(e.ipOwnership))
      .split('{partyAAddress}').join(fill(e.partyAAddress))
      .split('{partyARepresentative}').join(fill(e.partyARepresentative))
      .split('{partyAContact}').join(fill(e.partyAContact))
      .split('{partyATel}').join(fill(e.partyATel))
      .split('{partyAEmail}').join(fill(e.partyAEmail))
      .split('{partyBAddress}').join(fill(e.partyBAddress))
      .split('{partyBContact}').join(fill(e.partyBContact))
      .split('{partyBTel}').join(fill(e.partyBTel));

    // 指示 AI 读取工作区内的模板原文（工程决策 2026-08-03，替代全文注入 prompt）
    if (slug) {
      filled += `\n\n## 模板原文参照\n工作区内 templates/${slug}.md 为《${name || slug}》公司审定模板原文，请用文件读取工具读取该文件，并严格参照其章节结构与条款口径起草，不得偏离模板表述。`;
    }
    return filled;
  }

  /** 法务端 AI 风险审查 prompt（技能指令段注入顶部，工程决策 #3/#5） */
  private buildReviewPrompt(text: string, skillName?: string, skillPrompt?: string): string {
    const base = `你是企业合同审查专家。审查下方合同内容，逐条识别法律风险。

## 输出格式（每条风险独立成块）
### 第 N 条 · {条款标题}
- 原文摘要：…
- 风险等级：【高/中/低】
- 风险分析：…
- 修改建议：…

## 审查要点
- 违约责任、责任上限、违约金比例是否失衡
- 知识产权归属与许可范围
- 保密条款、竞业限制的合理性与可执行性
- 付款节点与交付验收的对应关系
- 争议解决条款（管辖法院/仲裁）的合法性
- 是否有明显违反强制性法律法规的条款

## 结尾
输出"总体评价"：该合同整体风险等级（高/中/低）+ 必须修改的核心条款清单

## 合同内容
${text}`;
    // 技能段由共享 util 注入（含边界标记剥除）
    return injectSkillSection(base, skillName ?? '', skillPrompt ?? '');
  }

  private tryCleanup(path?: string) {
    if (path) { try { unlinkSync(path); } catch {} }
  }

  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({ data: { projectId, text } });
  }

  private formatTime(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
