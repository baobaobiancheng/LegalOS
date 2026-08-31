import { describe, expect, it, vi } from 'vitest';
import {
  CreateProjectUseCase,
  crmTaskIdempotencyKey,
} from '../src/modules/project/application/create-project.use-case';

describe('CRM 任务主键与幂等命名空间', () => {
  const payloadSha256 = 'a'.repeat(64);
  const fileManifestSha256 = 'b'.repeat(64);

  it('以 sourceAppId + crmTaskId 派生幂等键，并分别持久化任务 ID 与合同号', async () => {
    const project = { id: 'p-1', creatorId: 'crm-service-user' };
    const prisma: any = {
      project: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(project),
      },
      projectMessage: { create: vi.fn() },
      projectEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
      riskAssessmentLog: { create: vi.fn() },
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
    const useCase = new CreateProjectUseCase(prisma);

    const result = await useCase.execute({
      kind: 'contract',
      title: '待审核合同',
      input: '合同正文',
      creatorId: 'crm-service-user',
      risk: 'P1',
      route: 'legalbp',
      legalBpId: 'bp-1',
      sourceAppId: 'crm-legal-01',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
      crmPayloadSha256: payloadSha256,
      crmFileManifestSha256: fileManifestSha256,
      idempotencyKey: 'task-10086',
    });

    expect(result).toEqual({ project, created: true });
    expect(prisma.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceAppId: 'crm-legal-01',
        crmTaskId: 'task-10086',
        contractNo: 'HT-2026-001',
        crmPayloadSha256: payloadSha256,
        crmFileManifestSha256: fileManifestSha256,
        idempotencyKey: crmTaskIdempotencyKey('crm-legal-01', 'task-10086'),
      }),
    }));
  });

  it('同一 CRM 任务只有请求指纹一致时才作为幂等重放返回', async () => {
    const existing = {
      id: 'p-1',
      creatorId: 'crm-service-user',
      crmPayloadSha256: payloadSha256,
      crmFileManifestSha256: fileManifestSha256,
    };
    const prisma: any = { project: { findUnique: vi.fn().mockResolvedValue(existing) } };
    const useCase = new CreateProjectUseCase(prisma);
    const baseCommand = {
      kind: 'contract' as const,
      title: '待审核合同',
      input: '合同正文',
      creatorId: 'crm-service-user',
      risk: 'P1' as const,
      route: 'legalbp' as const,
      legalBpId: 'bp-1',
      sourceAppId: 'crm-legal-01',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
      crmPayloadSha256: payloadSha256,
      crmFileManifestSha256: fileManifestSha256,
    };

    await expect(useCase.execute(baseCommand)).resolves.toEqual({ project: existing, created: false });
    await expect(useCase.execute({
      ...baseCommand,
      crmFileManifestSha256: 'c'.repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    });
  });

  it('CRM 任务缺少合法请求指纹时拒绝建单', async () => {
    const useCase = new CreateProjectUseCase({} as any);
    await expect(useCase.execute({
      kind: 'contract',
      title: '待审核合同',
      input: '合同正文',
      creatorId: 'crm-service-user',
      risk: 'P1',
      route: 'legalbp',
      legalBpId: null,
      sourceAppId: 'crm-legal-01',
      crmTaskId: 'task-10086',
      contractNo: 'HT-2026-001',
    })).rejects.toThrow('payload/file manifest SHA-256');
  });

  it('CRM 业务标识不完整时拒绝建单', async () => {
    const useCase = new CreateProjectUseCase({} as any);
    await expect(useCase.execute({
      kind: 'contract',
      title: '待审核合同',
      input: '合同正文',
      creatorId: 'crm-service-user',
      risk: 'P1',
      route: 'legalbp',
      legalBpId: null,
      sourceAppId: 'crm-legal-01',
      crmTaskId: 'task-10086',
    })).rejects.toThrow('CRM 工单必须同时提供');
  });
});
