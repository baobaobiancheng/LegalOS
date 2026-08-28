import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  CasAuthError,
  CasAuthErrorType,
} from '../src/modules/auth/adapters/cas-adapter.interface';

/**
 * CAS 登录（T3 修订）单测：
 * - 账号密码登录（方式一）→ upsert 并发安全
 * - 角色组织架构驱动：个人映射(CAS_ROLE_MAP) > 部门映射(CAS_DEPT_MAP,deptName) > 默认 business
 * - inactive 拒绝 / 错误码（账号密码错→401 / CAS 不可达→503）
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
    CAS_ROLE_MAP: '',
    CAS_DEPT_MAP: '',
  };
  return { get: (k: string) => ({ ...base, ...over })[k] ?? undefined };
};

function makeService(over: { config?: ReturnType<typeof cfg> } = {}) {
  const prisma = {
    user: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn().mockImplementation((x: any) => Promise.resolve(x.data)) },
    refreshToken: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    loginAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const jwt = {
    signAsync: vi.fn().mockResolvedValue('signed-token'),
    verifyAsync: vi.fn().mockResolvedValue({ sub: 'u-1', jti: 'j1', type: 'refresh' }),
  };
  const cas = { loginWithPassword: vi.fn(), validateTicket: vi.fn() };
  const service = new AuthService(prisma as any, jwt as any, over.config ?? cfg() as any, cas as any);
  return { service, prisma, jwt, cas };
}

describe('AuthService.casLogin（账号密码/方式一）', () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService();
    ctx.cas.loginWithPassword.mockResolvedValue({
      username: 'zhenghe.bao',
      name: '包正和',
      email: 'zhenghe.bao@brgroup.com',
      deptName: '研发部',
      projectCode: 'legalos',
    });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser());
  });

  it('账号密码登录：调 loginWithPassword + upsert 建号(business) + authMethod=cas；默认无角色变更', async () => {
    await ctx.service.casLogin({ username: 'zhenghe.bao', password: 'pw-123' }, '1.2.3.4');
    expect(ctx.cas.loginWithPassword).toHaveBeenCalledWith('zhenghe.bao', 'pw-123');
    const create = ctx.prisma.user.upsert.mock.calls[0][0];
    expect(create.where).toEqual({ casUsername: 'zhenghe.bao' });
    expect(create.create.username).toBe('zhenghe.bao');
    expect(create.create.role).toBe('business'); // 初始默认
    expect(create.create.passwordHash).not.toBe(''); // 随机不可用哈希
    expect(ctx.prisma.user.update).not.toHaveBeenCalled(); // 默认 business,无需变更
    const rt = ctx.prisma.refreshToken.create.mock.calls[0][0].data;
    expect(rt.authMethod).toBe('cas');
    expect(ctx.prisma.loginAudit.create).toHaveBeenCalled();
  });

  it('个人映射 CAS_ROLE_MAP 命中 → 建号后升级 legal_lead（赵俊芳→法务管理员）', async () => {
    ctx = makeService({ config: cfg({ CAS_ROLE_MAP: 'junfang.zhao:legal_lead' }) });
    ctx.cas.loginWithPassword.mockResolvedValue({ username: 'junfang.zhao', name: '赵俊芳' });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser({ username: 'junfang.zhao', role: 'business' }));
    const user = await ctx.service.casLogin({ username: 'junfang.zhao', password: 'pw' });
    expect(ctx.prisma.user.upsert.mock.calls[0][0].create.role).toBe('business'); // 初始
    expect(ctx.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'legal_lead' } }));
    expect(ctx.jwt.signAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({ role: 'legal_lead' }));
    expect(user.user.role).toBe('legal_lead');
  });

  it('部门映射 CAS_DEPT_MAP 命中(按 User.department 钉钉部门) → 法务部 → legal_bp', async () => {
    ctx = makeService({ config: cfg({ CAS_DEPT_MAP: '法务部:legal_bp' }) });
    ctx.cas.loginWithPassword.mockResolvedValue({ username: 'yuxin.peng', name: '彭宇欣' });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    // 存量用户已由钉钉同步写入 department=法务部
    ctx.prisma.user.upsert.mockResolvedValue(mockUser({ username: 'yuxin.peng', role: 'business', department: '法务部' }));
    const user = await ctx.service.casLogin({ username: 'yuxin.peng', password: 'pw' });
    expect(ctx.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'legal_bp' } }));
    expect(user.user.role).toBe('legal_bp');
  });

  it('管理员已预开通用户首次登录：命中既有 CAS 身份并保留钉钉部门和法务角色', async () => {
    ctx = makeService({ config: cfg({ CAS_DEPT_MAP: '合规一组:legal_bp' }) });
    ctx.cas.loginWithPassword.mockResolvedValue({ username: 'jun.wang1', name: '王君' });
    const provisioned = mockUser({
      id: 'user-provisioned', username: 'jun.wang1', casUsername: 'jun.wang1', displayName: '王君',
      role: 'legal_bp', department: '合规一组', dingtalkUserId: 'DING-1',
    });
    ctx.prisma.user.findUnique.mockResolvedValue(provisioned);
    ctx.prisma.user.upsert.mockResolvedValue(provisioned);

    const result = await ctx.service.casLogin({ username: 'jun.wang1', password: 'pw' });

    expect(ctx.prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { casUsername: 'jun.wang1' },
      update: { displayName: '王君' },
    }));
    expect(ctx.prisma.user.update).not.toHaveBeenCalled();
    expect(ctx.jwt.signAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sub: 'user-provisioned',
      role: 'legal_bp',
    }));
    expect(result.user).toMatchObject({ id: 'user-provisioned', role: 'legal_bp' });
  });

  it('个人映射优先于部门映射', async () => {
    ctx = makeService({ config: cfg({ CAS_ROLE_MAP: 'junfang.zhao:legal_lead', CAS_DEPT_MAP: '法务部:legal_bp' }) });
    ctx.cas.loginWithPassword.mockResolvedValue({ username: 'junfang.zhao', name: '赵俊芳' });
    ctx.prisma.user.findUnique.mockResolvedValue(null);
    ctx.prisma.user.upsert.mockResolvedValue(mockUser({ username: 'junfang.zhao', role: 'business', department: '法务部' }));
    const user = await ctx.service.casLogin({ username: 'junfang.zhao', password: 'pw' });
    expect(ctx.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'legal_lead' } })); // 个人赢
    expect(user.user.role).toBe('legal_lead');
  });

  it('inactive 用户显式拒绝(401 USER_DISABLED),不 upsert', async () => {
    ctx.prisma.user.findUnique.mockResolvedValue(mockUser({ isActive: false }));
    await expect(ctx.service.casLogin({ username: 'zhenghe.bao', password: 'pw' })).rejects.toMatchObject({
      status: 401,
      response: { code: 'USER_DISABLED' },
    });
    expect(ctx.prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('账号或密码错误 → 401 INVALID_CAS_CREDENTIALS', async () => {
    ctx.cas.loginWithPassword.mockRejectedValue(
      new CasAuthError(CasAuthErrorType.INVALID_CREDENTIALS, '账号或密码错误'),
    );
    await expect(ctx.service.casLogin({ username: 'x', password: 'y' })).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_CAS_CREDENTIALS' },
    });
  });

  it('CAS 不可达/超时 → 503 CAS_UNAVAILABLE(不重试)', async () => {
    ctx.cas.loginWithPassword.mockRejectedValue(
      new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'timeout'),
    );
    await expect(ctx.service.casLogin({ username: 'x', password: 'y' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('并发首登不冲突：findUnique 双 null 后 upsert 只建一条(唯一约束兜底)', async () => {
    const p1 = ctx.service.casLogin({ username: 'zhenghe.bao', password: 'a' });
    const p2 = ctx.service.casLogin({ username: 'zhenghe.bao', password: 'b' });
    await Promise.all([p1, p2]);
    expect(ctx.prisma.user.upsert).toHaveBeenCalledTimes(2);
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
