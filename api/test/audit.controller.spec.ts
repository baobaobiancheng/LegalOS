import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuditController } from '../src/common/audit/audit.controller';
import { AuditQueryDto } from '../src/common/audit/dto/audit-query.dto';

describe('AuditController', () => {
  it('stats 按 action/outcome/reasonCode 分组，并复用访问范围与筛选条件', async () => {
    const prisma: any = {
      auditEvent: {
        groupBy: vi.fn().mockResolvedValue([
          { action: 'authorization.denied', outcome: 'denied', reasonCode: 'FORBIDDEN', _count: { _all: 3 } },
          { action: 'auth.login.failed', outcome: 'denied', reasonCode: 'UNAUTHORIZED', _count: { _all: 2 } },
        ]),
      },
    };
    const audit: any = { record: vi.fn().mockResolvedValue({}) };
    const controller = new AuditController(prisma, audit);
    const query = Object.assign(new AuditQueryDto(), { outcome: 'denied', reasonCode: 'FORBIDDEN' });
    const request: any = { requestId: 'request-stats-1', headers: {}, ip: '127.0.0.1' };

    const result = await controller.stats(query, 'lead-1', Role.legal_lead, request);

    expect(prisma.auditEvent.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        retentionClass: { in: ['business', 'ai'] },
        outcome: 'denied',
        reasonCode: 'FORBIDDEN',
      }),
    }));
    expect(result).toEqual({
      total: 5,
      groups: [
        { action: 'authorization.denied', outcome: 'denied', reasonCode: 'FORBIDDEN', count: 3 },
        { action: 'auth.login.failed', outcome: 'denied', reasonCode: 'UNAUTHORIZED', count: 2 },
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'audit.read',
      resourceType: 'audit_event_stats',
    }));
  });
});
