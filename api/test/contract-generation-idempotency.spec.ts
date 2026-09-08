import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ContractService } from '../src/modules/contract/contract.service';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

const ACTOR = { id: 'u-biz', role: 'business' as const };
const TEMPLATE = { slug: 'verify-template', name: '验证模板', prompt: '只输出合同正文。' };
const VERSION_FIELDS = {
  updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  result: null,
  reviewStatus: null,
  legalBpId: null,
};

/** DshService.executeStream 的语义化事件句柄 mock（'text'/'done'/'cancelled'/'error'） */
const makeHandle = () => new EventEmitter();

describe('ContractService.generateDraft 生成流幂等与状态保护', () => {
  let prisma: any;
  let dsh: any;
  let service: ContractService;

  beforeEach(() => {
    prisma = {
      project: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      projectMessage: { create: vi.fn() },
      contractGenerationRun: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      contractDocument: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'document-created' }),
      },
      projectEvent: { create: vi.fn() },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    dsh = { executeStream: vi.fn() };
    service = new ContractService(
      prisma as any,
      dsh as any,
      { findBySlug: vi.fn().mockResolvedValue(TEMPLATE) } as any,
      new ContractDocumentWriter(),
      { sendNotification: vi.fn() } as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { execute: vi.fn() } as any,
    );
  });

  it('已有处理中运行记录只返回状态，不追加消息、不启动第二条流', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-running', kind: 'contract', status: '分析中', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue({
      id: 'generation-running', status: 'running', documentId: null,
    });

    const result = await service.generateDraft({
      projectId: 'project-running', templateSlug: TEMPLATE.slug,
      elements: { partyA: '甲方' },
    }, ACTOR);

    expect(result).toMatchObject({ projectId: 'project-running', reused: true, status: '分析中' });
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
    expect(dsh.executeStream).not.toHaveBeenCalled();
  });

  it('已有已完成运行记录只复用文档，不重新启动 AI 执行', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-done', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue({
      id: 'generation-done', status: 'succeeded', documentId: 'document-1',
    });

    const result = await service.generateDraft({
      projectId: 'project-done', templateSlug: TEMPLATE.slug,
      elements: { partyA: '甲方' },
    }, ACTOR);

    expect(result).toMatchObject({
      projectId: 'project-done', reused: true, status: '待复核',
      generationRunId: 'generation-done', documentId: 'document-1',
    });
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
    expect(dsh.executeStream).not.toHaveBeenCalled();
  });

  it('人工已完成的合同工单拒绝继续生成新版本', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-human-done', kind: 'contract', status: '已回传', route: 'llm',
      reviewStatus: 'review_completed', result: '人工法务结论',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });

    await expect(service.generateDraft({
      projectId: 'project-human-done', templateSlug: TEMPLATE.slug,
      elements: { partyA: '甲方', clauses: '不应继续生成' },
    }, ACTOR)).rejects.toThrow('已人工办结');
    expect(prisma.contractGenerationRun.create).not.toHaveBeenCalled();
    expect(dsh.executeStream).not.toHaveBeenCalled();
  });

  it('已完成项目使用新要素指纹时允许生成新版本，但先 claim 生成运行', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-versioned', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue(null);
    prisma.contractGenerationRun.create.mockResolvedValue({
      id: 'generation-v2', status: 'running', documentId: null,
    });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);

    const result = await service.generateDraft({
      projectId: 'project-versioned', templateSlug: TEMPLATE.slug,
      elements: { partyA: '甲方', clauses: '新增版本条款' },
    }, ACTOR);

    expect(result).toMatchObject({ projectId: 'project-versioned', generationRunId: 'generation-v2' });
    expect(prisma.contractGenerationRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: 'project-versioned', status: 'running' }),
    }));
    expect(dsh.executeStream).toHaveBeenCalledTimes(1);
  });

  it('completion 在交易落库完成前不解决，落库后 run 才为 succeeded', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-delayed', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue(null);
    prisma.contractGenerationRun.create.mockResolvedValue({ id: 'generation-delayed', status: 'running' });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    prisma.$transaction.mockImplementation(async (callback: any) => {
      await transactionGate;
      return callback(prisma);
    });

    const result = await service.generateDraft({
      projectId: 'project-delayed', templateSlug: TEMPLATE.slug, elements: { partyA: '甲方' },
    }, ACTOR);
    let completed = false;
    void result.completion!.then(() => { completed = true; });
    handle.emit('done', { text: '合同正文' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);

    releaseTransaction();
    await expect(result.completion).resolves.toMatchObject({ generationRunId: 'generation-delayed' });
    expect(prisma.contractGenerationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'generation-delayed', status: 'running' }),
      data: expect.objectContaining({ status: 'succeeded' }),
    }));
    expect(prisma.contractGenerationRun.update).toHaveBeenCalledWith({
      where: { id: 'generation-delayed' },
      data: { documentId: 'document-created' },
    });
  });

  it('落库失败时 completion 拒绝并将运行置为 failed', async () => {
    prisma.project.findUnique.mockResolvedValue({
      ...VERSION_FIELDS,
      id: 'project-failed', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue(null);
    prisma.contractGenerationRun.create.mockResolvedValue({ id: 'generation-failed', status: 'running' });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);
    prisma.$transaction.mockRejectedValueOnce(new Error('database unavailable with private detail'));

    const result = await service.generateDraft({
      projectId: 'project-failed', templateSlug: TEMPLATE.slug, elements: { partyA: '甲方' },
    }, ACTOR);
    handle.emit('done', { text: '不应伪成功的合同' });
    await expect(result.completion).rejects.toThrow('database unavailable');
    expect(prisma.contractGenerationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'generation-failed', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', errorMessage: '合同草稿写入失败' }),
    }));
  });

  it('人工回传与草稿成功交错时保留人工结果，迟到运行置为 cancelled', async () => {
    const projectState: any = {
      ...VERSION_FIELDS,
      id: 'project-race', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    };
    let runStatus = 'running';
    prisma.project.findUnique.mockImplementation(async () => ({ ...projectState }));
    prisma.project.updateMany.mockImplementation(async ({ where, data }: any) => {
      const matches = where.id === projectState.id
        && where.updatedAt.getTime() === projectState.updatedAt.getTime()
        && ['route', 'status', 'result', 'reviewStatus', 'ownerId', 'legalBpId']
          .every((key) => where[key] === projectState[key]);
      if (!matches) return { count: 0 };
      Object.assign(projectState, data);
      return { count: 1 };
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue(null);
    prisma.contractGenerationRun.create.mockResolvedValue({ id: 'generation-race', status: 'running' });
    prisma.contractGenerationRun.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== 'generation-race' || where.status !== runStatus) return { count: 0 };
      runStatus = data.status;
      return { count: 1 };
    });
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const before = runStatus;
      try {
        return await callback(prisma);
      } catch (error) {
        runStatus = before;
        throw error;
      }
    });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);

    const result = await service.generateDraft({
      projectId: 'project-race', templateSlug: TEMPLATE.slug, elements: { partyA: '甲方' },
    }, ACTOR);
    Object.assign(projectState, {
      status: '已回传',
      result: '人工法务结论',
      reviewStatus: 'review_completed',
      updatedAt: new Date('2026-09-08T00:00:01.000Z'),
    });
    handle.emit('done', { text: '迟到合同草稿' });

    await expect(result.completion).rejects.toThrow('迟到结果未写入');
    expect(projectState).toMatchObject({
      status: '已回传', result: '人工法务结论', reviewStatus: 'review_completed',
    });
    expect(runStatus).toBe('cancelled');
    expect(prisma.contractDocument.create).not.toHaveBeenCalled();
    expect(prisma.projectMessage.create.mock.calls).not.toContainEqual([
      expect.objectContaining({ data: expect.objectContaining({ role: 'assistant' }) }),
    ]);
    expect(prisma.projectEvent.create).not.toHaveBeenCalled();
  });

  it('人工回传与草稿失败交错时不复活工单，失败运行不悬挂', async () => {
    const projectState: any = {
      ...VERSION_FIELDS,
      id: 'project-failure-race', kind: 'contract', status: '待复核', route: 'llm',
      creatorId: ACTOR.id, ownerId: ACTOR.id,
    };
    let runStatus = 'running';
    prisma.project.findUnique.mockImplementation(async () => ({ ...projectState }));
    prisma.project.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.updatedAt.getTime() !== projectState.updatedAt.getTime()
        || where.status !== projectState.status
        || where.reviewStatus !== projectState.reviewStatus) return { count: 0 };
      Object.assign(projectState, data);
      return { count: 1 };
    });
    prisma.contractGenerationRun.findUnique.mockResolvedValue(null);
    prisma.contractGenerationRun.create.mockResolvedValue({ id: 'generation-failure-race', status: 'running' });
    prisma.contractGenerationRun.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== 'generation-failure-race' || where.status !== runStatus) return { count: 0 };
      runStatus = data.status;
      return { count: 1 };
    });
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const before = runStatus;
      try {
        return await callback(prisma);
      } catch (error) {
        runStatus = before;
        throw error;
      }
    });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);

    const result = await service.generateDraft({
      projectId: 'project-failure-race', templateSlug: TEMPLATE.slug, elements: { partyA: '甲方' },
    }, ACTOR);
    Object.assign(projectState, {
      status: '已回传', result: '人工法务结论', reviewStatus: 'review_completed',
      updatedAt: new Date('2026-09-08T00:00:01.000Z'),
    });
    handle.emit('error', new Error('AI 上游失败'));

    await expect(result.completion).rejects.toThrow('AI 合同生成失败或超时');
    expect(projectState).toMatchObject({ status: '已回传', result: '人工法务结论' });
    expect(runStatus).toBe('cancelled');
    expect(prisma.projectEvent.create).not.toHaveBeenCalled();
  });
});
