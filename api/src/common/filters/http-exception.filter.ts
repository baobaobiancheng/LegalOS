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

      // class-validator 校验失败：message 是字符串数组
      const messages = body.message;
      const error =
        body.error ??
        (Array.isArray(messages) ? messages.join('；') : messages) ??
        '请求失败';

      return response.status(statusCode).json({
        ...body,
        error,
        code: body.code ?? this.defaultCode(statusCode),
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
