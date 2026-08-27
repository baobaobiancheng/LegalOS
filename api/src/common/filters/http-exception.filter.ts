import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { auditActorFromRequest, auditRequestContext } from '../audit/audit-request';

/**
 * 统一错误响应格式（设计文档「统一错误响应」）
 * { error: string, code: string, statusCode: number, requestId?: string }
 * P2-03：错误体附带 requestId,服务端日志以该 ID 关联请求。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly audit?: AuditService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const requestWithId = request as Request & { requestId?: string };
    const requestId = requestWithId.requestId ?? randomUUID();
    requestWithId.requestId = requestId;
    response.setHeader?.('X-Request-ID', requestId);

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const body =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : { error: String(payload) };

      // class-validator 校验失败：message 是字符串数组 → 优先展示具体原因，
      // 否则只显示「Bad Request」无法定位（review 2026-08-11 P0 短推荐问题 400）
      const messages = body.message;
      const error =
        (Array.isArray(messages) ? messages.join('；') : messages) ??
        body.error ??
        '请求失败';
      const code = body.code ?? this.defaultCode(statusCode);

      if (this.audit) {
        await this.recordFailure(request, statusCode, String(code)).catch((auditError) => {
          this.logger.error(`requestId=${requestId} 审计失败事件写入失败：${auditError}`);
        });
      }

      if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error([
          `requestId=${toLogToken(requestId)}`,
          `statusCode=${statusCode}`,
          `code=${toLogToken(code)}`,
          ...causeDiagnostics(exception.cause),
        ].join(' '));
      }

      return response.status(statusCode).json({
        ...body,
        error,
        code,
        statusCode,
        ...(requestId ? { requestId } : {}),
        message: undefined,
      });
    }

    if (this.audit) {
      await this.recordFailure(request, HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR').catch((auditError) => {
        this.logger.error(`requestId=${requestId} 审计失败事件写入失败：${auditError}`);
      });
    }
    this.logger.error(`requestId=${requestId} ${exception instanceof Error ? exception.message : exception}`);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: '服务器内部错误',
      code: 'INTERNAL_ERROR',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      ...(requestId ? { requestId } : {}),
    });
  }

  private defaultCode(statusCode: number) {
    const map: Record<number, string> = {
      400: 'VALIDATION_FAILED',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      423: 'ACCOUNT_LOCKED',
      429: 'TOO_MANY_REQUESTS',
    };
    return map[statusCode] ?? 'REQUEST_FAILED';
  }

  private async recordFailure(request: Request, statusCode: number, reasonCode: string) {
    if (!this.audit) return;
    const requestedAction = classifySensitiveAction(request.method, request.path || request.originalUrl);
    const isDenied = statusCode === HttpStatus.UNAUTHORIZED || statusCode === HttpStatus.FORBIDDEN;
    const isLogin = requestedAction === 'auth.login';
    if (!requestedAction && !isDenied) return;
    const resourceId = typeof request.params?.id === 'string' ? request.params.id : null;
    await this.audit.record({
      actor: auditActorFromRequest(request),
      action: isLogin ? 'auth.login.failed' : isDenied ? 'authorization.denied' : `${requestedAction}.failed`,
      resourceType: resourceTypeFor(request.path || request.originalUrl),
      resourceId,
      projectId: resourceTypeFor(request.path || request.originalUrl) === 'project' ? resourceId : null,
      source: 'api',
      outcome: isDenied ? 'denied' : 'failed',
      reasonCode,
      request: auditRequestContext(request),
      metadata: {
        method: request.method,
        path: safePath(request.path || request.originalUrl),
        statusCode,
        ...(requestedAction ? { requestedAction } : {}),
        ...(isLogin && typeof (request.body as any)?.username === 'string'
          ? { loginIdentityHash: this.audit.fingerprint(String((request.body as any).username).trim().toLocaleLowerCase()) }
          : {}),
      },
      retentionClass: isLogin || isDenied ? 'security' : 'business',
    });
  }
}

function classifySensitiveAction(method: string, rawPath: string): string | null {
  const path = normalizedPath(rawPath);
  if (method === 'POST' && /^\/auth\/(cas-)?login$/.test(path)) return 'auth.login';
  if (method === 'POST' && /\/admin\/members\/bind$/.test(path)) return 'member.bind';
  if (method === 'POST' && /\/admin\/members\/unbind$/.test(path)) return 'member.unbind';
  if (method === 'POST' && /\/admin\/members\/sync$/.test(path)) return 'member.directory.sync';
  if (method === 'PUT' && /\/admin\/members\/bp-domains$/.test(path)) return 'member.bp_scope.change';
  if (method === 'PATCH' && /\/projects\/[^/]+$/.test(path)) return 'project.update';
  if (method === 'POST' && /\/projects\/[^/]+\/(transfer|cancel|reply|escalate)$/.test(path)) {
    return `project.${path.split('/').pop()}`;
  }
  if (method === 'GET' && /\/projects\/[^/]+\/files\/[^/]+$/.test(path)) return 'attachment.download';
  if (method === 'POST' && /\/projects\/[^/]+\/downloads$/.test(path)) return 'record.download';
  if (method === 'POST' && /\/contracts\/(generate|[^/]+\/(review|submit-review))$/.test(path)) return 'contract.operation';
  if (/\/admin\/audit-logs/.test(path)) return 'audit.read';
  return null;
}

function resourceTypeFor(rawPath: string): string {
  const path = normalizedPath(rawPath);
  if (path.includes('/members')) return 'member';
  if (path.includes('/projects/')) return path.includes('/files/') ? 'attachment' : 'project';
  if (path.includes('/contracts')) return 'contract';
  if (path.includes('/audit-logs')) return 'audit_event';
  if (path.includes('/auth/')) return 'auth_session';
  return 'http_resource';
}

function safePath(value: string): string {
  return value.split('?')[0].slice(0, 512);
}

function normalizedPath(value: string): string {
  return safePath(value).replace(/^\/api(?=\/)/, '');
}

function causeDiagnostics(cause: unknown): string[] {
  if (typeof cause !== 'object' || cause === null) return [];
  const value = cause as Record<string, unknown>;
  return [
    ['causeName', value.name],
    ['causeCode', value.code],
    ['supplierCode', value.supplierCode],
    ['retryable', value.retryable],
  ].flatMap(([key, item]) => item === undefined ? [] : [`${key}=${toLogToken(item)}`]);
}

function toLogToken(value: unknown): string {
  const normalized = String(value ?? '-').replace(/[^\p{L}\p{N}_.:@-]/gu, '_');
  return normalized.slice(0, 120) || '-';
}
