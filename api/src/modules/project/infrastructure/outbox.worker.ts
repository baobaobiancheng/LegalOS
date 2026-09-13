import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CRM_ADAPTER,
  CrmAdapter,
  DINGTALK_ADAPTER,
  DingTalkAdapter,
} from '../adapters/adapter.interfaces';
import { OutboxRepository, OutboxClaim } from './outbox.repository';
import { OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER } from '../application/crm-delivery';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Outbox Worker（P1-04）：用 NestJS 生命周期管理，带租约（lease）认领钉钉和 CRM 外部副作用，
 * 替换旧的 dingtalkChatId='PENDING' 哨兵，并保证 CRM 成功回执前不标记已送达。
 *
 * - 认领：条件更新（pending 到可执行时间 / processing 租约过期），原子写入 claimToken。
 * - 完成/失败：id + claimToken 条件更新，防止旧 Worker 覆盖重新认领的任务。
 * - 崩溃恢复：Worker 在"钉钉成功、数据库未标记成功"之间崩溃 → 重试时 dingtalk 的
 *   uuid=legalos-${projectId} 去重返回同一群，不产生第二个群。
 * - 幂等：执行建群前重读 Project；已有真实 dingtalkChatId → succeeded；已取消 → skipped；
 *   legalBpId 变化 → 用最新指派关系生成成员。
 * - 优雅停机：停止拉取新任务，等待当前任务到宽限期，未完成依赖租约恢复。
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly dingtalkMock: boolean;
  private readonly contractStorageDir: string;
  private stopped = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    config: ConfigService,
  ) {
    this.pollIntervalMs = Number(config.get('OUTBOX_POLL_INTERVAL_MS', 1000));
    this.batchSize = Number(config.get('OUTBOX_BATCH_SIZE', 10));
    this.maxAttempts = Number(config.get('OUTBOX_MAX_ATTEMPTS', 8));
    this.dingtalkMock = config.get('DINGTALK_MOCK', 'false') === 'true';
    this.contractStorageDir = config.get<string>('CONTRACT_STORAGE_DIR')
      || join(process.cwd(), 'storage', 'contracts');
  }

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(`Outbox Worker 启动（poll=${this.pollIntervalMs}ms batch=${this.batchSize}）`);
    void this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // 等待当前轮询完成（宽限期；未完成任务依赖租约恢复）
    const deadline = Date.now() + 10_000;
    while (this.polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.logger.log('Outbox Worker 已停止');
  }

  private async runLoop(): Promise<void> {
    // 修复 2026-08-09 P0：原实现 while+递归 setTimeout 双循环,每秒派生新 runLoop → 指数增长 → V8 OOM。
    // 改为单循环 + 间隔等待(每次 poll 一次,等 pollIntervalMs 再下一轮),无递归、无并发派生。
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.logger.error(`Outbox 轮询失败：${(e as Error)?.message ?? e}`);
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** 单次轮询：认领一批 → 逐个处理 → 完成/失败（claimToken 守卫） */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const claims = await this.outbox.claimNext(this.batchSize);
      for (const claim of claims) {
        if (this.stopped) break;
        await this.claimAndProcess(claim);
      }
    } finally {
      this.polling = false;
    }
  }

  private async claimAndProcess(claim: OutboxClaim): Promise<void> {
    const { event, claimToken } = claim;
    const attempts = event.attempts + 1;
    try {
      await this.process(event);
      await this.outbox.markSucceeded(event.id, claimToken);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const nextStatus = await this.outbox.markFailed(event.id, claimToken, msg, attempts);
      if (nextStatus && event.eventType === OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER && event.projectId) {
        await this.prisma.project.updateMany({
          where: { id: event.projectId, crmDeliveryStatus: { not: 'delivered' } },
          data: {
            crmDeliveryStatus: nextStatus === 'dead' ? 'dead' : 'failed',
            crmDeliveryUpdatedAt: new Date(),
            crmDeliveryLastError: msg.slice(0, 1000),
          },
        }).catch(() => undefined);
      }
      // dead 时写入不含敏感信息的工单事件 + 告警（8.2-6）
      if (event.projectId && nextStatus === 'dead') {
        await this.prisma.projectEvent
          .create({
            data: {
              projectId: event.projectId,
              text: `⚠️ 后台任务（${event.eventType}）连续失败已停止重试，请人工处理`,
            },
          })
          .catch(() => undefined);
      }
    }
  }

  private async process(event: any): Promise<void> {
    switch (event.eventType) {
      case 'dingtalk.group.create':
        return this.handleDingtalkGroupCreate(event);
      case 'dingtalk.member.add':
        return this.handleDingtalkMemberAdd(event);
      case OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER:
        return this.handleCrmReviewResultDeliver(event);
      default:
        throw new Error(`未知 Outbox 事件类型：${event.eventType}`);
    }
  }

  /**
   * 钉钉建群：执行前重读 Project（8.2-7）：
   * - 已有真实 dingtalkChatId → 直接 succeeded（不再建群）
   * - 工单已取消 → skipped（按 succeeded 处理，不再建群）
   * - legalBpId 已变化 → 用最新指派关系生成成员
   * - 无法务成员 → 记录事件请人工建群，标记 succeeded（不重试）
   * dedupKey 保持 `legalos-${projectId}`（钉钉 uuid 去重，崩溃重试返回同一群）。
   */
  private async handleDingtalkGroupCreate(event: any): Promise<void> {
    const { projectId } = event.payload as { projectId?: string };
    if (!projectId) throw new Error('payload 缺少 projectId');

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return; // 工单已删除 → 无事可做，标记 succeeded
    if (project.dingtalkChatId) return; // 已有真实群
    if (project.status === '已取消') return; // 已取消 → skip

    const [creator, bp] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: project.creatorId },
        select: { dingtalkUserId: true, displayName: true, isActive: true },
      }),
      project.legalBpId
        ? this.prisma.user.findUnique({
            where: { id: project.legalBpId },
            select: { dingtalkUserId: true, displayName: true, isActive: true, role: true },
          })
        : Promise.resolve(null),
    ]);

    // 无法务角色成员 → 不建群，记录事件（工程评审决策 #9：单业务成员群无触达价值）
    if (!bp?.dingtalkUserId || !isActiveLegalMember(bp)) {
      await this.addProjectEvent(projectId, `${this.fmt()} · 未匹配到已绑定钉钉的法务 BP，请人工建群`);
      this.logger.warn(`工单 ${projectId} 无法务成员，跳过建群`);
      return;
    }

    const creatorDingtalkId = creator?.isActive ? creator.dingtalkUserId : null;
    const memberIds = [...new Set([creatorDingtalkId, bp.dingtalkUserId].filter(Boolean) as string[])];

    // 建群（dedupKey=legalos-${projectId} 保持：钉钉 uuid 去重，崩溃重试返回同一群）
    const group = await this.dingtalk.createGroup(
      memberIds,
      `工单#${projectId.slice(0, 6)} ${project.title}`,
      creatorDingtalkId || bp.dingtalkUserId,
      `legalos-${projectId}`,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { dingtalkChatId: group.chatId, dingtalkMembers: JSON.stringify(group.members) },
    });

    // 成员 reconciliation：建群在途期间 legalBpId 可能已被转派修改（对抗性评审 #8）
    await this.reconcileMembers(projectId, group.chatId, group.members);

    await this.addProjectEvent(
      projectId,
      `${this.fmt()} · 钉钉群已创建${this.dingtalkMock ? '（模拟）' : ''}`,
    );

    // 首条消息（纯文字：工单标题 + 风险 + 提出人）
    try {
      const requester = project.requesterName || creator?.displayName || '业务人员';
      await this.dingtalk.sendNotification(
        group.chatId,
        `【法律咨询工单】${project.title}\n风险等级：${project.risk}\n提出人：${requester}`,
      );
    } catch (e) {
      this.logger.warn(`首条消息发送失败（${projectId}）：${e}`);
      await this.addProjectEvent(
        projectId,
        `${this.fmt()} · 群已创建但首条消息发送失败，请检查机器人配置`,
      );
    }
  }

  /** 成员 reconciliation：对照工单当前 legalBpId 补拉缺员（建群在途被转派场景） */
  private async reconcileMembers(projectId: string, chatId: string, currentMembers: string[]) {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { legalBpId: true, status: true },
      });
      if (!project?.legalBpId || project.status === '已取消') return;
      const bp = await this.prisma.user.findUnique({
        where: { id: project.legalBpId },
        select: { dingtalkUserId: true, displayName: true, isActive: true, role: true },
      });
      if (!bp?.dingtalkUserId || !isActiveLegalMember(bp) || currentMembers.includes(bp.dingtalkUserId)) return;
      await this.dingtalk.addMember(chatId, bp.dingtalkUserId);
      const members = [...currentMembers, bp.dingtalkUserId];
      await this.prisma.project.update({
        where: { id: projectId },
        data: { dingtalkMembers: JSON.stringify(members) },
      });
      this.logger.log(`reconciliation：${bp.displayName} 已补拉入群（${projectId}）`);
    } catch (e) {
      this.logger.warn(`成员 reconciliation 失败（${projectId}）：${e}`);
    }
  }

  /**
   * 给已有群补拉新 BP。事件执行前重读工单和用户，避免使用请求时的过期指派；
   * 没有群时抛错让建群/重试先完成，未绑定钉钉时记录人工处理事件并消费掉任务。
   */
  private async handleDingtalkMemberAdd(event: any): Promise<void> {
    const { projectId, userId } = event.payload as { projectId?: string; userId?: string };
    if (!projectId || !userId) throw new Error('payload 缺少 projectId/userId');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { dingtalkChatId: true, dingtalkMembers: true, status: true, legalBpId: true },
    });
    if (!project || project.status === '已取消' || project.legalBpId !== userId) return;
    if (!project.dingtalkChatId) throw new Error('钉钉群尚未创建，等待建群任务完成');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dingtalkUserId: true, displayName: true, isActive: true, role: true },
    });
    if (!user || !isActiveLegalMember(user)) return;
    if (!user.dingtalkUserId) {
      await this.addProjectEvent(
        projectId,
        `${this.fmt()} · ${user?.displayName || '新法务 BP'} 未绑定钉钉，无法加入群`,
      );
      return;
    }

    const members = this.parseMembers(project.dingtalkMembers);
    if (members.includes(user.dingtalkUserId)) return;

    await this.dingtalk.addMember(project.dingtalkChatId, user.dingtalkUserId);

    // 带旧快照条件，避免多个 Worker 并发补人时后写覆盖先写；冲突交给 Outbox 重试。
    const nextMembers = [...members, user.dingtalkUserId];
    const updated = await this.prisma.project.updateMany({
      where: { id: projectId, dingtalkMembers: project.dingtalkMembers },
      data: { dingtalkMembers: JSON.stringify(nextMembers) },
    });
    if (updated.count === 0) throw new Error('钉钉群成员快照发生并发变化，请重试');

    await this.addProjectEvent(
      projectId,
      `${this.fmt()} · ${user.displayName} 已加入钉钉群${this.dingtalkMock ? '（模拟）' : ''}`,
    );
  }

  /**
   * CRM 交付：事件只携带内部 ID，消费时重读权威任务、结论与文件。
   * 只有适配器收到 CRM 成功回执后才标记 delivered；失败由 Outbox 重试/死信接管。
   */
  private async handleCrmReviewResultDeliver(event: any): Promise<void> {
    const { projectId, contractFileId } = event.payload as {
      projectId?: string;
      contractFileId?: string;
    };
    if (!projectId || !contractFileId) throw new Error('payload 缺少 projectId/contractFileId');

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    if (project.crmDeliveryStatus === 'delivered') return;
    if (!project.sourceAppId || !project.crmTaskId || !project.reviewCompletedAt || !project.result) {
      throw new Error('CRM 交付缺少任务标识或审核结果');
    }
    if (project.crmDeliveryFileId !== contractFileId) {
      throw new Error('CRM 交付文件与法务确认版本不一致');
    }

    const file = await this.prisma.contractFile.findFirst({
      where: { id: contractFileId, projectId },
      include: { uploader: { select: { role: true } } },
    });
    if (!file) throw new Error('CRM 交付文件不存在');
    if (!['legal_bp', 'legal_lead', 'admin'].includes(file.uploader.role)) {
      throw new Error('CRM 交付文件未经法务角色确认');
    }
    const filePath = join(this.contractStorageDir, projectId, file.storedName);
    if (!existsSync(filePath)) throw new Error('CRM 交付文件已丢失');

    const claimed = await this.prisma.project.updateMany({
      where: { id: projectId, crmDeliveryStatus: { not: 'delivered' } },
      data: {
        crmDeliveryStatus: 'sending',
        crmDeliveryUpdatedAt: new Date(),
        crmDeliveryLastError: null,
      },
    });
    if (claimed.count === 0) return;

    await this.crm.writeBack({
      sourceAppId: project.sourceAppId,
      crmTaskId: project.crmTaskId,
      contractNo: project.contractNo ?? project.crmReference,
      projectId,
      conclusion: project.result,
      reviewCompletedAt: project.reviewCompletedAt.toISOString(),
      file: {
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        path: filePath,
      },
    });

    await this.prisma.project.updateMany({
      where: { id: projectId },
      data: {
        crmDeliveryStatus: 'delivered',
        crmDeliveryUpdatedAt: new Date(),
        crmDeliveredAt: new Date(),
        crmDeliveryLastError: null,
      },
    });
    await this.addProjectEvent(projectId, `${this.fmt()} · CRM 审核结果已送达`);
  }

  private parseMembers(value: string | null): string[] {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private async addProjectEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({ data: { projectId, text } });
  }

  private fmt(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

function isActiveLegalMember(user: { isActive: boolean; role: string }): boolean {
  return user.isActive && (user.role === 'legal_bp' || user.role === 'legal_lead');
}
