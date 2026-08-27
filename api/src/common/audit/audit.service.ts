import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditRetentionClass, AuditWriter, RecordAuditEventInput } from './audit.types';

const MAX_JSON_BYTES = 32 * 1024;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly integritySecret: string;
  private readonly fingerprintSalt: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.integritySecret = String(config.get('AUDIT_HMAC_SECRET', ''));
    this.fingerprintSalt = String(config.get('AUDIT_FINGERPRINT_SALT', this.integritySecret));
    if (!this.integritySecret) {
      this.logger.warn('AUDIT_HMAC_SECRET 未配置：事件使用普通 SHA-256，只能发现意外修改，不能抵抗可重算哈希的数据库管理员');
    }
  }

  async record(input: RecordAuditEventInput, writer: AuditWriter = this.prisma): Promise<any> {
    const eventId = bound(input.eventId || randomUUID(), 64);
    const occurredAt = input.occurredAt ?? new Date();
    const beforeHash = input.before === undefined ? null : this.digestCanonical(input.before);
    const afterHash = input.after === undefined ? null : this.digestCanonical(input.after);
    const changes = compactJson(input.changes);
    const metadata = compactJson(input.metadata);
    const expiresAt = this.expiryFor(input.retentionClass, occurredAt);
    const hashVersion = this.integritySecret ? 'hmac-sha256-v1' : 'sha256-v1';
    const core = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      actorType: input.actor?.type ?? 'user',
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ? String(input.actor.role) : null,
      action: bound(input.action, 96),
      resourceType: bound(input.resourceType, 64),
      resourceId: input.resourceId ? bound(input.resourceId, 191) : null,
      projectId: input.projectId ? bound(input.projectId, 64) : null,
      source: input.source ?? 'api',
      outcome: input.outcome,
      reasonCode: input.reasonCode ? bound(input.reasonCode, 96) : null,
      requestId: input.request?.requestId ? bound(input.request.requestId, 64) : null,
      correlationId: input.correlationId ? bound(input.correlationId, 128) : null,
      ipHash: input.request?.ip ? this.fingerprint(input.request.ip) : null,
      userAgentHash: input.request?.userAgent ? this.fingerprint(input.request.userAgent) : null,
      beforeHash,
      afterHash,
      changes,
      metadata,
      hashVersion,
      retentionClass: input.retentionClass,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
    const eventHash = this.integrityDigest(core);
    return (writer.auditEvent.create as any)({
      data: {
        ...core,
        occurredAt,
        expiresAt,
        eventHash,
      },
    });
  }

  fingerprint(value: string): string {
    return createHash('sha256').update(`${this.fingerprintSalt}:${value}`).digest('hex');
  }

  digestCanonical(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
  }

  verifyEvent(event: Record<string, any>): boolean {
    const core = {
      eventId: event.eventId,
      occurredAt: new Date(event.occurredAt).toISOString(),
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      actorRole: event.actorRole ?? null,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      projectId: event.projectId ?? null,
      source: event.source,
      outcome: event.outcome,
      reasonCode: event.reasonCode ?? null,
      requestId: event.requestId ?? null,
      correlationId: event.correlationId ?? null,
      ipHash: event.ipHash ?? null,
      userAgentHash: event.userAgentHash ?? null,
      beforeHash: event.beforeHash ?? null,
      afterHash: event.afterHash ?? null,
      changes: event.changes ?? null,
      metadata: event.metadata ?? null,
      hashVersion: event.hashVersion,
      retentionClass: event.retentionClass,
      expiresAt: event.expiresAt ? new Date(event.expiresAt).toISOString() : null,
    };
    return this.integrityDigest(core, event.hashVersion) === event.eventHash;
  }

  retentionPolicy(): Record<AuditRetentionClass, number | null> {
    return {
      security: this.retentionDays('security'),
      admin: this.retentionDays('admin'),
      business: this.retentionDays('business'),
      ai: this.retentionDays('ai'),
    };
  }

  private integrityDigest(value: unknown, version?: string): string {
    const serialized = stableStringify(value);
    if ((version ?? (this.integritySecret ? 'hmac-sha256-v1' : 'sha256-v1')) === 'hmac-sha256-v1') {
      return createHmac('sha256', this.integritySecret).update(serialized).digest('hex');
    }
    return createHash('sha256').update(serialized).digest('hex');
  }

  private retentionDays(retentionClass: AuditRetentionClass): number | null {
    const value = Number.parseInt(String(this.config.get(`AUDIT_RETENTION_${retentionClass.toUpperCase()}_DAYS`, '')), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private expiryFor(retentionClass: AuditRetentionClass, occurredAt: Date): Date | null {
    const days = this.retentionDays(retentionClass);
    return days ? new Date(occurredAt.getTime() + days * 86_400_000) : null;
  }
}

function compactJson(value: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  const json = stableStringify(value);
  if (Buffer.byteLength(json, 'utf8') <= MAX_JSON_BYTES) return JSON.parse(json) as Prisma.InputJsonValue;
  return {
    truncated: true,
    sha256: createHash('sha256').update(json).digest('hex'),
    originalBytes: Buffer.byteLength(json, 'utf8'),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
