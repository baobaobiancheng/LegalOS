import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectKind, RiskLevel, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

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
  sourceAppId?: string | null;
  crmTaskId?: string | null;
  contractNo?: string | null;
  crmPayloadSha256?: string | null;
  crmFileManifestSha256?: string | null;
  crmReference?: string | null;
  idempotencyKey?: string | null;
  /** extra JSON（技能 prompt 快照等） */
  extra?: Prisma.InputJsonValue | null;
  /** 首条消息关联的咨询附件 id（2026-08-12） */
  attachmentIds?: string[];
  contractTemplateSlug?: string | null;
  /** 事务内额外写入的事件文案（含时间戳前缀，调用方拼接） */
  events?: string[];
  /** 是否在事务内入队"钉钉建群" Outbox 事件（仅 legalbp 路由） */
  enqueueDingtalkGroup?: boolean;
  /** P1-11：风险分类证据，事务内写入 RiskAssessmentLog（不含完整咨询正文） */
  riskLog?: {
    finalRisk: string;
    route: string;
    domain?: string | null;
    ruleFloor?: string | null;
    matchedRuleIds: string[];
    modelRisk?: string | null;
    modelReason?: string | null;
    classifierVersion: string;
  } | null;
}

/** Outbox 建群事件稳定去重键：同一工单重复入队/重试只处理一次 */
export function dingtalkGroupOutboxDedupKey(projectId: string): string {
  return `project:${projectId}:dingtalk-group:create:v1`;
}

/** 新 BP 加入已有群的稳定去重键：同一工单/BP 只保留一个外部副作用事件。 */
export function dingtalkMemberOutboxDedupKey(projectId: string, userId: string): string {
  return `project:${projectId}:dingtalk-member:add:${userId}:v1`;
}

export const OUTBOX_EVENT_DINGTALK_GROUP_CREATE = 'dingtalk.group.create';
export const OUTBOX_EVENT_DINGTALK_MEMBER_ADD = 'dingtalk.member.add';

/** CRM 任务幂等键：以 sourceAppId + crmTaskId 命名空间派生，避免不同系统任务 ID 碰撞。 */
export function crmTaskIdempotencyKey(sourceAppId: string, crmTaskId: string): string {
  const digest = createHash('sha256')
    .update(sourceAppId, 'utf8')
    .update('\0')
    .update(crmTaskId, 'utf8')
    .digest('hex');
  return `crm:${digest}`;
}

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
    const hasCrmIdentity = Boolean(
      cmd.sourceAppId
      || cmd.crmTaskId
      || cmd.contractNo
      || cmd.crmPayloadSha256
      || cmd.crmFileManifestSha256,
    );
    if (hasCrmIdentity && (!cmd.sourceAppId || !cmd.crmTaskId || !cmd.contractNo)) {
      throw new BadRequestException('CRM 工单必须同时提供 sourceAppId、crmTaskId 和 contractNo');
    }
    const crmFingerprint = hasCrmIdentity
      ? this.requireCrmFingerprint(cmd.crmPayloadSha256, cmd.crmFileManifestSha256)
      : null;
    const idempotencyKey = cmd.sourceAppId && cmd.crmTaskId
      ? crmTaskIdempotencyKey(cmd.sourceAppId, cmd.crmTaskId)
      : cmd.idempotencyKey;

    // 0. 幂等预查（P1-03）：同一 idempotencyKey 只创建一个工单
    if (idempotencyKey) {
      const existing = await this.findExistingByIdempotencyKey(idempotencyKey, cmd.creatorId);
      if (existing) {
        if (crmFingerprint) this.assertCrmReplayConsistency(existing, crmFingerprint);
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
            sourceAppId: cmd.sourceAppId ?? null,
            crmTaskId: cmd.crmTaskId ?? null,
            contractNo: cmd.contractNo ?? null,
            crmPayloadSha256: crmFingerprint?.payloadSha256 ?? null,
            crmFileManifestSha256: crmFingerprint?.fileManifestSha256 ?? null,
            crmReference: cmd.crmReference ?? null,
            idempotencyKey: idempotencyKey ?? null,
            contractTemplateSlug: cmd.contractTemplateSlug ?? null,
            extra: cmd.extra ?? Prisma.JsonNull,
          },
          include: this.projectInclude,
        });

        // 首条消息（role 由服务端派生：用户输入恒为 'user'）
        await tx.projectMessage.create({
          data: {
            projectId: p.id,
            role: 'user',
            text: cmd.input,
            ...(cmd.attachmentIds?.length ? { attachmentIds: cmd.attachmentIds } : {}),
          },
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

        // P1-11：风险分类证据（不含完整咨询正文）
        if (cmd.riskLog) {
          await tx.riskAssessmentLog.create({
            data: {
              projectId: p.id,
              finalRisk: cmd.riskLog.finalRisk,
              route: cmd.riskLog.route,
              domain: cmd.riskLog.domain ?? null,
              ruleFloor: cmd.riskLog.ruleFloor ?? null,
              matchedRuleIds: cmd.riskLog.matchedRuleIds,
              modelRisk: cmd.riskLog.modelRisk ?? null,
              modelReason: cmd.riskLog.modelReason ?? null,
              classifierVersion: cmd.riskLog.classifierVersion,
            },
          });
        }

        return p;
      });
      return { project, created: true };
    } catch (e: any) {
      // 并发撞幂等键唯一约束（P2002）→ 重新读取返回已存在工单（先校验创建者）
      if (idempotencyKey && e?.code === 'P2002') {
        const existing = await this.findExistingByIdempotencyKey(idempotencyKey, cmd.creatorId);
        if (existing) {
          if (crmFingerprint) this.assertCrmReplayConsistency(existing, crmFingerprint);
          return { project: existing, created: false };
        }
      }
      throw e;
    }
  }

  /**
   * 幂等重试的轻量预查。调用方应在任何风险模型、外部副作用或流式 AI
   * 启动之前调用，避免同一请求重试再次消耗模型额度或产生第二个任务。
   */
  async findExistingByIdempotencyKey(idempotencyKey: string, creatorId: string): Promise<any | null> {
    const existing = await this.prisma.project.findUnique({
      where: { idempotencyKey },
      include: this.projectInclude,
    });
    if (existing) this.assertCreatorConsistency(existing, creatorId);
    return existing;
  }

  private readonly projectInclude = {
    creator: { select: { id: true, username: true, displayName: true, role: true } },
    owner: { select: { id: true, username: true, displayName: true, role: true } },
  } as const;

  private requireCrmFingerprint(
    payloadSha256?: string | null,
    fileManifestSha256?: string | null,
  ): { payloadSha256: string; fileManifestSha256: string } {
    const sha256 = /^[a-f0-9]{64}$/;
    if (!payloadSha256 || !fileManifestSha256 || !sha256.test(payloadSha256) || !sha256.test(fileManifestSha256)) {
      throw new BadRequestException('CRM 工单必须提供小写十六进制的 payload/file manifest SHA-256');
    }
    return { payloadSha256, fileManifestSha256 };
  }

  private assertCrmReplayConsistency(
    project: any,
    fingerprint: { payloadSha256: string; fileManifestSha256: string },
  ): void {
    if (
      project.crmPayloadSha256 !== fingerprint.payloadSha256
      || project.crmFileManifestSha256 !== fingerprint.fileManifestSha256
    ) {
      throw new ConflictException({
        error: '同一 CRM 审核任务的请求内容与首次建单不一致',
        code: 'IDEMPOTENCY_CONFLICT',
      });
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
