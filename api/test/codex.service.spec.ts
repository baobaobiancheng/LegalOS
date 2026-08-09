import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Codex 安全加固单测（2026-08-09 P0-01）+ 并发队列（P1-02）：
 * - AI Kill Switch：AI_EXECUTION_ENABLED=false 时 execute 拒绝、executeStream 返回伪失败流，均不 spawn
 * - 硬化模式（CODEX_HARDENED=true）：严格参数（--strict-config / -a never / inherit=none /
 *   --ephemeral / --ignore-user-config）+ 不传 --sandbox；环境白名单；CODEX_HOME 每次调用独立子目录
 * - 本地模式（默认）：读真实 ~/.codex，无严格参数
 * - executeStream 已异步化：经共享队列获得槽位后才 spawn，测试需 await
 */

const { spawnMock } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports -- vi.hoisted 工厂不能引用顶层 import,须用 require */
  const { EventEmitter } = require('events');
  const { PassThrough } = require('stream');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter();
    (child as any).stdout = new PassThrough();
    (child as any).stderr = new PassThrough();
    (child as any).stdin = new PassThrough();
    (child as any).kill = vi.fn();
    return child;
  });
  return { spawnMock };
});

vi.mock('child_process', () => ({
  spawn: spawnMock,
  ChildProcess: class ChildProcess {},
}));

import { CodexService } from '../src/common/services/codex.service';
import { CodexExecutionQueueService } from '../src/common/services/codex-execution-queue.service';

const makeConfig = (over: Record<string, string>) => ({
  get: vi.fn((key: string, dflt?: unknown) => (key in over ? over[key] : dflt)),
});

/** 构造 CodexService（P1-02 依赖共享队列单例） */
const makeService = (config: ReturnType<typeof makeConfig>) =>
  new CodexService(config as any, new CodexExecutionQueueService(config as any) as any);

const ENV_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'DINGTALK_APP_SECRET',
  'DINGTALK_APP_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'HOME',
  'CODEX_HOME',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // 模拟服务端秘密：白名单必须把这些全部挡在 codex 子进程之外
  process.env.DATABASE_URL = 'mysql://secret';
  process.env.JWT_SECRET = 'jwt-secret';
  process.env.DINGTALK_APP_SECRET = 'dt-secret';
  process.env.DINGTALK_APP_KEY = 'dt-key';
  process.env.HOME = '/home/fakeuser';
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  spawnMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('CodexService Kill Switch', () => {
  it('AI_EXECUTION_ENABLED=false：execute 立即拒绝，不 spawn', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'false' }));
    await expect(svc.execute('你好')).rejects.toThrow('AI 执行已禁用');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('AI_EXECUTION_ENABLED=false：executeStream 返回伪失败流（close code=1），不 spawn', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'false' }));
    const stream = await svc.executeStream('你好');
    expect(spawnMock).not.toHaveBeenCalled();
    const code = await new Promise<number>((resolve) => stream.on('close', resolve));
    expect(code).toBe(1);
  });
});

describe('CodexService 硬化模式', () => {
  it('严格参数：--strict-config / -a never / inherit=none / --ephemeral / --ignore-user-config，且不传 --sandbox', async () => {
    const svc = makeService(
      makeConfig({ CODEX_HARDENED: 'true', AI_EXECUTION_ENABLED: 'true' }),
    );
    await svc.executeStream('你好');
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toEqual([
      '--strict-config',
      '-a',
      'never',
      '-c',
      'shell_environment_policy.inherit=none',
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '-',
    ]);
    expect(args).not.toContain('--sandbox');
    // 关闭伪子进程，触发工作区清理 + 槽位释放
    (spawnMock.mock.results[0].value as any).emit('close', 0);
  });

  it('环境白名单：放行 CODEX_API_KEY，拦截 DATABASE_URL/JWT_SECRET/钉钉凭证', async () => {
    process.env.CODEX_API_KEY = 'gateway-token';
    const svc = makeService(
      makeConfig({ CODEX_HARDENED: 'true', AI_EXECUTION_ENABLED: 'true' }),
    );
    await svc.executeStream('你好');
    const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.CODEX_API_KEY).toBe('gateway-token');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.DINGTALK_APP_SECRET).toBeUndefined();
    expect(env.DINGTALK_APP_KEY).toBeUndefined();
    (spawnMock.mock.results[0].value as any).emit('close', 0);
  });

  it('硬化模式 CODEX_HOME 指向本次调用独立子目录（不读真实 ~/.codex）', async () => {
    const svc = makeService(
      makeConfig({ CODEX_HARDENED: 'true', AI_EXECUTION_ENABLED: 'true' }),
    );
    await svc.executeStream('你好');
    const [, , opts] = spawnMock.mock.calls[0];
    const env = opts.env as NodeJS.ProcessEnv;
    const cwd = opts.cwd as string;
    expect(env.CODEX_HOME).toBe(join(cwd, '.codex'));
    expect(env.CODEX_HOME).not.toBe('/home/fakeuser/.codex');
    // codex 要求 CODEX_HOME 目录必须已存在（2026-08-09 实测）
    expect(existsSync(join(cwd, '.codex'))).toBe(true);
    (spawnMock.mock.results[0].value as any).emit('close', 0);
  });
});

describe('CodexService 本地模式（默认）', () => {
  it('不传严格参数，CODEX_HOME 读真实 ~/.codex（本地 auth.json/config.toml）', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true' }));
    await svc.executeStream('你好');
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toEqual(['exec', '--skip-git-repo-check', '-']);
    expect((opts.env as NodeJS.ProcessEnv).CODEX_HOME).toBe('/home/fakeuser/.codex');
    (spawnMock.mock.results[0].value as any).emit('close', 0);
  });

  it('execute 正常路径：返回 trim 后的输出，环境仍走白名单', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true' }));
    const p = svc.execute('你好');
    await new Promise((r) => setImmediate(r)); // 等队列 drain → spawn
    const child = spawnMock.mock.results[0].value;
    child.stdout.write('  答复文本  ');
    child.emit('close', 0);
    await expect(p).resolves.toBe('答复文本');
    const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });
});
