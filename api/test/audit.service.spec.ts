import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/common/audit/audit.service';

function makeService(configValues: Record<string, string> = {}) {
  const prisma: any = {
    auditEvent: {
      create: vi.fn(async ({ data }: any) => ({ id: 'db-1', ...data })),
    },
  };
  const config = { get: (key: string, fallback?: unknown) => configValues[key] ?? fallback };
  return { service: new AuditService(prisma, config as any), prisma };
}

describe('AuditService', () => {
  it('配置 HMAC 后拒绝可被数据库写入者重算的普通 SHA 事件和未知算法', async () => {
    const { service: unsigned } = makeService();
    const { service: signed } = makeService({ AUDIT_HMAC_SECRET: 'integrity-secret' });
    const event = await unsigned.record({
      action: 'member.bind', resourceType: 'member', outcome: 'success', retentionClass: 'admin',
    });
    expect(unsigned.verifyEvent(event)).toBe(true);
    expect(signed.verifyEvent(event)).toBe(false);
    expect(unsigned.verifyEvent({ ...event, hashVersion: 'unknown' })).toBe(false);
    expect(unsigned.verifyEvent({ ...event, eventHash: 'invalid' })).toBe(false);
  });
  it('生成可复核 HMAC，修改事件后完整性校验失败', async () => {
    const { service, prisma } = makeService({
      AUDIT_HMAC_SECRET: 'test-integrity-secret',
      AUDIT_FINGERPRINT_SALT: 'test-fingerprint-salt',
      AUDIT_RETENTION_ADMIN_DAYS: '365',
    });
    const event = await service.record({
      eventId: 'event-member-bind-1',
      occurredAt: new Date('2026-08-27T00:00:00.000Z'),
      actor: { id: 'admin-1', role: 'admin' },
      action: 'member.bind',
      resourceType: 'member',
      resourceId: 'user-1',
      outcome: 'success',
      request: { requestId: 'request-123456', ip: '192.168.1.2', userAgent: 'Edge/1' },
      before: { dingtalkBound: false },
      after: { dingtalkBound: true },
      changes: { dingtalkBound: { from: false, to: true } },
      retentionClass: 'admin',
    });

    expect(event.hashVersion).toBe('hmac-sha256-v1');
    expect(event.expiresAt.toISOString()).toBe('2027-08-27T00:00:00.000Z');
    expect(event.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(prisma.auditEvent.create.mock.calls[0][0])).not.toContain('192.168.1.2');
    expect(service.verifyEvent(event)).toBe(true);
    expect(service.verifyEvent({ ...event, outcome: 'failed' })).toBe(false);
  });

  it('超大 metadata 只保存摘要，不把原文写入审计表', async () => {
    const { service } = makeService({ AUDIT_HMAC_SECRET: 'secret' });
    const event = await service.record({
      action: 'ai.run.succeeded',
      resourceType: 'consultation_run',
      outcome: 'success',
      metadata: { prompt: '敏感正文'.repeat(20_000) },
      retentionClass: 'ai',
    });
    expect(event.metadata).toMatchObject({ truncated: true, originalBytes: expect.any(Number) });
    expect(event.metadata).not.toHaveProperty('prompt');
    expect(service.verifyEvent(event)).toBe(true);
  });
});
