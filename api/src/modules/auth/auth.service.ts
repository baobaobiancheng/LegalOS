import {
  Inject,
  Injectable,
  UnauthorizedException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CAS_ADAPTER,
  CasAdapter,
  CasAuthError,
  CasAuthErrorType,
  CasUserInfo,
} from './adapters/cas-adapter.interface';
import { CasLoginDto } from './dto/cas-login.dto';
import { LoginDto } from './dto/login.dto';
import { PublicUserDto } from './dto/token-response.dto';

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000;
/** CAS 会话链绝对上限（T6）：refresh 旋转不超此期限，防无限存活。默认 7 天 */
const DEFAULT_SESSION_CAP_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD = 'password';
const CAS = 'cas';
type AuthMethod = typeof PASSWORD | typeof CAS;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(CAS_ADAPTER) private readonly cas: CasAdapter,
  ) {}

  get refreshTtlMs() {
    return Number(this.config.get('REFRESH_TOKEN_TTL_MS') || 86_400_000);
  }

  /** CAS 会话链绝对上限（T6） */
  get sessionCapMs() {
    return Number(this.config.get('SESSION_CAP_MS') || DEFAULT_SESSION_CAP_MS);
  }

  /** CAS 强制环境（生产/预发）：密码登录与 password-authMethod refresh 均拒绝 */
  get casEnforced() {
    return this.config.get<string>('CAS_ENFORCED') === 'true';
  }

  private publicUser(user: User): PublicUserDto {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    };
  }

  private hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** 签发 access + refresh token 对，refresh 落库用于旋转与重放保护（T6:authMethod+绝对上限） */
  private async issueTokens(
    user: User,
    authMethod: AuthMethod = PASSWORD,
    chainOriginalExpiresAt?: Date,
  ) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      type: 'access',
    });

    const jti = crypto.randomUUID();
    // 会话链绝对上限：首次签发定死,旋转时继承（不重置）,链寿命封顶防无限存活
    const originalExpiresAt = chainOriginalExpiresAt ?? new Date(Date.now() + this.sessionCapMs);
    const capMs = originalExpiresAt.getTime();
    const expiresAt = new Date(Math.min(Date.now() + this.refreshTtlMs, capMs));
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, type: 'refresh' },
      { expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        jti,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        authMethod,
        originalExpiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * 登录：锁定检查 → bcrypt 校验 → 成功重置计数并记审计 / 失败原子递增
   */
  async login(dto: LoginDto, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    const now = new Date();

    if (user?.lockedUntil && user.lockedUntil > now) {
      throw new HttpException(
        {
          error: '账户已锁定，请30分钟后再试',
          code: 'ACCOUNT_LOCKED',
          lockedUntil: user.lockedUntil.toISOString(),
        },
        423, // HttpStatus.LOCKED (NestJS v10 未导出)
      );
    }

    const passwordValid =
      user && user.isActive
        ? await bcrypt.compare(dto.password, user.passwordHash)
        : false;

    if (!passwordValid || !user) {
      if (user) await this.registerFailedAttempt(user.id);
      throw new UnauthorizedException({
        error: '用户名或密码错误',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // TS 此时已知 user 非 null
    // 原子重置失败计数
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    const tokens = await this.issueTokens(user);
    await this.prisma.loginAudit.create({
      data: { userId: user.id, ip: ip ?? null },
    });

    return { ...tokens, user: this.publicUser(user) };
  }

  /** CAS_ROLE_MAP 个人映射：'user:role,user2:role2'（如 junfang.zhao:legal_lead、zhenghe.bao:admin） */
  private casRoleMap(): Record<string, Role> {
    const raw = this.config.get<string>('CAS_ROLE_MAP') || '';
    const map: Record<string, Role> = {};
    for (const pair of raw.split(',')) {
      const [user, role] = pair.split(':').map((s) => s.trim());
      if (
        user &&
        (role === 'admin' || role === 'legal_bp' || role === 'legal_lead' || role === 'business')
      ) {
        map[user.toLowerCase()] = role as Role;
      }
    }
    return map;
  }

  /** CAS_DEPT_MAP 部门映射：'法务部:legal_bp,部门2:role2'（组织架构驱动） */
  private casDeptMap(): Record<string, Role> {
    const raw = this.config.get<string>('CAS_DEPT_MAP') || '';
    const map: Record<string, Role> = {};
    for (const pair of raw.split(',')) {
      const [dept, role] = pair.split(':').map((s) => s.trim());
      if (
        dept &&
        (role === 'admin' || role === 'legal_bp' || role === 'legal_lead' || role === 'business')
      ) {
        map[dept] = role as Role;
      }
    }
    return map;
  }

  /** 领域角色解析（组织架构驱动,登录时重新派生）：个人映射 > 部门映射(deptName) > 默认 business */
  private resolveRole(casUsername: string, deptName?: string): Role {
    const personal = this.casRoleMap()[casUsername.trim().toLowerCase()];
    if (personal) return personal;
    const dept = this.casDeptMap()[(deptName || '').trim()];
    if (dept) return dept;
    return 'business';
  }

  /**
   * CAS 登录（T3 修订）：登录页账号密码 → 方式一(/api/login 换 ticket → validate) → upsert → JWT。
   * 角色组织架构驱动：个人映射(CAS_ROLE_MAP) > 部门映射(CAS_DEPT_MAP,deptName) > 默认 business。
   * 错误码：账号/密码错或无权限→401；CAS 不可达/超时→503(不重试)。
   */
  async casLogin(dto: CasLoginDto, ip?: string) {
    let info: CasUserInfo;
    try {
      info = await this.cas.loginWithPassword(dto.username, dto.password);
    } catch (e) {
      if (e instanceof CasAuthError) {
        if (e.type === CasAuthErrorType.INVALID_CREDENTIALS) {
          throw new UnauthorizedException({
            error: '账号或密码错误，或未开通项目权限',
            code: 'INVALID_CAS_CREDENTIALS',
          });
        }
        if (e.type === CasAuthErrorType.INVALID_TICKET) {
          throw new UnauthorizedException({
            error: '登录已失效，请重试',
            code: 'INVALID_CAS_TICKET',
          });
        }
        throw new ServiceUnavailableException({
          error: '认证服务暂不可用，请稍后重试',
          code: 'CAS_UNAVAILABLE',
        });
      }
      throw e;
    }

    if (!info.username) {
      throw new UnauthorizedException({
        error: '认证返回缺少用户标识',
        code: 'INVALID_CAS_CREDENTIALS',
      });
    }

    // inactive 显式拒绝：不能靠 JWT guard 兜底（登录尚未签发 token）
    const existing = await this.prisma.user.findUnique({ where: { casUsername: info.username } });
    if (existing && !existing.isActive) {
      throw new UnauthorizedException({ error: '账号已停用，请联系管理员', code: 'USER_DISABLED' });
    }

    // 组织架构驱动：每次登录重新派生角色（个人映射 > 部门映射 > business）
    const role = this.resolveRole(info.username, info.deptName);

    // upsert：并发首登只建一条（casUsername 唯一约束），不报冲突
    // department 仅当 CAS 返回 deptName 时写入；缺省不更新，避免覆盖钉钉同步的部门（review 2026-08-11 P1）
    const casDept = info.deptName ?? null;
    const user = await this.prisma.user.upsert({
      where: { casUsername: info.username },
      create: {
        username: info.username,
        displayName: info.name,
        passwordHash: crypto.randomBytes(16).toString('hex'), // 随机不可用哈希,不能密码登录
        role,
        casUsername: info.username,
        department: casDept,
      },
      update: {
        displayName: info.name,
        role,
        ...(casDept ? { department: casDept } : {}), // 缺省不覆盖已有部门
      },
    });

    if (!user.isActive) {
      throw new UnauthorizedException({ error: '账号已停用，请联系管理员', code: 'USER_DISABLED' });
    }

    const tokens = await this.issueTokens(user, CAS);
    await this.prisma.loginAudit.create({ data: { userId: user.id, ip: ip ?? null } });
    return { ...tokens, user: this.publicUser(user) };
  }

  /** 原子递增失败次数，达阈值则锁定（Prisma increment 防竞态） */
  private async registerFailedAttempt(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });

    if (updated.failedAttempts >= LOCK_THRESHOLD) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
      });
    }
  }

  /**
   * 刷新：校验 hash + 未使用 + 未撤销 + 未过期 → 标记已用 → 签发新 token 对（旋转）
   */
  async refresh(token: string | undefined) {
    const invalid = () =>
      new UnauthorizedException({
        error: 'token 无效或已过期',
        code: 'INVALID_REFRESH_TOKEN',
      });

    if (!token) throw invalid();

    let payload: { sub: string; jti: string; type: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw invalid();
    }
    if (payload.type !== 'refresh') throw invalid();

    const record = await this.prisma.refreshToken.findUnique({
      where: { jti: payload.jti },
      include: { user: true },
    });

    // T6 会话上限：originalExpiresAt 链绝对过期（旋转不重置）；CAS 强制环境拒 password 会话（切换吊销）
    const withinChainCap = record?.originalExpiresAt ? new Date() < record.originalExpiresAt : true;
    const authAllowed = record ? !(this.casEnforced && record.authMethod === PASSWORD) : true;

    const valid =
      record &&
      !record.isUsed &&
      !record.isRevoked &&
      record.expiresAt > new Date() &&
      withinChainCap &&
      authAllowed &&
      record.tokenHash === this.hashToken(token) &&
      record.user.isActive;

    if (!valid) throw invalid();

    // 原子标记已使用：WHERE isUsed=false 防 TOCTOU 并发重放
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { jti: payload.jti, isUsed: false },
      data: { isUsed: true },
    });
    if (count === 0) throw invalid();

    // 旋转继承 authMethod 与链上限（不重置 originalExpiresAt）
    return this.issueTokens(
      record.user,
      (record.authMethod as AuthMethod) || PASSWORD,
      record.originalExpiresAt ?? undefined,
    );
  }

  /** 退出：撤销 refreshToken */
  async logout(token: string | undefined) {
    if (!token) return;
    try {
      const payload = await this.jwt.verifyAsync<{ jti?: string }>(token);
      if (payload.jti) {
        await this.prisma.refreshToken.updateMany({
          where: { jti: payload.jti },
          data: { isRevoked: true },
        });
      }
    } catch (error) {
      // JWT 过期或无效 — 无需撤销
      if (error instanceof Error && error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') {
        console.warn('[auth] logout: 撤销 refreshToken 失败', error instanceof Error ? error.message : error);
      }
    }
  }
}
