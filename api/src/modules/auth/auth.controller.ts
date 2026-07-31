import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PublicUserDto } from './dto/token-response.dto';

const REFRESH_COOKIE = 'legal_refresh_token';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** refreshToken 存 httpOnly cookie，防 XSS（设计文档「Token 传输策略」） */
  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/auth',
      maxAge: this.auth.refreshTtlMs,
    });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  /** 登录 — 每 IP 5 次/分钟速率限制 */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res() res: Response) {
    const { accessToken, refreshToken, user } = await this.auth.login(dto, req.ip);
    this.setRefreshCookie(res, refreshToken);
    return res.json({ accessToken, user });
  }

  /** 刷新 — refreshToken 旋转 */
  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    try {
      const { accessToken, refreshToken } = await this.auth.refresh(
        req.cookies?.[REFRESH_COOKIE],
      );
      this.setRefreshCookie(res, refreshToken);
      return res.json({ accessToken });
    } catch (error) {
      this.clearRefreshCookie(res);
      throw error;
    }
  }

  /** 当前用户 — 全局 JwtAuthGuard 已校验 isActive */
  @Get('me')
  me(@CurrentUser() user: PublicUserDto) {
    return user;
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearRefreshCookie(res);
    return res.status(HttpStatus.NO_CONTENT).end();
  }
}
