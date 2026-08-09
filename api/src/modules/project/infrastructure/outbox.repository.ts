import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxEvent } from '@prisma/client';

/**
 * Outbox 仓储（P1-04）：带租约（lease）的认领/完成/失败，全部基于原子条件更新，
 * 不做"先查再写"的并发互斥。
 *
 * - 认领：updateMany 带 `status=processing 且 claimedAt < leaseExpiry`（旧租约过期可回收）
 *   条件，原子写入随机 claimToken + claimedAt + status=processing + attempts+1。
 * - 完成/失败：updateMany 必须带 `id + claimToken` 条件，防止旧 Worker 在租约过期后
 *   返回覆盖新 Worker 的处理结果。
 */
export interface OutboxClaim {
  /** 认领前读取到的事件快照（payload 不可变，认领后直接使用） */
  event: OutboxEvent;
  claimToken: string;
}

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.leaseMs = Number(config.get('OUTBOX_LEASE_MS', 60_000));
    this.maxAttempts = Number(config.get('OUTBOX_MAX_ATTEMPTS', 8));
  }

  /** 批量认领：pending 且到可执行时间，或 processing 且租约过期（可回收） */
  async claimNext(batchSize: number): Promise<OutboxClaim[]> {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() - this.leaseMs);
    const claimCondition = {
      OR: [
        { status: 'pending' as const, availableAt: { lte: now } },
        { status: 'processing' as const, claimedAt: { lt: leaseExpiry } },
      ],
    };

    const candidates = await this.prisma.outboxEvent.findMany({
      where: claimCondition,
      orderBy: { availableAt: 'asc' },
      take: batchSize,
    });

    const claimed: OutboxClaim[] = [];
    for (const ev of candidates) {
      const claimToken = randomBytes(16).toString('hex');
      const res = await this.prisma.outboxEvent.updateMany({
        where: { id: ev.id, ...claimCondition },
        data: {
          status: 'processing',
          claimToken,
          claimedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (res.count === 1) claimed.push({ event: ev, claimToken });
    }
    if (claimed.length) {
      this.logger.log(`Outbox 认领 ${claimed.length} 个任务`);
    }
    return claimed;
  }

  /** 完成：id + claimToken 条件更新，返回是否成功（false 说明已被重新认领） */
  async markSucceeded(id: string, claimToken: string): Promise<boolean> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id, claimToken },
      data: { status: 'succeeded', completedAt: new Date(), claimToken: null, lastError: null },
    });
    if (res.count === 1) this.logger.log(`Outbox 事件 ${id} 已完成`);
    return res.count === 1;
  }

  /**
   * 失败处理：指数退避 + 随机抖动；超过最大次数进入 dead（保留 lastError）。
   * attempts 为本次认领后的尝试次数（认领时已 +1）。
   */
  async markFailed(
    id: string,
    claimToken: string,
    errorMessage: string,
    attempts: number,
  ): Promise<'pending' | 'dead'> {
    const message = String(errorMessage).slice(0, 500);
    if (attempts >= this.maxAttempts) {
      const res = await this.prisma.outboxEvent.updateMany({
        where: { id, claimToken },
        data: { status: 'dead', lastError: message, completedAt: new Date() },
      });
      if (res.count === 1) {
        this.logger.error(`Outbox 事件 ${id} 连续失败 ${attempts} 次，已进入 dead`);
      }
      return 'dead';
    }
    // 指数退避：1s → 2s → 4s … 封顶 60s，加 0~500ms 抖动
    const backoffMs = Math.min(60_000, 1000 * 2 ** (attempts - 1)) + Math.floor(Math.random() * 500);
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id, claimToken },
      data: {
        status: 'pending',
        lastError: message,
        availableAt: new Date(Date.now() + backoffMs),
      },
    });
    if (res.count === 1) {
      this.logger.warn(`Outbox 事件 ${id} 处理失败，${backoffMs}ms 后重试（${attempts}/${this.maxAttempts}）`);
    }
    return 'pending';
  }

  /** 运维统计：各状态数量 + 最近错误（管理接口，仅 admin/legal_lead） */
  async stats() {
    const [pending, processing, succeeded, dead] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'pending' } }),
      this.prisma.outboxEvent.count({ where: { status: 'processing' } }),
      this.prisma.outboxEvent.count({ where: { status: 'succeeded' } }),
      this.prisma.outboxEvent.count({ where: { status: 'dead' } }),
    ]);
    const recentErrors = await this.prisma.outboxEvent.findMany({
      where: { OR: [{ status: 'dead' }, { lastError: { not: null } }] },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        eventType: true,
        status: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
      },
    });
    return {
      counts: { pending, processing, succeeded, dead },
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
      recentErrors,
    };
  }
}
