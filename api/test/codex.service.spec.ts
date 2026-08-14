import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync, writeFileSync } from 'fs';

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

  it('execute 超时：先终止并等待 close，不提前释放队列槽位', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true' }));
    const promise = svc.execute('超时测试', { timeout: 10 });
    await new Promise((r) => setTimeout(r, 30));

    const child = spawnMock.mock.results[0].value as any;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // 非流式调用在 close 前不能 reject，否则同 session 的下一任务会提前启动。
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    child.emit('close', null);
    await expect(promise).rejects.toThrow('timed out');
  });

  it('流结束后同时回收 execution 目录和空 session 父目录', async () => {
    const workspace = join(process.cwd(), '.tmp', `codex-parent-cleanup-${Date.now()}`);
    const svc = makeService(makeConfig({
      AI_EXECUTION_ENABLED: 'true',
      CODEX_WORKSPACE: workspace,
    }));

    const stream = await svc.executeStream('目录回收测试', { sessionId: 'session-cleanup' });
    (stream as any).emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(existsSync(join(workspace, 'session-cleanup'))).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe('CodexService AgentExecutionHandle', () => {
  const agentOptions = {
    sessionId: 'agent-session',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    },
    validateFinal: (value: unknown) => {
      if (!value || typeof value !== 'object' || typeof (value as any).answer !== 'string') {
        throw new Error('answer missing');
      }
      return value as { answer: string };
    },
    mcp: {
      serverName: 'baijian' as const,
      url: 'https://mcpgateway.example.test/mcp',
      enabledTool: 'lawstar_data_professional_query',
      required: true,
      envHttpHeaders: {
        'X-App-Key': 'BAIJIAN_MCP_APP_KEY',
        'X-App-Secret': 'BAIJIAN_MCP_APP_SECRET',
      },
      environment: {
        BAIJIAN_MCP_APP_KEY: 'test-key',
        BAIJIAN_MCP_APP_SECRET: 'test-secret',
      },
    },
  };

  it('在清理工作区前解析 JSONL、工具结果和最终结果，命令行不含 Secret', async () => {
    const workspace = join(process.cwd(), '.tmp', `codex-agent-${Date.now()}`);
    const svc = makeService(makeConfig({
      AI_EXECUTION_ENABLED: 'true',
      CODEX_HARDENED: 'true',
      CODEX_WORKSPACE: workspace,
    }));
    const handle = await svc.executeAgent('请检索', agentOptions);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('--json');
    expect(args).toContain('--output-schema');
    expect(args).toContain('--output-last-message');
    expect(args.join(' ')).toContain('enabled_tools=["lawstar_data_professional_query"]');
    expect(args.join(' ')).toContain('required=true');
    expect(args.join(' ')).not.toContain('test-secret');
    expect((opts.env as NodeJS.ProcessEnv).BAIJIAN_MCP_APP_SECRET).toBe('test-secret');

    const resultPath = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(resultPath, JSON.stringify({ answer: '检索结论' }));
    const child = spawnMock.mock.results[0].value as any;
    const toolEvent = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'baijian',
        tool: 'lawstar_data_professional_query',
        result: { content: [{ type: 'text', text: '{"code":"200"}' }] },
      },
    });
    child.stdout.write(`${toolEvent}\n${toolEvent}\n`); // duplicate id must be ignored
    child.emit('close', 0);

    await expect(handle.completion).resolves.toMatchObject({
      final: { answer: '检索结论' },
      exitCode: 0,
      events: [{ id: 'tool-1', type: 'item.completed' }],
      toolResults: [{ callId: 'tool-1', toolName: 'lawstar_data_professional_query', isError: false }],
    });
    expect(existsSync(opts.cwd)).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  it('保留同一 item ID 的 started/completed 生命周期，只忽略重复 completed', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true', CODEX_HARDENED: 'true' }));
    const handle = await svc.executeAgent('请检索', agentOptions);
    const [, args] = spawnMock.mock.calls[0];
    const resultPath = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(resultPath, JSON.stringify({ answer: '检索结论' }));
    const child = spawnMock.mock.results[0].value as any;
    const started = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'tool-lifecycle-1',
        type: 'mcp_tool_call',
        server: 'baijian',
        tool: 'lawstar_data_professional_query',
      },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'tool-lifecycle-1',
        type: 'mcp_tool_call',
        server: 'baijian',
        tool: 'lawstar_data_professional_query',
        result: { content: [{ type: 'text', text: '{"code":"200"}' }] },
      },
    });
    child.stdout.write(`${started}\n${completed}\n${completed}\n`);
    child.emit('close', 0);

    await expect(handle.completion).resolves.toMatchObject({
      events: [
        { id: 'tool-lifecycle-1', type: 'item.started' },
        { id: 'tool-lifecycle-1', type: 'item.completed' },
      ],
      toolResults: [{ callId: 'tool-lifecycle-1', toolName: 'lawstar_data_professional_query' }],
    });
  });

  it('保留 result=null 但含 error 的 MCP 失败结果', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true', CODEX_HARDENED: 'true' }));
    const handle = await svc.executeAgent('请检索', agentOptions);
    const [, args] = spawnMock.mock.calls[0];
    const resultPath = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(resultPath, JSON.stringify({ answer: '检索失败' }));
    const child = spawnMock.mock.results[0].value as any;
    child.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'tool-error-1',
        type: 'mcp_tool_call',
        server: 'baijian',
        tool: 'lawstar_data_professional_query',
        result: null,
        error: { code: 401, message: 'unauthorized' },
      },
    })}\n`);
    child.emit('close', 0);

    await expect(handle.completion).resolves.toMatchObject({
      toolResults: [{
        callId: 'tool-error-1',
        toolName: 'lawstar_data_professional_query',
        isError: true,
        result: { code: 401, message: 'unauthorized' },
      }],
    });
  });

  it('坏 JSONL 终止进程并返回 AGENT_BAD_JSONL', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true', CODEX_HARDENED: 'true' }));
    const handle = await svc.executeAgent('坏行测试', agentOptions);
    const child = spawnMock.mock.results[0].value as any;
    child.stdout.write('{bad json}\n');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);
    await expect(handle.completion).rejects.toMatchObject({ code: 'AGENT_BAD_JSONL' });
  });

  it('JSONL 单行超限时终止进程并返回 AGENT_OUTPUT_LIMIT', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true', CODEX_HARDENED: 'true' }));
    const handle = await svc.executeAgent('超限测试', {
      ...agentOptions,
      limits: { jsonlLineBytes: 32 },
    });
    const rejected = expect(handle.completion).rejects.toMatchObject({ code: 'AGENT_OUTPUT_LIMIT' });
    const child = spawnMock.mock.results[0].value as any;
    child.stdout.write(`${JSON.stringify({ type: 'item.completed', payload: 'x'.repeat(64) })}\n`);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);
    await rejected;
  });

  it('结果文件缺失时失败，不能把 stdout 当权威最终答案', async () => {
    const svc = makeService(makeConfig({ AI_EXECUTION_ENABLED: 'true', CODEX_HARDENED: 'true' }));
    const handle = await svc.executeAgent('缺结果测试', agentOptions);
    const child = spawnMock.mock.results[0].value as any;
    child.stdout.write('{"type":"turn.completed"}\n');
    child.emit('close', 0);
    await expect(handle.completion).rejects.toMatchObject({ code: 'AGENT_RESULT_MISSING' });
  });
});
