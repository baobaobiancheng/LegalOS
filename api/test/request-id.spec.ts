import { describe, it, expect, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RequestIdInterceptor } from '../src/common/interceptors/request-id.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { of } from 'rxjs';

/**
 * P2-03 请求 ID：拦截器生成并设置 X-Request-ID;异常过滤器把 requestId 写进错误体。
 * 客户端可透传的 X-Request-ID 仅当格式合法才沿用,否则重新生成。
 */
const makeCtx = (req: any, res: any) => ({
  switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
}) as any;

describe('RequestIdInterceptor', () => {
  it('生成 requestId 并写入响应头 + 请求上下文', () => {
    const req: any = { headers: {} };
    const res: any = { setHeader: vi.fn() };
    const interceptor = new RequestIdInterceptor();
    // of() 同步发射,subscribe 后即可断言
    interceptor.intercept(makeCtx(req, res), { handle: () => of('ok') } as any).subscribe();
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('合法客户端 X-Request-ID 透传;非法则重新生成', () => {
    const reqGood: any = { headers: { 'x-request-id': 'client-rid-1234567890' } };
    const resGood: any = { setHeader: vi.fn() };
    new RequestIdInterceptor().intercept(makeCtx(reqGood, resGood), { handle: () => of('x') } as any).subscribe();
    expect(reqGood.requestId).toBe('client-rid-1234567890');

    const reqBad: any = { headers: { 'x-request-id': '..//../../etc/passwd' } };
    const resBad: any = { setHeader: vi.fn() };
    new RequestIdInterceptor().intercept(makeCtx(reqBad, resBad), { handle: () => of('x') } as any).subscribe();
    expect(reqBad.requestId).not.toBe('..//../../etc/passwd');
    expect(reqBad.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('HttpExceptionFilter requestId', () => {
  it('HttpException 错误体附带 requestId', () => {
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req: any = { requestId: 'rid-test-123456' };
    const filter = new HttpExceptionFilter();
    filter.catch(new HttpException('禁止', HttpStatus.FORBIDDEN), makeCtx(req, res));
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.requestId).toBe('rid-test-123456');
    expect(body.code).toBe('FORBIDDEN');
  });

  it('未知异常也附带 requestId', () => {
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req: any = { requestId: 'rid-test-abc' };
    const filter = new HttpExceptionFilter();
    filter.catch(new Error('boom'), makeCtx(req, res));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].requestId).toBe('rid-test-abc');
  });
});
