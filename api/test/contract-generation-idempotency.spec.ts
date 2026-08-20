import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ContractService } from '../src/modules/contract/contract.service';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

const ACTOR = { id: 'u-biz', role: 'business' as const };
const TEMPLATE = { slug: 'verify-template', name: '验证模板', prompt: '只输出合同正文。' };

/** DshService.executeStream 的语义化事件句柄 mock（'text'/'done'/'cancelled'/'error'） */
const makeHandle = () => new EventEmitter();

describe('ContractService.generateDraft 生成流幂等与状态保护', () => {
  let prisma: any;
  let dsh: any;
  let service: ContractService;

  beforeEach(() => {
    prisma = {
      project: { findUnique: vi.fn() },
      projectMessage: { create: vi.fn() },
      contractGenerationRun: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      contractDocument: { count: vi.fn(), create: vi.fn() },
      projectEvent: { create: vi.fn() },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    dsh = { executeStream: vi.fn() };
    service = new ContractService(
      prisma as any,
      dsh as any,
      { findBySlug: vi.fn().mockResolvedValue(TEMPLATE) } as any,
      {} as any,
      { sendNotification: vi.fn() } as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { execute: vi.fn() } as any,
    );
  });

  it('已有处理中运行记录只返回状态，不追加消息、不启动第二条流', async () => {
    prisma.project.findUnique.mockResolvedValue({
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

  it('已完成项目使用新要素指纹时允许生成新版本，但先 claim 生成运行', async () => {
    prisma.project.findUnique.mockResolvedValue({
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
});

