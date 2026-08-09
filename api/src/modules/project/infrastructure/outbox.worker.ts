import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { DINGTALK_ADAPTER, DingTalkAdapter } from '../adapters/adapter.interfaces';
import { OutboxRepository, OutboxClaim } from './outbox.repository';

/**
 * Outbox Worker（P1-04）：用 NestJS 生命周期管理，带租约（lease）认领任务，
 * 替换旧的 dingtalkChatId='PENDING' 哨兵。
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
  private stopped = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    config: ConfigService,
  ) {
    this.pollIntervalMs = Number(config.get('OUTBOX_POLL_INTERVAL_MS', 1000));
    this.batchSize = Number(config.get('OUTBOX_BATCH_SIZE', 10));
    this.maxAttempts = Number(config.get('OUTBOX_MAX_ATTEMPTS', 8));
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
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.logger.error(`Outbox 轮询失败：${(e as Error)?.message ?? e}`);
      }
      if (this.stopped) break;
      this.timer = setTimeout(() => void this.runLoop(), this.pollIntervalMs);
      this.timer.unref?.();
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
      await this.outbox.markFailed(event.id, claimToken, msg, attempts);
      // dead 时写入不含敏感信息的工单事件 + 告警（8.2-6）
      if (event.projectId && attempts >= this.maxAttempts) {
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
        select: { dingtalkUserId: true, displayName: true },
      }),
      project.legalBpId
        ? this.prisma.user.findUnique({
            where: { id: project.legalBpId },
            select: { dingtalkUserId: true, displayName: true },
          })
        : Promise.resolve(null),
    ]);

    const memberIds = [...new Set([creator?.dingtalkUserId, bp?.dingtalkUserId].filter(Boolean) as string[])];

    // 无法务角色成员 → 不建群，记录事件（工程评审决策 #9：单业务成员群无触达价值）
    if (!bp?.dingtalkUserId) {
      await this.addProjectEvent(projectId, `${this.fmt()} · 未匹配到已绑定钉钉的法务 BP，请人工建群`);
      this.logger.warn(`工单 ${projectId} 无法务成员，跳过建群`);
      return;
    }

    // 建群（dedupKey=legalos-${projectId} 保持：钉钉 uuid 去重，崩溃重试返回同一群）
    const group = await this.dingtalk.createGroup(
      memberIds,
      `工单#${projectId.slice(0, 6)} ${project.title}`,
      creator?.dingtalkUserId || undefined,
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
      `${this.fmt()} · 钉钉群已创建${process.env.DINGTALK_MOCK === 'true' ? '（模拟）' : ''}`,
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
        select: { legalBpId: true },
      });
      if (!project?.legalBpId) return;
      const bp = await this.prisma.user.findUnique({
        where: { id: project.legalBpId },
        select: { dingtalkUserId: true, displayName: true },
      });
      if (!bp?.dingtalkUserId || currentMembers.includes(bp.dingtalkUserId)) return;
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
