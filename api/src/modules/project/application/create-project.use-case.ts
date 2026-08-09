import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectKind, RiskLevel, Prisma } from '@prisma/client';

/**
 * 工单创建事务用例（P1-03）：
 * 项目、首条消息、事件、需要建群的 OutboxEvent 在同一 Prisma 交互式事务内提交，
 * 要么全部提交，要么全部回滚。事务提交后立即返回，不再在请求内同步调用钉钉。
 *
 * 幂等：沿用 Project.idempotencyKey 唯一索引 + P2002 竞争兜底；返回旧工单前校验
 * creatorId 与当前请求一致，不同用户碰撞同一键返回 409，不泄露他人工单。
 *
 * ContractService.generateDraft() 新建合同工单同样复用本用例（而非手工分步创建）。
 */
export interface CreateProjectCommand {
  kind: ProjectKind;
  title: string;
  /** 首条消息正文（用户输入 / 合同要素摘要） */
  input: string;
  creatorId: string;
  ownerId?: string;
  risk: RiskLevel;
  route: 'llm' | 'legalbp';
  legalBpId: string | null;
  skillId?: string | null;
  skillName?: string | null;
  requesterName?: string | null;
  requesterDepartment?: string | null;
  crmReference?: string | null;
  idempotencyKey?: string | null;
  /** extra JSON（技能 prompt 快照等） */
  extra?: Prisma.InputJsonValue | null;
  contractTemplateSlug?: string | null;
  /** 事务内额外写入的事件文案（含时间戳前缀，调用方拼接） */
  events?: string[];
  /** 是否在事务内入队"钉钉建群" Outbox 事件（仅 legalbp 路由） */
  enqueueDingtalkGroup?: boolean;
}

/** Outbox 建群事件稳定去重键：同一工单重复入队/重试只处理一次 */
export function dingtalkGroupOutboxDedupKey(projectId: string): string {
  return `project:${projectId}:dingtalk-group:create:v1`;
}

export const OUTBOX_EVENT_DINGTALK_GROUP_CREATE = 'dingtalk.group.create';

@Injectable()
export class CreateProjectUseCase {
  private readonly logger = new Logger(CreateProjectUseCase.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 执行事务创建。返回 { project, created }：
   * - created=true：本次新建（含首消息/事件/Outbox）
   * - created=false：命中幂等键，返回已存在工单（已校验创建者一致）
   */
  async execute(cmd: CreateProjectCommand): Promise<{ project: any; created: boolean }> {
    const include = {
      creator: { select: { id: true, username: true, displayName: true, role: true } },
      owner: { select: { id: true, username: true, displayName: true, role: true } },
    };

    // 0. 幂等预查（P1-03）：同一 idempotencyKey 只创建一个工单
    if (cmd.idempotencyKey) {
      const existing = await this.prisma.project.findUnique({
        where: { idempotencyKey: cmd.idempotencyKey },
        include,
      });
      if (existing) {
        this.assertCreatorConsistency(existing, cmd.creatorId);
        return { project: existing, created: false };
      }
    }

    try {
      const project = await this.prisma.$transaction(async (tx) => {
        const p = await tx.project.create({
          data: {
            kind: cmd.kind,
            title: cmd.title,
            status: '分析中',
            risk: cmd.risk,
            route: cmd.route,
            creatorId: cmd.creatorId,
            ownerId: cmd.ownerId ?? cmd.creatorId,
            legalBpId: cmd.legalBpId,
            skillId: cmd.skillId ?? null,
            skillName: cmd.skillName ?? null,
            requesterName: cmd.requesterName ?? null,
            requesterDepartment: cmd.requesterDepartment ?? null,
            crmReference: cmd.crmReference ?? null,
            idempotencyKey: cmd.idempotencyKey ?? null,
            contractTemplateSlug: cmd.contractTemplateSlug ?? null,
            extra: cmd.extra ?? Prisma.JsonNull,
          },
          include,
        });

        // 首条消息（role 由服务端派生：用户输入恒为 'user'）
        await tx.projectMessage.create({
          data: { projectId: p.id, role: 'user', text: cmd.input },
        });

        // 事件
        for (const ev of cmd.events ?? []) {
          await tx.projectEvent.create({ data: { projectId: p.id, text: ev } });
        }

        // Outbox：需要建群时入队（事务内写入，事务提交后才由 Worker 消费）
        if (cmd.enqueueDingtalkGroup) {
          await tx.outboxEvent.create({
            data: {
              eventType: OUTBOX_EVENT_DINGTALK_GROUP_CREATE,
              aggregateType: 'project',
              aggregateId: p.id,
              dedupKey: dingtalkGroupOutboxDedupKey(p.id),
              payload: { projectId: p.id },
              projectId: p.id,
            },
          });
        }

        return p;
      });
      return { project, created: true };
    } catch (e: any) {
      // 并发撞幂等键唯一约束（P2002）→ 重新读取返回已存在工单（先校验创建者）
      if (cmd.idempotencyKey && e?.code === 'P2002') {
        const existing = await this.prisma.project.findUnique({
          where: { idempotencyKey: cmd.idempotencyKey },
          include,
        });
        if (existing) {
          this.assertCreatorConsistency(existing, cmd.creatorId);
          return { project: existing, created: false };
        }
      }
      throw e;
    }
  }

  /**
   * 幂等键碰撞时的创建者一致性校验：不同用户碰撞同一键返回 409，不能泄露他人工单。
   */
  private assertCreatorConsistency(project: any, creatorId: string): void {
    if (project.creatorId !== creatorId) {
      this.logger.warn(`幂等键 ${project.idempotencyKey} 被不同用户重复提交（${creatorId} vs ${project.creatorId}），返回 409`);
      throw new ConflictException('该幂等键已被其他用户使用');
    }
  }
}
