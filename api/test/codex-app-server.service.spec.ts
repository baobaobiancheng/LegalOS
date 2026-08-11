import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import { AppServerClient } from '../src/common/services/codex-app-server.service';

/**
 * codex app-server 换行分隔 JSON 协议解析单测（2026-08-11）：
 * - 请求→响应按 id 关联（含 error）
 * - 服务端通知 → onNotification 回调（reasoning/agentMessage/turn/completed）
 * - 非 JSON 行忽略、乱序/未知 id 不悬挂
 */

function makeChild() {
  const stdout = new PassThrough();
  const stdin = { write: vi.fn() };
  return { stdout, stdin } as any;
}

function feed(child: any, line: string) {
  child.stdout.write(line + '\n');
}

describe('AppServerClient 换行分隔 JSON 协议', () => {
  let child: any;
  let onNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    child = makeChild();
    onNotification = vi.fn();
  });

  it('请求按 id 关联响应', async () => {
    const client = new AppServerClient(child, onNotification);
    const p = client.request('initialize', { clientInfo: {} });
    expect(child.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"method":"initialize"'),
    );
    feed(child, '{"id":1,"result":{"userAgent":"x"}}');
    await expect(p).resolves.toEqual({ userAgent: 'x' });
  });

  it('响应带 error → reject', async () => {
    const client = new AppServerClient(child, onNotification);
    const p = client.request('thread/start', {});
    feed(child, '{"id":1,"error":{"message":"bad"}}');
    await expect(p).rejects.toThrow('bad');
  });

  it('服务端通知 → onNotification(method, params)', async () => {
    const client = new AppServerClient(child, onNotification);
    client.request('x', {}); // 占用 id=1，避免与通知混淆
    feed(child, '{"method":"item/agentMessage/delta","params":{"threadId":"t","delta":"hi"}}');
    expect(onNotification).toHaveBeenCalledWith('item/agentMessage/delta', {
      threadId: 't',
      delta: 'hi',
    });
  });

  it('多个请求按 id 正确配对(乱序响应不串)', async () => {
    const client = new AppServerClient(child, onNotification);
    const p1 = client.request('initialize', {});
    const p2 = client.request('thread/start', {});
    // 服务端先回 thread/start(id=2) 再回 initialize(id=1)
    feed(child, '{"id":2,"result":{"thread":{"id":"T1"}}}');
    feed(child, '{"id":1,"result":{"ok":true}}');
    await expect(p1).resolves.toEqual({ ok: true });
    await expect(p2).resolves.toEqual({ thread: { id: 'T1' } });
  });

  it('非 JSON 行忽略;未知 id 不悬挂', async () => {
    const client = new AppServerClient(child, onNotification);
    const p = client.request('initialize', {});
    feed(child, 'this is a warning line');
    feed(child, '{"id":999,"result":{"stale":true}}');
    feed(child, '{"id":1,"result":{"ok":1}}');
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('同一行含多段(粘包)也能逐条解析', async () => {
    const client = new AppServerClient(child, onNotification);
    const p = client.request('initialize', {});
    child.stdout.write('{"id":1,"result":{"a":1}}\n{"method":"turn/completed","params":{"threadId":"t"}}\n');
    await expect(p).resolves.toEqual({ a: 1 });
    expect(onNotification).toHaveBeenCalledWith('turn/completed', { threadId: 't' });
  });
});
