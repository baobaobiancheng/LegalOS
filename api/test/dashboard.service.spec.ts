import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';

describe('DashboardService', () => {
  let prisma: any;
  let service: DashboardService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T02:00:00.000Z'));
    prisma = {
      project: {
        count: vi.fn()
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(9)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(20)
          .mockResolvedValueOnce(11)
          .mockResolvedValueOnce(4),
        groupBy: vi.fn().mockResolvedValue([
          { legalBpId: 'legal-1', _count: { _all: 8 } },
          { legalBpId: 'legal-2', _count: { _all: 3 } },
        ]),
        findMany: vi.fn().mockResolvedValue([{ id: 'project-1', title: '供应商合同审查' }]),
      },
      user: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'legal-1', displayName: '彭宇欣' },
            { id: 'legal-2', displayName: '王珺' },
          ])
          .mockResolvedValueOnce([{ id: 'admin-1', displayName: '系统管理员' }]),
      },
      auditEvent: {
        count: vi.fn().mockResolvedValue(2),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            action: 'project.transfer',
            actorId: 'admin-1',
            projectId: 'project-1',
            outcome: 'success',
            occurredAt: new Date('2026-08-28T01:30:00.000Z'),
          },
        ]),
      },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ day: '2026-08-28', total: 3 }])
        .mockResolvedValueOnce([{ day: '2026-08-28', total: 1 }]),
    };
    service = new DashboardService(prisma);
  });

  afterEach(() => vi.useRealTimers());

  it('聚合核心指标、日趋势、法务负载和平台动态', async () => {
    const result = await service.overview(7);

    expect(result.summary).toEqual({
      createdToday: 3,
      pending: 9,
      highRisk: 2,
      aiHandlingRate: 55,
    });
    expect(result.trend).toHaveLength(7);
    expect(result.trend[0]).toEqual({ date: '2026-08-22', created: 0, returned: 0 });
    expect(result.trend[6]).toEqual({ date: '2026-08-28', created: 3, returned: 1 });
    expect(result.attention).toEqual({ highRisk: 2, stale: 4, evidenceFailures: 2 });
    expect(result.workload).toEqual([
      { id: 'legal-1', name: '彭宇欣', count: 8, level: 'busy' },
      { id: 'legal-2', name: '王珺', count: 3, level: 'idle' },
    ]);
    expect(result.activities[0]).toMatchObject({
      id: 'audit-1',
      tone: 'info',
      text: '系统管理员转派了“供应商合同审查”',
    });
  });

  it('只统计处理中状态作为待处理、高风险和久未更新口径', async () => {
    await service.overview(30);

    expect(prisma.project.count).toHaveBeenNthCalledWith(2, {
      where: { status: { in: ['分析中', '待处理', '待复核'] } },
    });
    expect(prisma.project.count).toHaveBeenNthCalledWith(3, {
      where: { risk: 'P0', status: { in: ['分析中', '待处理', '待复核'] } },
    });
    expect(prisma.project.count).toHaveBeenNthCalledWith(6, {
      where: {
        status: { in: ['分析中', '待处理', '待复核'] },
        updatedAt: { lt: new Date('2026-08-27T02:00:00.000Z') },
      },
    });
    expect(prisma.auditEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: [
          { action: { in: ['ai.legal_research.degraded', 'ai.legal_research.failed', 'ai.run.degraded'] } },
          { action: 'ai.run.failed', reasonCode: { startsWith: 'RESEARCH_' } },
        ],
      }),
    });
  });

  it('按完成审计事件统计回传趋势，避免后续转派改写回传日期', async () => {
    await service.overview(7);

    const returnedTrendQuery = prisma.$queryRaw.mock.calls[1][0];
    const sql = returnedTrendQuery.strings.join(' ');
    expect(sql).toContain('FROM audit_events');
    expect(sql).toContain("action = 'project.reply'");
    expect(sql).toContain("action = 'ai.run.succeeded'");
    expect(sql).toContain("action = 'ai.run.degraded'");
    expect(sql).not.toContain('updated_at');
  });
});
