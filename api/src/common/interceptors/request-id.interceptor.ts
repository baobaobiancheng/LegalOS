import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';

/**
 * P2-03 请求 ID 中间件：
 * - 每个请求生成不可预测 request ID;响应头 `X-Request-ID` + 错误体 `requestId` 返回同一值。
 * - 不直接信任客户端传入的 X-Request-ID：仅当匹配 ^[A-Za-z0-9-]{8,64}$ 才透传,否则重新生成。
 * - 异常路径由 HttpExceptionFilter 从 `req.requestId` 读取并写入错误体与日志。
 */
const REQ_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && REQ_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    (req as { requestId?: string }).requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    return next.handle();
  }
}
