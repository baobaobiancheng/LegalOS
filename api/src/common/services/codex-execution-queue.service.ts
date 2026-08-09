import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 有界 Codex 执行队列（P1-02）。
 *
 * execute() 与 executeStream() 共享同一个队列：
 * - 全局同时运行的 Codex 子进程不超过 CODEX_CONCURRENCY。
 * - 同一 sessionId（projectId）同时最多运行 CODEX_PROJECT_CONCURRENCY（=1）个任务，
 *   工作区按 <sessionId>/<executionId> 隔离，不会复用于并发清理。
 * - 队列满 / 排队超时 → 抛 CodexQueueBusyError（不 spawn 子进程）。
 * - 取消（外部 AbortSignal）：未启动的排队任务不 spawn；已启动任务由 start() 内的
 *   abort 监听负责 SIGTERM → 宽限期后 SIGKILL。
 * - 槽位释放只发生一次（finalize 一次性守卫），覆盖 close/error/超时/取消/spawn 抛错。
 *
 * 结构化日志字段：active、queued、queueWaitMs、executionMs、sessionId、executionId、exitCode。
 */

/** 队列满 / 排队超时：明确"AI 服务繁忙"错误，SSE 开始前返回可识别 HTTP 错误 */
export class CodexQueueBusyError extends Error {
  constructor(message = 'AI 服务繁忙，请稍后再试') {
    super(message);
    this.name = 'CodexQueueBusyError';
  }
}

/** 任务在开始前被取消（HTTP/SSE 连接断开），未启动子进程 */
export class CodexExecutionCancelledError extends Error {
  constructor(message = 'Codex 任务已取消') {
    super(message);
    this.name = 'CodexExecutionCancelledError';
  }
}

export interface CodexQueueRunOptions {
  /** 隔离会话 ID（如 projectId），同一会话互斥 */
  sessionId?: string;
  /** 排队超时（毫秒），默认取配置；排队超时不得启动子进程 */
  queueTimeoutMs?: number;
  /** 调用方取消信号（连接断开等） */
  signal?: AbortSignal;
}

export interface CodexTaskHandle<T> {
  /**
   * spawn 结果：execute() 返回 Promise<string>（await 到结果）；executeStream()
   * 返回 ChildProcess（立即拿到子进程用于 SSE）。
   */
  result: T | Promise<T>;
  /** 完成信号：子进程 close 或非流式任务执行结束时 resolve；队列持槽至 done 完成 */
  done: Promise<void>;
}

interface QueuedTask<T> {
  id: string;
  sessionId: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  status: 'queued' | 'running' | 'cancelled';
  abort: AbortController;
  start: (signal: AbortSignal) => CodexTaskHandle<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  queueTimer: NodeJS.Timeout | null;
}

const CANCEL_GRACE_MS = 5_000; // SIGTERM 后宽限期，仍未退出则 SIGKILL

@Injectable()
export class CodexExecutionQueueService {
  private readonly logger = new Logger(CodexExecutionQueueService.name);
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private readonly projectConcurrency: number;

  private active = 0;
  private queue: QueuedTask<unknown>[] = [];
  private runningSessions = new Set<string>();
  private seq = 0;

  constructor(config: ConfigService) {
    this.concurrency = Math.max(1, Number(config.get('CODEX_CONCURRENCY', 4)));
    this.maxQueueSize = Math.max(1, Number(config.get('CODEX_QUEUE_MAX_SIZE', 100)));
    this.queueTimeoutMs = Math.max(0, Number(config.get('CODEX_QUEUE_TIMEOUT_MS', 120_000)));
    this.projectConcurrency = Math.max(1, Number(config.get('CODEX_PROJECT_CONCURRENCY', 1)));
  }

  /**
   * 入队并等待全局槽位 + session 槽位，之后调用 start() 真正 spawn。
   * start() 内必须同步返回 { result, done }；done 完成后释放槽位。
   */
  async run<T>(
    opts: CodexQueueRunOptions,
    start: (signal: AbortSignal) => CodexTaskHandle<T>,
  ): Promise<T> {
    if (opts.signal?.aborted) {
      throw new CodexExecutionCancelledError();
    }
    if (this.queue.length >= this.maxQueueSize) {
      throw new CodexQueueBusyError('AI 服务繁忙，排队人数已满，请稍后再试');
    }

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
    };

    // 外部取消信号 → 任务内部 abort
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => task.abort.abort(), { once: true });
    }

    // 排队超时：不得启动子进程
    const queueTimer = setTimeout(() => {
      if (task.status === 'queued') {
        task.status = 'cancelled';
        clearTimeout(task.queueTimer!);
        this.removeFromQueue(task);
        task.reject(new CodexQueueBusyError('排队超时，AI 服务繁忙，请稍后再试'));
        this.drain();
      }
    }, opts.queueTimeoutMs ?? this.queueTimeoutMs);
    queueTimer.unref?.();
    task.queueTimer = queueTimer;

    // 排队中取消（连接断开）：移除并拒绝，不 spawn
    task.abort.signal.addEventListener(
      'abort',
      () => {
        if (task.status === 'queued') {
          task.status = 'cancelled';
          clearTimeout(task.queueTimer!);
          this.removeFromQueue(task);
          task.reject(new CodexExecutionCancelledError());
          this.drain();
        }
      },
      { once: true },
    );

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
    let finalized = false;
    // 一次性 finalize：防止 error 与 close 双重释放槽位
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      this.active--;
      if (task.sessionId) this.runningSessions.delete(task.sessionId);
      this.drain();
    };

    const queueWaitMs = Date.now() - task.enqueuedAt;
    try {
      const { result, done } = task.start(task.abort.signal);
      const resolved = await result;
      task.resolve(resolved);
      await done; // 持槽直至子进程 close / 非流式任务结束
      const executionMs = Date.now() - (task.startedAt ?? Date.now());
      this.logger.log(
        `Codex 执行完成 sessionId=${task.sessionId ?? '-'} task=${task.id} queueWaitMs=${queueWaitMs} executionMs=${executionMs} active=${this.active} queued=${this.queue.length}`,
      );
    } catch (e) {
      if (e instanceof CodexExecutionCancelledError) {
        this.logger.warn(`Codex 任务取消 sessionId=${task.sessionId ?? '-'} task=${task.id} queueWaitMs=${queueWaitMs}`);
      } else {
        this.logger.error(`Codex 执行失败 sessionId=${task.sessionId ?? '-'} task=${task.id}：${(e as Error)?.message}`);
      }
      task.reject(e);
    } finally {
      finalize();
    }
  }

  getStats() {
    return { active: this.active, queued: this.queue.length, max: this.concurrency };
  }
}

/** SIGTERM 宽限期后仍未退出的进程由调用方（CodexService spawnStreamChild）发 SIGKILL */
export const CODEX_CANCEL_GRACE_MS = CANCEL_GRACE_MS;
