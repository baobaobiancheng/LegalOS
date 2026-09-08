import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';

/**
 * 人工升级专用接口（review 2026-08-12 P0）：
 * - 创建者升级成功；其他 business 403；已取消不能升级；已完成 AI 答案可升级
 * - 已是法务流程幂等返回 200；只产生一个 Outbox + 一条升级事件
 * - 不产生用户消息、不启动模型、不建 ConsultationRun
 */

function makeTransaction(prisma: any) {
  prisma.$transaction = vi.fn(async (arg: any) => {
    if (typeof arg === 'function') {
      const tx = {
        project: prisma.project,
        projectMessage: prisma.projectMessage,
        projectEvent: prisma.projectEvent,
        outboxEvent: prisma.outboxEvent,
        bpDomainMap: prisma.bpDomainMap,
        user: prisma.user,
      };
      return arg(tx);
    }
    return arg;
  });
}

function mockProject(over: any = {}) {
  return {
    id: 'p-1',
    kind: 'consult',
    route: 'llm',
    status: '待处理',
    risk: 'P2',
    creatorId: 'u-owner',
    ownerId: 'u-owner',
    legalBpId: null,
    ...over,
  };
}

describe('ProjectService.escalate（人工升级接口）', () => {
  let service: ProjectService;
  let prisma: any;
  let escalateUseCase: EscalateProjectToLegalUseCase;

  beforeEach(() => {
    prisma = {
      skill: { findFirst: vi.fn() },
      project: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
      projectMessage: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
      projectEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
      bpDomainMap: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn() },
      consultationRun: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    };
    makeTransaction(prisma);
    prisma.project.updateMany.mockResolvedValue({ count: 1 });
    prisma.project.findUnique.mockResolvedValue(mockProject());
    escalateUseCase = new EscalateProjectToLegalUseCase(prisma as any);

    service = new ProjectService(
      prisma as any,
      { assess: vi.fn() } as any,
      { createGroup: vi.fn(), addMember: vi.fn(), sendNotification: vi.fn(), syncContacts: vi.fn() } as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { findAll: vi.fn(), findOne: vi.fn() } as any,
      new ProjectStateMachine() as any,
      { execute: vi.fn() } as any,
      escalateUseCase as any,
      { claimRun: vi.fn(), reply: vi.fn(), buildRiskInput: vi.fn(async (t: string) => t) } as any,
      { validateForUser: vi.fn(), bind: vi.fn(), getTexts: vi.fn(), upload: vi.fn() } as any,
    );
  });

  it('创建者升级成功：返回 upgraded=true/legalbp/待复核，写一条事件 + 一个 Outbox', async () => {
    const result = await service.escalate('p-1', { id: 'u-owner', role: 'business' });

    expect(result).toEqual({ upgraded: true, route: 'legalbp', status: '待复核' });
    expect(prisma.projectEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('其他 business 用户返回 403', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ creatorId: 'u-owner' }));

    await expect(service.escalate('p-1', { id: 'u-other', role: 'business' })).rejects.toMatchObject({
      response: { statusCode: 403 },
    });
  });

  it('重复升级（已是法务流程）幂等返回 200，不再写事件/Outbox', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ route: 'legalbp', status: '待复核' }));

    const result = await service.escalate('p-1', { id: 'u-owner', role: 'business' });

    expect(result.upgraded).toBe(false);
    expect(prisma.projectEvent.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('已完成 AI 答案的 P2 工单仍允许升级', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ status: '已回传' }));

    const result = await service.escalate('p-1', { id: 'u-owner', role: 'business' });
    expect(result.upgraded).toBe(true);
  });

  it('已取消工单不能升级（403）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ status: '已取消' }));

    await expect(service.escalate('p-1', { id: 'u-owner', role: 'business' })).rejects.toMatchObject({
      response: { statusCode: 403 },
    });
  });

  it('升级不产生用户消息、不启动模型、不建 ConsultationRun', async () => {
    await service.escalate('p-1', { id: 'u-owner', role: 'business' });

    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
    expect(prisma.consultationRun.create).not.toHaveBeenCalled();
  });

  it('lead/admin 可升级任意工单', async () => {
    const result = await service.escalate('p-1', { id: 'u-lead', role: 'legal_lead' });
    expect(result.upgraded).toBe(true);
  });

  it('显式指定已停用法务时拒绝升级，不写事件或 Outbox', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-disabled', displayName: '已停用法务', role: 'legal_bp', isActive: false,
    });

    await expect(escalateUseCase.execute({
      projectId: 'p-1', legalBpId: 'u-disabled', status: '待复核', eventTexts: ['不应写入'],
    })).rejects.toThrow('账号须启用');
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.projectEvent.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
