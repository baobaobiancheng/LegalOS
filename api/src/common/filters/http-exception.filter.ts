import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * 统一错误响应格式（设计文档「统一错误响应」）
 * { error: string, code: string, statusCode: number, requestId?: string }
 * P2-03：错误体附带 requestId,服务端日志以该 ID 关联请求。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const requestId = (request as { requestId?: string }).requestId;

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

    this.logger.error(`requestId=${requestId ?? '-'} ${exception instanceof Error ? exception.message : exception}`);
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
