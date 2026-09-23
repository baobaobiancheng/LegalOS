import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 队列满 / 排队超时：明确"AI 服务繁忙"错误，SSE 开始前返回可识别 HTTP 错误 */
export class AiQueueBusyError extends Error {
  constructor(message = 'AI 服务繁忙，请稍后再试') {
    super(message);
    this.name = 'AiQueueBusyError';
  }
}

/** 任务在开始前被取消（HTTP/SSE 连接断开）。 */
export class AiExecutionCancelledError extends Error {
  constructor(message = 'AI 任务已取消') {
    super(message);
    this.name = 'AiExecutionCancelledError';
  }
}

export interface AiQueueRunOptions {
  /** 隔离会话 ID（如 projectId），同一会话互斥 */
  sessionId?: string;
  /** 排队超时（毫秒），默认取配置。 */
  queueTimeoutMs?: number;
  /** 调用方取消信号（连接断开等） */
  signal?: AbortSignal;
}

export interface AiTaskHandle<T> {
  /** 返回调用方的值或流句柄；不代表执行器已停止。 */
  result: T | Promise<T>;
  /** 执行器完全停止后才完成，队列持槽至此。 */
  done: Promise<void>;
}

interface QueuedTask<T> {
  id: string;
  sessionId: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  status: 'queued' | 'running' | 'cancelled';
  abort: AbortController;
  start: (signal: AbortSignal) => AiTaskHandle<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  queueTimer: NodeJS.Timeout | null;
  cleanup: () => void;
}

const MAX_TIMER_MS = 2_147_483_647;

function queueInteger(value: unknown, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = value === undefined ? fallback : Number(value);
  if ((typeof value === 'string' && !value.trim()) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

@Injectable()
export class AiExecutionQueueService {
  private readonly logger = new Logger(AiExecutionQueueService.name);
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private active = 0;
  private queue: QueuedTask<unknown>[] = [];
  private runningSessions = new Set<string>();
  private seq = 0;

  constructor(config: ConfigService) {
    const configuredNumber = (current: string, legacy: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
      queueInteger(config.get<string>(current) ?? config.get<string>(legacy), current, fallback, min, max);
    this.concurrency = configuredNumber(
      'AI_EXECUTION_CONCURRENCY', 'CODEX_CONCURRENCY', 4,
    );
    this.maxQueueSize = configuredNumber(
      'AI_EXECUTION_QUEUE_MAX_SIZE', 'CODEX_QUEUE_MAX_SIZE', 100,
    );
    this.queueTimeoutMs = configuredNumber(
      'AI_EXECUTION_QUEUE_TIMEOUT_MS', 'CODEX_QUEUE_TIMEOUT_MS', 120_000, 0, MAX_TIMER_MS,
    );
  }

  /**
   * 入队并等待全局槽位 + session 槽位，之后调用 start() 启动执行器。
   * start() 内必须同步返回 { result, done }；done 完成后释放槽位。
   */
  async run<T>(
    opts: AiQueueRunOptions,
    start: (signal: AbortSignal) => AiTaskHandle<T>,
  ): Promise<T> {
    if (opts.signal?.aborted) {
      throw new AiExecutionCancelledError();
    }
    if (this.queue.length >= this.maxQueueSize) {
      throw new AiQueueBusyError('AI 服务繁忙，排队人数已满，请稍后再试');
    }
    const timeoutMs = queueInteger(opts.queueTimeoutMs, 'queueTimeoutMs', this.queueTimeoutMs, 0, MAX_TIMER_MS);

    const task: QueuedTask<T> = {
      id: `exec-${++this.seq}`,
      sessionId: opts.sessionId ?? null,
      enqueuedAt: Date.now(),
      startedAt: null,
      status: 'queued',
      abort: new AbortController(),
      start,
      resolve: () => undefined,
      reject: () => undefined,
      queueTimer: null,
      cleanup: () => undefined,
    };

    const onAbort = () => {
      task.abort.abort();
      if (task.status !== 'queued') return;
      task.status = 'cancelled';
      task.cleanup();
      this.removeFromQueue(task);
      task.reject(new AiExecutionCancelledError());
      this.drain();
    };
    task.cleanup = () => {
      clearTimeout(task.queueTimer!);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const queueTimer = setTimeout(() => {
      if (task.status === 'queued') {
        task.status = 'cancelled';
        task.cleanup();
        this.removeFromQueue(task);
        task.reject(new AiQueueBusyError('排队超时，AI 服务繁忙，请稍后再试'));
        this.drain();
      }
    }, timeoutMs);
    queueTimer.unref?.();
    task.queueTimer = queueTimer;

    return new Promise<T>((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      this.queue.push(task);
      this.drain();
    });
  }

  private removeFromQueue(task: QueuedTask<unknown>): void {
    const idx = this.queue.indexOf(task);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  /** 从队列中取可启动任务（全局有槽 + session 空闲）并执行 */
  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const idx = this.queue.findIndex(
        (t) => t.status === 'queued' && this.canStart(t),
      );
      if (idx === -1) break;
      const task = this.queue[idx];
      this.queue.splice(idx, 1);
      task.status = 'running';
      task.startedAt = Date.now();
      this.active++;
      if (task.sessionId) this.runningSessions.add(task.sessionId);
      void this.runTask(task);
    }
  }

  private canStart(task: QueuedTask<unknown>): boolean {
    if (!task.sessionId) return true;
    return !this.runningSessions.has(task.sessionId);
  }

  private async runTask<T>(task: QueuedTask<T>): Promise<void> {
    clearTimeout(task.queueTimer!);
    const queueWaitMs = Date.now() - task.enqueuedAt;
    try {
      const { result, done } = task.start(task.abort.signal);
      // 返回值可先失败，执行器仍在收尾；两者都订阅，且 done 完成前不能释放会话锁。
      void Promise.resolve(result).then(task.resolve, task.reject);
      await done;
      const executionMs = Date.now() - (task.startedAt ?? Date.now());
      this.logger.log(
        `AI 执行完成 sessionId=${task.sessionId ?? '-'} task=${task.id} queueWaitMs=${queueWaitMs} executionMs=${executionMs} active=${this.active} queued=${this.queue.length}`,
      );
    } catch (e) {
      if (e instanceof AiExecutionCancelledError) {
        this.logger.warn(`AI 任务取消 sessionId=${task.sessionId ?? '-'} task=${task.id} queueWaitMs=${queueWaitMs}`);
      } else {
        this.logger.error(`AI 执行失败 sessionId=${task.sessionId ?? '-'} task=${task.id}：${(e as Error)?.message}`);
      }
      task.reject(e);
    } finally {
      task.cleanup();
      this.active--;
      if (task.sessionId) this.runningSessions.delete(task.sessionId);
      this.drain();
    }
  }

  getStats() {
    return { active: this.active, queued: this.queue.length, max: this.concurrency };
  }
}
