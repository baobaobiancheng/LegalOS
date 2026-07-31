import {
  Injectable,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { PublicUserDto } from './dto/token-response.dto';

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get refreshTtlMs() {
    return Number(this.config.get('REFRESH_TOKEN_TTL_MS') || 86_400_000);
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

  /** 签发 access + refresh token 对，refresh 落库用于旋转与重放保护 */
  private async issueTokens(user: User) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      type: 'access',
    });

    const jti = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, type: 'refresh' },
      { expiresIn: Math.floor(this.refreshTtlMs / 1000) },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        jti,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
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

    const valid =
      record &&
      !record.isUsed &&
      !record.isRevoked &&
      record.expiresAt > new Date() &&
      record.tokenHash === this.hashToken(token) &&
      record.user.isActive;

    if (!valid) throw invalid();

    // 原子标记已使用：WHERE isUsed=false 防 TOCTOU 并发重放
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { jti: payload.jti, isUsed: false },
      data: { isUsed: true },
    });
    if (count === 0) throw invalid();

    return this.issueTokens(record.user);
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
