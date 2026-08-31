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
      contractFile: { findFirst: vi.fn() },
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

  it('CRM 合同任务完成时只标记内部审核完成，交付状态为 pending 并事务内入队', async () => {
    const crmProject = {
      ...baseProject,
      sourceAppId: 'crm-legal',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
    };
    const updatedProject = {
      ...crmProject,
      status: '已回传',
      result: '人工结论',
      reviewStatus: 'review_completed',
      crmDeliveryStatus: 'pending',
      crmDeliveryFileId: 'file-final-1',
    };
    prisma.project.findUnique
      .mockResolvedValueOnce(crmProject)
      .mockResolvedValueOnce(updatedProject);
    prisma.contractFile.findFirst.mockResolvedValue({ id: 'file-final-1' });
    prisma.consultationRun.findFirst.mockResolvedValue(null);

    const result = await service.reply(
      'p-1',
      { text: '人工结论', deliveryFileId: 'file-final-1' },
      { id: 'bp-1', role: 'legal_bp' },
      { requestId: 'request-crm-reply-1' },
    );

    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: '已回传',
        reviewStatus: 'review_completed',
        reviewCompletedAt: expect.any(Date),
        crmDeliveryStatus: 'pending',
        crmDeliveredAt: null,
        crmDeliveryFileId: 'file-final-1',
      }),
    }));
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'crm.review-result.deliver',
        aggregateId: 'p-1',
        payload: { projectId: 'p-1', contractFileId: 'file-final-1' },
      }),
    }));
    expect(result).toEqual({
      status: '已回传',
      reviewStatus: 'review_completed',
      crmDeliveryStatus: 'pending',
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.objectContaining({
        crmDeliveryFileId: { from: null, to: 'file-final-1' },
      }),
    }), prisma);
  });

  it('CRM 合同任务未明确选择法务确认文件时拒绝完成', async () => {
    const crmProject = {
      ...baseProject,
      sourceAppId: 'crm-legal',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
    };
    prisma.project.findUnique.mockResolvedValue(crmProject);

    await expect(service.reply(
      'p-1',
      { text: '人工结论' },
      { id: 'bp-1', role: 'legal_bp' },
    )).rejects.toThrow('必须明确选择法务确认的回传文件');
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('CRM 回传文件不是法务角色上传的权威版本时拒绝完成', async () => {
    const crmProject = {
      ...baseProject,
      sourceAppId: 'crm-legal',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
    };
    prisma.project.findUnique.mockResolvedValue(crmProject);
    prisma.contractFile.findFirst.mockResolvedValue(null);

    await expect(service.reply(
      'p-1',
      { text: '人工结论', deliveryFileId: 'business-file-1' },
      { id: 'bp-1', role: 'legal_bp' },
    )).rejects.toThrow('未经法务角色上传确认');
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
