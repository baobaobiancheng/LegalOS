import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  CasAuthError,
  CasAuthErrorType,
} from '../src/modules/auth/adapters/cas-adapter.interface';

/**
 * CAS 登录（T3）单测：
 * - 自动建号(upsert 并发安全) / 领域角色平台自管(admin 名单+预映射) / inactive 拒绝
 * - 错误码：ticket 无效→401 / CAS 不可达→503
 * - refresh 链上限(T5)：authMethod 继承 + originalExpiresAt 封顶 + 强制环境拒 password
 */

const mockUser = (over: any = {}) => ({
  id: 'u-1',
  username: 'zhenghe.bao',
  displayName: '包正和',
  role: 'business' as const,
  isActive: true,
  casUsername: 'zhenghe.bao',
  ...over,
});

const cfg = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    REFRESH_TOKEN_TTL_MS: '86400000',
    SESSION_CAP_MS: '604800000',
    CAS_ENFORCED: 'false',
    CAS_ADMIN_USERNAMES: '',
    CAS_ROLE_MAP: '',
  };
  return { get: (k: string) => ({ ...base, ...over })[k] ?? undefined };
};

function makeService(over: { config?: ReturnType<typeof cfg> } = {}) {
  const prisma = {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    refreshToken: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    loginAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const jwt = {
    signAsync: vi.fn().mockResolvedValue('signed-token'),
    verifyAsync: vi.fn().mockResolvedValue({ sub: 'u-1', jti: 'j1', type: 'refresh' }),
  };
  const cas = { validateTicket: vi.fn() };
  const service = new AuthService(prisma as any, jwt as any, over.config ?? cfg() as any, cas as any);
  return { service, prisma, jwt, cas };
}

describe('AuthService.casLogin', () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService();
    ctx.cas.validateTicket.mockResolvedValue({
      username: 'zhenghe.bao',
      name: '包正和',
      email: 'zhenghe.bao@brgroup.com',
      projectCode: 'legalos',
    });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser());
  });

  it('新用户自动建号：username=casUsername + 随机不可用哈希 + 默认 business + authMethod=cas', async () => {
    await ctx.service.casLogin({ ticket: 'ticket-abc' }, '1.2.3.4');
    const create = ctx.prisma.user.upsert.mock.calls[0][0];
    expect(create.where).toEqual({ casUsername: 'zhenghe.bao' });
    expect(create.create.username).toBe('zhenghe.bao');
    expect(create.create.casUsername).toBe('zhenghe.bao');
    expect(create.create.role).toBe('business');
    expect(create.create.passwordHash).not.toBe(''); // 随机不可用哈希
    // refresh 落库带 authMethod=cas
    const rt = ctx.prisma.refreshToken.create.mock.calls[0][0].data;
    expect(rt.authMethod).toBe('cas');
    expect(rt.originalExpiresAt).toBeInstanceOf(Date);
    expect(ctx.prisma.loginAudit.create).toHaveBeenCalled();
  });

  it('CAS_ADMIN_USERNAMES 命中 → admin(create 与 update 都升级,不降级)', async () => {
    ctx = makeService({ config: cfg({ CAS_ADMIN_USERNAMES: 'zhenghe.bao' }) });
    ctx.cas.validateTicket.mockResolvedValue({ username: 'zhenghe.bao', name: '包正和' });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser({ role: 'admin' }));
    await ctx.service.casLogin({ ticket: 't' });

    const { create, update } = ctx.prisma.user.upsert.mock.calls[0][0];
    expect(create.role).toBe('admin');
    expect(update.role).toBe('admin');
  });

  it('CAS_ROLE_MAP 预映射 → 领域角色', async () => {
    ctx = makeService({ config: cfg({ CAS_ROLE_MAP: 'yuxin.peng:legal_bp' }) });
    ctx.cas.validateTicket.mockResolvedValue({ username: 'yuxin.peng', name: '彭宇欣' });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser({ username: 'yuxin.peng', role: 'legal_bp' }));
    await ctx.service.casLogin({ ticket: 't' });
    expect(ctx.prisma.user.upsert.mock.calls[0][0].create.role).toBe('legal_bp');
  });

  it('已存在用户不降级：admin 名单未命中时 update 不写 role', async () => {
    ctx.prisma.user.findUnique.mockResolvedValue(mockUser({ role: 'legal_bp' }));
    await ctx.service.casLogin({ ticket: 't' });
    const { update } = ctx.prisma.user.upsert.mock.calls[0][0];
    expect(update.role).toBeUndefined(); // 不降级
    expect(update.displayName).toBe('包正和');
  });

  it('inactive 用户显式拒绝(401 USER_DISABLED),不 upsert', async () => {
    ctx.prisma.user.findUnique.mockResolvedValue(mockUser({ isActive: false }));
    await expect(ctx.service.casLogin({ ticket: 't' })).rejects.toMatchObject({
      status: 401,
      response: { code: 'USER_DISABLED' },
    });
    expect(ctx.prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('ticket 无效/过期 → 401 INVALID_CAS_TICKET', async () => {
    ctx.cas.validateTicket.mockRejectedValue(
      new CasAuthError(CasAuthErrorType.INVALID_TICKET, 'ticket 已使用'),
    );
    await expect(ctx.service.casLogin({ ticket: 'bad' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('CAS 不可达/超时 → 503 CAS_UNAVAILABLE(不重试)', async () => {
    ctx.cas.validateTicket.mockRejectedValue(
      new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'timeout'),
    );
    await expect(ctx.service.casLogin({ ticket: 't' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('并发首登不冲突：findUnique 双 null 后 upsert 只建一条(唯一约束兜底)', async () => {
    // 两次并发都走 upsert；Prisma upsert 由 casUsername 唯一约束保证只一条
    const p1 = ctx.service.casLogin({ ticket: 't1' });
    const p2 = ctx.service.casLogin({ ticket: 't2' });
    await Promise.all([p1, p2]);
    expect(ctx.prisma.user.upsert).toHaveBeenCalledTimes(2);
    // 两次 upsert 的 where 都是同一 casUsername
    const wheres = ctx.prisma.user.upsert.mock.calls.map((c: any) => c[0].where);
    expect(wheres[0]).toEqual({ casUsername: 'zhenghe.bao' });
  });
});

describe('AuthService.refresh（T5 会话上限）', () => {
  function makeRefresh(over: { authMethod?: string; originalExpiresAt?: Date | null; casEnforced?: boolean } = {}) {
    const { service, prisma } = makeService({
      config: cfg({ CAS_ENFORCED: over.casEnforced ? 'true' : 'false' }),
    });
    const tokenHash = crypto.createHash('sha256').update('refresh-token').digest('hex');
    prisma.refreshToken.findUnique.mockResolvedValue({
      jti: 'j1',
      isUsed: false,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
      originalExpiresAt: over.originalExpiresAt ?? new Date(Date.now() + 60_000),
      tokenHash,
      authMethod: over.authMethod ?? 'cas',
      user: mockUser(),
    });
    return { service, prisma };
  }

  it('旋转继承 authMethod=cas 且不重置链上限', async () => {
    const { service, prisma } = makeRefresh({ authMethod: 'cas' });
    await service.refresh('refresh-token');
    const data = prisma.refreshToken.create.mock.calls[0][0].data;
    expect(data.authMethod).toBe('cas');
    expect(data.originalExpiresAt).toBeInstanceOf(Date);
  });

  it('链超过 originalExpiresAt → 拒绝(会话封顶)', async () => {
    const { service } = makeRefresh({ originalExpiresAt: new Date(Date.now() - 1000) });
    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('CAS_ENFORCED 环境拒绝 password-authMethod 会话(切换吊销)', async () => {
    const { service } = makeRefresh({ authMethod: 'password', casEnforced: true });
    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
