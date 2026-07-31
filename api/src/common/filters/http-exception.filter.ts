import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * 统一错误响应格式（设计文档「统一错误响应」）
 * { error: string, code: string, statusCode: number }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

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
        message: undefined,
      });
    }

    this.logger.error(exception);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: '服务器内部错误',
      code: 'INTERNAL_ERROR',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
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
