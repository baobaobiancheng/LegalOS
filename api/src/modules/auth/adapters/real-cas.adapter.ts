import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CasAdapter, CasAuthError, CasAuthErrorType, CasUserInfo } from './cas-adapter.interface';

/**
 * 真实 CAS 适配器（T2）：GET {CAS_HOST}/validate?ticket={ticket}
 * 协议经源码确认（cas-spring-boot-starter CasAuthService.validateTicket）+ 真实 ticket 实测：
 * - 无 service/projectCode 参数
 * - 成功 status='success'；字段名混用（deptName/projectCode camelCase，role_code 等 snake_case）
 */
@Injectable()
export class RealCasAdapter implements CasAdapter {
  private readonly logger = new Logger(RealCasAdapter.name);
  private readonly host: string;
  private readonly projectCode: string;
  private readonly redirectUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.host = (config.get<string>('CAS_HOST') || '').replace(/\/+$/, '');
    this.projectCode = config.get<string>('CAS_PROJECT_CODE') || '';
    this.redirectUrl = config.get<string>('CAS_REDIRECT_URL') || '';
    this.timeoutMs = Number(config.get('CAS_VALIDATE_TIMEOUT_MS') || 5000);
  }

  private async casFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), ...init });
    } catch (e) {
      // 不可达/超时/网络错误 → 503。⚠️ 不重试：ticket 一次性,重试可能消费后返回无效
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, `CAS 不可达：${(e as Error)?.message ?? e}`);
    }
  }

  private parse<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'CAS 返回非 JSON');
    }
  }

  async validateTicket(ticket: string): Promise<CasUserInfo> {
    if (!this.host) {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'CAS_HOST 未配置');
    }
    if (!ticket) {
      throw new CasAuthError(CasAuthErrorType.INVALID_TICKET, 'ticket 为空');
    }

    const url = `${this.host}/validate?ticket=${encodeURIComponent(ticket)}`;
    this.logger.debug(`CAS validate: ${url.replace(ticket, ticket.slice(0, 8) + '…')}`); // 不打明文 ticket

    const res = await this.casFetch(url);
    if (!res.ok) {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, `CAS 返回 HTTP ${res.status}`);
    }
    const body = this.parse<Record<string, unknown>>(await res.text());

    if (body?.status !== 'success') {
      throw new CasAuthError(CasAuthErrorType.INVALID_TICKET, String(body?.msg ?? 'ticket 无效或已过期'));
    }

    return this.toUserInfo(body);
  }

  /**
   * 登录页账号密码登录（方式一，文档 8.1）：
   * POST /api/login (username/password/projectCode/redirectUrl) → data.ticket → validate
   */
  async loginWithPassword(username: string, password: string): Promise<CasUserInfo> {
    if (!this.host) {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'CAS_HOST 未配置');
    }
    if (!username || !password) {
      throw new CasAuthError(CasAuthErrorType.INVALID_CREDENTIALS, '账号或密码为空');
    }

    const loginUrl = `${this.host}/api/login`;
    this.logger.debug(`CAS 方式一登录: ${loginUrl}（username=${username} 不打密码）`);

    const res = await this.casFetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username,
        password,
        projectCode: this.projectCode,
        redirectUrl: this.redirectUrl,
      }).toString(),
    });
    if (!res.ok) {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, `CAS /api/login 返回 HTTP ${res.status}`);
    }
    const body = this.parse<{
      code?: number;
      msg?: string;
      data?: { ticket?: string; username?: string };
    }>(await res.text());

    const ticket = body?.data?.ticket;
    if (body?.code !== 200 || !ticket) {
      // 账号密码错 / 未开通项目权限 → 401
      throw new CasAuthError(
        CasAuthErrorType.INVALID_CREDENTIALS,
        String(body?.msg ?? '账号或密码错误，或未开通项目权限'),
      );
    }

    return this.validateTicket(ticket);
  }

  private toUserInfo(body: Record<string, unknown>): CasUserInfo {
    return {
      username: String(body.username ?? ''),
      name: String(body.name ?? ''),
      email: (body.email as string) || undefined,
      deptName: (body.deptName as string) || undefined,
      projectCode: (body.projectCode as string) || undefined,
      // 真实响应 role_code 为 snake_case（实测确认）
      roleCode: String(body.role_code ?? body.roleCode ?? '') || undefined,
    };
  }
}
