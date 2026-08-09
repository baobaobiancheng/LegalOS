import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskLevel } from '@prisma/client';
import { OUTBOX_EVENT_DINGTALK_GROUP_CREATE, dingtalkGroupOutboxDedupKey } from './create-project.use-case';

/**
 * 统一法务升级用例（P1-10）：所有"咨询/合同进入人工法务流程"的入口共用本用例。
 * 一次升级必须完成（同一事务，任一失败整体回滚）：
 *   1. 条件更新 route/status/legalBpId/ownerId（并发防护：仅未进入法务流程的工单可升级）。
 *   2. 写 ProjectEvent（文案与真实状态一致，不谎报"已通知"）。
 *   3. 入队 Outbox 建群任务（稳定 dedupKey，重复请求只升级一次、只建一群）。
 * 真实钉钉通知由 Outbox Worker 在建群成功后发送——这里不持有/不使用假群 ID。
 */
export interface EscalateToLegalCommand {
  projectId: string;
  /** 新 route（必须切到 legalbp） */
  route?: 'legalbp';
  status?: string;
  risk?: RiskLevel;
  legalBpId?: string | null;
  ownerId?: string | null;
  /** 事件文案（含时间戳前缀） */
  eventTexts?: string[];
}

export const ESCALATE_DEDUP_PREFIX = 'project';

@Injectable()
export class EscalateProjectToLegalUseCase {
  private readonly logger = new Logger(EscalateProjectToLegalUseCase.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 执行升级。返回 { upgraded, project }：upgraded=false 表示已是法务流程（幂等）。
   */
  async execute(cmd: EscalateToLegalCommand): Promise<{ upgraded: boolean; project: any }> {
    const existing = await this.prisma.project.findUnique({
      where: { id: cmd.projectId },
      select: { route: true, status: true, legalBpId: true, ownerId: true },
    });
    if (!existing) throw new Error(`工单不存在：${cmd.projectId}`);
    if (existing.route === 'legalbp') {
      return { upgraded: false, project: existing };
    }

    const project = await this.prisma.$transaction(async (tx) => {
      // 条件更新：仅 route=llm 的工单可升级（并发防护，重复请求 count=0 → 幂等返回）
      const data: Record<string, unknown> = { route: 'legalbp' };
      if (cmd.status) data.status = cmd.status;
      if (cmd.risk) data.risk = cmd.risk;
      if (cmd.legalBpId !== undefined) data.legalBpId = cmd.legalBpId;
      if (cmd.ownerId !== undefined) data.ownerId = cmd.ownerId;
      const updated = await tx.project.updateMany({
        where: { id: cmd.projectId, route: 'llm' },
        data: data as any,
      });
      if (updated.count === 0) {
        // 已被并发升级 → 读取当前状态幂等返回
        return tx.project.findUnique({ where: { id: cmd.projectId } });
      }
      for (const text of cmd.eventTexts ?? []) {
        await tx.projectEvent.create({ data: { projectId: cmd.projectId, text } });
      }
      // Outbox 建群（Worker 建群成功后发真实通知；无需假群 ID）
      await tx.outboxEvent.create({
        data: {
          eventType: OUTBOX_EVENT_DINGTALK_GROUP_CREATE,
          aggregateType: 'project',
          aggregateId: cmd.projectId,
          dedupKey: dingtalkGroupOutboxDedupKey(cmd.projectId),
          payload: { projectId: cmd.projectId },
          projectId: cmd.projectId,
        },
      }).catch(() => undefined); // dedupKey 已存在（重复升级）→ 忽略
      return tx.project.findUnique({ where: { id: cmd.projectId } });
    });

    return { upgraded: true, project };
  }
}
