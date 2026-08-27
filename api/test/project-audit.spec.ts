import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';

describe('ProjectService 平台审计', () => {
  let prisma: any;
  let audit: any;
  let service: ProjectService;
  const baseProject = {
    id: 'p-1', creatorId: 'biz-1', ownerId: 'bp-1', legalBpId: 'bp-1',
    status: '待复核', risk: 'P1', route: 'legalbp', result: null, dingtalkChatId: null,
  };

  beforeEach(() => {
    prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue(baseProject),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      projectMessage: { create: vi.fn().mockResolvedValue({ id: 'legal-message-1' }), findFirst: vi.fn() },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      user: { findUnique: vi.fn(), findFirst: vi.fn() },
      outboxEvent: { create: vi.fn() },
      $transaction: vi.fn(async (arg: any) => typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
    };
    audit = {
      record: vi.fn().mockResolvedValue({ eventId: 'audit-human-1' }),
      digestCanonical: vi.fn((value: unknown) => `hash:${String(value)}`),
    };
    service = new ProjectService(
      prisma,
      { assess: vi.fn() } as any,
      { writeBack: vi.fn() } as any,
      { sendNotification: vi.fn() } as any,
      {} as any,
      new ProjectAccessPolicy(),
      {} as any,
      new ProjectStateMachine(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      audit,
    );
  });

  it('取消工单时，状态变更、时间线和 before/after 审计同事务提交', async () => {
    await service.cancel(
      'p-1',
      { id: 'biz-1', role: 'business' },
      { requestId: 'request-cancel-1' },
    );

    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: '已取消' },
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.cancel',
      actor: { id: 'biz-1', role: 'business' },
      before: expect.objectContaining({ status: '待复核' }),
      after: expect.objectContaining({ status: '已取消' }),
      changes: { status: { from: '待复核', to: '已取消' } },
    }), prisma);
  });

  it('法务回传关联最近 AI Run，并把人工审计 eventId 回写到 Run', async () => {
    const updatedProject = { ...baseProject, status: '已回传', result: '人工结论' };
    prisma.project.findUnique
      .mockResolvedValueOnce(baseProject)
      .mockResolvedValueOnce(updatedProject);
    prisma.consultationRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'succeeded', dshSessionId: 'dsh-1',
      modelVersion: 'glm-5-2', outputHash: 'ai-output-hash',
    });

    await service.reply(
      'p-1',
      { text: '人工结论' },
      { id: 'bp-1', role: 'legal_bp' },
      { requestId: 'request-reply-1' },
    );

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.reply',
      correlationId: 'run-1',
      metadata: expect.objectContaining({
        consultationRunId: 'run-1',
        dshSessionId: 'dsh-1',
        modelVersion: 'glm-5-2',
        aiOutputHash: 'ai-output-hash',
      }),
    }), prisma);
    expect(prisma.consultationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { humanAuditEventId: 'audit-human-1' },
    });
  });
});
