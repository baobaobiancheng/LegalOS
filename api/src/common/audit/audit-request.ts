import { Request } from 'express';
import { AuditActor, AuditRequestContext } from './audit.types';

type RequestWithAudit = Request & {
  requestId?: string;
  user?: { id?: string; role?: string };
};

export function auditRequestContext(request: RequestWithAudit): AuditRequestContext {
  return {
    requestId: request.requestId,
    // 只使用 Express 已按 trust proxy 配置解析的 IP，不直接信任可由客户端伪造的 X-Forwarded-For。
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent']
      : undefined,
  };
}

export function auditActorFromRequest(request: RequestWithAudit): AuditActor {
  return {
    type: request.user?.id ? 'user' : 'external',
    id: request.user?.id ?? null,
    role: request.user?.role ?? null,
  };
}
