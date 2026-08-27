import { Prisma, Role } from '@prisma/client';

export type AuditOutcome = 'success' | 'denied' | 'failed' | 'partial';
export type AuditRetentionClass = 'security' | 'admin' | 'business' | 'ai';

export interface AuditActor {
  type?: 'user' | 'system' | 'external';
  id?: string | null;
  role?: Role | string | null;
}

export interface AuditRequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface RecordAuditEventInput {
  eventId?: string;
  occurredAt?: Date;
  actor?: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  source?: 'web' | 'api' | 'scheduler' | 'dingtalk' | 'dsh' | 'system';
  outcome: AuditOutcome;
  reasonCode?: string | null;
  request?: AuditRequestContext;
  correlationId?: string | null;
  before?: unknown;
  after?: unknown;
  changes?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
  retentionClass: AuditRetentionClass;
}

export type AuditWriter = Prisma.TransactionClient | {
  auditEvent: {
    create(args: unknown): Promise<unknown>;
  };
};
