import { describe, it, expect, vi } from 'vitest';
import {
  CodexExecutionQueueService,
  CodexQueueBusyError,
  CodexExecutionCancelledError,
} from '../src/common/services/codex-execution-queue.service';

/**
 * P1-02 Codex 有界并发队列单测：
 * - 全局并发上限：实际 start 峰值不超过 CODEX_CONCURRENCY
 * - 同 sessionId 严格串行（工作区互不删除）
 * - 队列满 / 排队超时 → CodexQueueBusyError，不启动 start
 * - start 抛错、取消、正常完成都释放槽位（后续任务可启动，active 归零）
 */

const makeConfig = (over: Record<string, string> = {}) => ({
  get: vi.fn((key: string, dflt?: unknown) => (key in over ? over[key] : dflt)),
});

const makeQueue = (over: Record<string, string> = {}) =>
  new CodexExecutionQueueService(makeConfig(over) as any);

/** 永不结束的 done（占用槽位） */
const hold = () => ({ result: 'hold', done: new Promise<void>(() => {}) });

describe('CodexExecutionQueueService 并发上限', () => {
  it('同时提交 CONCURRENCY+2 任务：实际 start 峰值不超过上限，释放后继续', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '4' });
    const startCalls: number[] = [];
    const holdResolvers: Array<() => void> = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      queue.run({}, () => {
        startCalls.push(i);
        return { result: i, done: new Promise<void>((r) => holdResolvers.push(r)) };
      }),
    );
    await Promise.resolve();
    expect(startCalls.length).toBe(4); // 全局上限 4，第 5/6 排队

    holdResolvers[0](); // 释放一个槽位
    await new Promise((r) => setImmediate(r));
    expect(startCalls.length).toBe(5);

    holdResolvers.slice(1).forEach((r) => r());
    await Promise.all(tasks);
    expect(startCalls.length).toBe(6);
  });

  it('不同 sessionId 可在全局额度内并行', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '4' });
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const t1 = queue.run({ sessionId: 'a' }, () => {
      started.push('a');
      return { result: 1, done: new Promise<void>((r) => releases.push(r)) };
    });
    const t2 = queue.run({ sessionId: 'b' }, () => {
      started.push('b');
      return { result: 2, done: new Promise<void>((r) => releases.push(r)) };
    });
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']); // 两个不同项目并行
    releases.forEach((r) => r());
    await Promise.all([t1, t2]);
  });

  it('同一 sessionId 的两个任务严格串行', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '4' });
    const order: number[] = [];
    let release!: () => void;
    const t1 = queue.run({ sessionId: 's1' }, () => {
      order.push(1);
      return { result: 1, done: new Promise<void>((r) => { release = r; }) };
    });
    const t2 = queue.run({ sessionId: 's1' }, () => {
      order.push(2);
      return { result: 2, done: Promise.resolve() };
    });
    await Promise.resolve();
    expect(order).toEqual([1]); // 同 session 互斥，第 2 个未启动
    release();
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
  });
});

describe('CodexExecutionQueueService 队列满/超时', () => {
  it('队列满 → 抛 CodexQueueBusyError，不启动 start', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '1', CODEX_QUEUE_MAX_SIZE: '2', CODEX_QUEUE_TIMEOUT_MS: '60000' });
    const startCalls: number[] = [];
    queue.run({}, () => { startCalls.push(1); return hold(); }); // 占用唯一槽位
    queue.run({}, () => { startCalls.push(2); return hold(); }); // 排队 1
    queue.run({}, () => { startCalls.push(3); return hold(); }); // 排队 2
    await expect(
      queue.run({}, () => { startCalls.push(4); return hold(); }),
    ).rejects.toBeInstanceOf(CodexQueueBusyError);
    expect(startCalls).toEqual([1]); // 只有第 1 个启动
  });

  it('排队超时 → 抛 CodexQueueBusyError，不启动 start', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '1', CODEX_QUEUE_TIMEOUT_MS: '60000' });
    queue.run({}, () => hold()); // 占用唯一槽位
    const p = queue.run({ queueTimeoutMs: 20 }, () => {
      throw new Error('排队超时不应启动子进程');
    });
    await expect(p).rejects.toBeInstanceOf(CodexQueueBusyError);
  });
});

describe('CodexExecutionQueueService 槽位释放', () => {
  it('start 抛错释放槽位，后续任务可启动', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '1' });
    const t1 = queue.run({}, () => {
      throw new Error('spawn 失败');
    });
    await expect(t1).rejects.toThrow('spawn 失败');
    const t2 = queue.run({}, () => ({ result: 'ok', done: Promise.resolve() }));
    await expect(t2).resolves.toBe('ok');
  });

  it('排队中取消（连接断开）→ 抛 CodexExecutionCancelledError，不启动 start', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '1' });
    queue.run({}, () => hold()); // 占用槽位
    const abort = new AbortController();
    const p = queue.run({ signal: abort.signal }, () => {
      throw new Error('取消后不应启动子进程');
    });
    abort.abort();
    await expect(p).rejects.toBeInstanceOf(CodexExecutionCancelledError);
  });

  it('取消已启动任务：done 完成后释放槽位（后续任务可启动）', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '1' });
    let release!: () => void;
    let abortRef!: AbortSignal;
    queue.run({}, (abort) => {
      abortRef = abort;
      return { result: 'running', done: new Promise<void>((r) => { release = r; }) };
    });
    await Promise.resolve();
    abortRef.dispatchEvent(new Event('abort')); // 模拟外部取消（子进程由 CodexService 侧 kill）
    release(); // 子进程 close → done 完成 → 释放槽位
    await new Promise((r) => setImmediate(r));
    const t2 = queue.run({}, () => ({ result: 'after', done: Promise.resolve() }));
    await expect(t2).resolves.toBe('after');
  });

  it('全部完成后 active/queued 归零（一次性释放，无双重释放）', async () => {
    const queue = makeQueue({ CODEX_CONCURRENCY: '2' });
    const tasks = Array.from({ length: 5 }, () =>
      queue.run({}, () => ({ result: 'ok', done: Promise.resolve() })),
    );
    await Promise.all(tasks);
    expect(queue.getStats()).toEqual({ active: 0, queued: 0, max: 2 });
  });
});
