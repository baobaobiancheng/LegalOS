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
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.host = (config.get<string>('CAS_HOST') || '').replace(/\/+$/, '');
    this.timeoutMs = Number(config.get('CAS_VALIDATE_TIMEOUT_MS') || 5000);
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

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // 不可达/超时/网络错误 → 503。⚠️ 不重试：ticket 一次性,重试可能消费后返回无效
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, `CAS 不可达：${(e as Error)?.message ?? e}`);
    }
    if (!res.ok) {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, `CAS 返回 HTTP ${res.status}`);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
      throw new CasAuthError(CasAuthErrorType.CAS_UNAVAILABLE, 'CAS 返回非 JSON');
    }

    if (body?.status !== 'success') {
      throw new CasAuthError(
        CasAuthErrorType.INVALID_TICKET,
        String(body?.msg ?? 'ticket 无效或已过期'),
      );
    }

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
