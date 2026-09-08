import { describe, it, expect, vi, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { RealCasAdapter } from '../src/modules/auth/adapters/real-cas.adapter';
import { CasAuthErrorType } from '../src/modules/auth/adapters/cas-adapter.interface';

/**
 * RealCasAdapter 方式一登录解析（2026-08-11 实测锁定的协议）：
 * - 密码需 MD5 摘要发送
 * - 成功 code=0（不是 200），ticket 在 result.ticket（不是 data）
 * - validate 返回 status='success'
 */

const config = (over: Record<string, string> = {}) => ({
  get: (k: string) => ({ CAS_HOST: 'https://cas-pre.100credit.cn', CAS_PROJECT_CODE: 'legalos', CAS_REDIRECT_URL: 'http://x/login', ...over })[k] ?? undefined,
});

describe('RealCasAdapter.loginWithPassword', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

  it('密码 MD5 化发送 + 解析 code=0/result.ticket', async () => {
    let sentBody = '';
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/login')) {
        sentBody = (init?.body as URLSearchParams).toString();
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, result: { ticket: 'ticket-abc', username: 'zhenghe.bao' } }) } as unknown as Response;
      }
      // validate 响应
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', username: 'zhenghe.bao', name: '包正和', deptName: '研发部' }) } as unknown as Response;
    });

    const adapter = new RealCasAdapter(config() as any);
    const info = await adapter.loginWithPassword('zhenghe.bao', '123456');

    const md5 = crypto.createHash('md5').update('123456').digest('hex');
    expect(sentBody).toContain(`password=${md5}`); // 明文 123456 不应出现
    expect(sentBody).not.toContain('password=123456');
    expect(info.username).toBe('zhenghe.bao');
    expect(info.deptName).toBe('研发部');
  });

  it('code!=0（密码错）→ INVALID_CREDENTIALS', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1002, message: '账号密码错误' }) } as unknown as Response));
    const adapter = new RealCasAdapter(config() as any);
    await expect(adapter.loginWithPassword('x', 'y')).rejects.toMatchObject({
      type: CasAuthErrorType.INVALID_CREDENTIALS,
    });
  });

  it('code=0 但无 ticket（未开通项目权限）→ INVALID_CREDENTIALS', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, result: { username: 'yuxin.peng', projectCodeList: [] } }) } as unknown as Response));
    const adapter = new RealCasAdapter(config() as any);
    await expect(adapter.loginWithPassword('yuxin.peng', '123456')).rejects.toMatchObject({
      type: CasAuthErrorType.INVALID_CREDENTIALS,
    });
  });

  it('validate 调试日志不包含原始或 URL 编码后的 ticket', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success', username: 'safe.user', name: 'Safe' }),
    }) as unknown as Response);
    const adapter = new RealCasAdapter(config() as any);
    const debug = vi.fn();
    (adapter as any).logger = { debug };
    const ticket = 'ST secret+/?&password';

    await adapter.validateTicket(ticket);

    const logged = String(debug.mock.calls[0][0]);
    expect(logged).not.toContain(ticket);
    expect(logged).not.toContain(encodeURIComponent(ticket));
    expect(logged).not.toContain('secret');
  });

  it('密码登录日志不包含用户名、密码或摘要', async () => {
    globalThis.fetch = vi.fn(async (url: string) => url.includes('/api/login')
      ? ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, result: { ticket: 'safe-ticket' } }) } as unknown as Response)
      : ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', username: 'safe.user', name: 'Safe' }) } as unknown as Response));
    const adapter = new RealCasAdapter(config() as any);
    const debug = vi.fn();
    (adapter as any).logger = { debug };

    await adapter.loginWithPassword('secret.user', 'SecretPass123!');

    const logs = debug.mock.calls.flat().join(' ');
    expect(logs).not.toContain('secret.user');
    expect(logs).not.toContain('SecretPass123!');
    expect(logs).not.toContain(crypto.createHash('md5').update('SecretPass123!').digest('hex'));
    expect(logs).not.toContain('safe-ticket');
  });
});
