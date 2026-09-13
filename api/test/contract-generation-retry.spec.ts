import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Prisma } from '@prisma/client';
import { ContractService } from '../src/modules/contract/contract.service';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

const actor = { id: 'business-1', role: 'business' as const };
const dto = { projectId: 'p1', idempotencyKey: 'request-1', templateSlug: 'approved', elements: { partyA: '虚构甲方' } };

function fixture() {
  const project: any = {
    id: 'p1', kind: 'contract', route: 'llm', status: '待处理', creatorId: actor.id, ownerId: actor.id,
    legalBpId: null, reviewStatus: null, result: null, updatedAt: new Date('2026-09-01'),
  };
  const runs: any[] = [];
  const matches = (row: any, where: any) => Object.entries(where).every(([key, expected]) =>
    expected instanceof Date ? row[key]?.getTime() === expected.getTime() : row[key] === expected);
  const updateMany = (rows: any[]) => vi.fn(async ({ where, data }: any) => {
    const matched = rows.filter(row => matches(row, where));
    matched.forEach(row => Object.assign(row, data));
    return { count: matched.length };
  });
  const prisma: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    project: {
      findUnique: vi.fn(async () => ({ ...project })), findUniqueOrThrow: vi.fn(async () => ({ ...project })),
      updateMany: updateMany([project]),
    },
    contractGenerationRun: {
      findUnique: vi.fn(async ({ where }: any) => runs.find(run => run.requestKey === where.requestKey) ?? null),
      findFirst: vi.fn(async ({ where }: any) => runs.find(run => run.projectId === where.projectId && where.status.in.includes(run.status)) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const run = { id: `run-${runs.length + 1}`, documentId: null, ...data };
        runs.push(run);
        return { ...run };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const run = runs.find(run => run.id === where.id);
        Object.assign(run, data);
        return { ...run };
      }),
      updateMany: updateMany(runs),
    },
    contractDocument: { create: vi.fn().mockResolvedValue({ id: 'doc-1' }) },
    projectMessage: { create: vi.fn() }, projectEvent: { create: vi.fn() },
  };
  let tail = Promise.resolve();
  prisma.$transaction = vi.fn((operation: (tx: any) => Promise<unknown>) => {
    const pending = tail.then(() => operation(prisma));
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  });
  const handles: EventEmitter[] = [];
  const dsh = { executeStream: vi.fn(async () => {
    const handle = new EventEmitter(); handles.push(handle); return handle;
  }) };
  const service = new ContractService(prisma, dsh as any,
    { findBySlug: vi.fn().mockResolvedValue({ slug: 'approved', prompt: '甲方 {partyA}', name: '审定模板' }),
      readApprovedText: vi.fn().mockResolvedValue('唯一审定条款正文') } as any,
    new ContractDocumentWriter(), {} as any,
    { findExistingByIdempotencyKey: vi.fn(async () => ({ ...project })) } as any,
    new ProjectAccessPolicy(), {} as any);
  return { service, prisma, dsh, project, runs, handles };
}

describe('合同生成重试与执行隔离', () => {
  it('跨工单争用唯一请求键返回 409，不启动模型', async () => {
    const f = fixture();
    f.prisma.contractGenerationRun.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      'unique constraint', { code: 'P2002', clientVersion: '6.19.3' },
    ));
    await expect(f.service.generateDraft(dto, actor)).rejects.toMatchObject({ status: 409 });
    expect(f.dsh.executeStream).not.toHaveBeenCalled();
  });
  it('启动失败同步结束 run 和工单；原始建单幂等键可重新执行', async () => {
    const f = fixture();
    f.dsh.executeStream.mockRejectedValueOnce(new Error('queue full with private detail'));
    await expect(f.service.generateDraft(dto, actor)).rejects.toThrow('queue full');
    expect(f.project.status).toBe('待处理');
    expect(f.runs[0]).toMatchObject({ status: 'failed', errorMessage: '合同生成未启动，请重试' });
    const startedAt = f.runs[0].startedAt.getTime();
    const retry = await f.service.generateDraft({ ...dto, projectId: undefined }, actor);
    expect(retry.reused).toBeUndefined();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0].startedAt.getTime()).toBeGreaterThan(startedAt);
    expect(f.dsh.executeStream).toHaveBeenCalledTimes(2);
    expect(f.dsh.executeStream.mock.calls[1][0]).toContain('唯一审定条款正文');
    f.handles[0].emit('done', { text: '完成合同' });
    await retry.completion;
    expect(f.project).toMatchObject({ status: '待复核', isFailed: false, result: '完成合同' });
  });
  it('取消后重试的新运行不接受上一轮迟到回调', async () => {
    const f = fixture();
    const first = await f.service.generateDraft(dto, actor);
    f.handles[0].emit('cancelled');
    await expect(first.completion).rejects.toThrow('已取消');
    const second = await f.service.generateDraft(dto, actor);
    f.handles[0].emit('done', { text: '过期结果' });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.project.result).toBeNull();
    expect(f.runs[0].status).toBe('running');
    f.handles[1].emit('done', { text: '新结果' });
    await second.completion;
    expect(f.project.result).toBe('新结果');
  });
  it('不同请求键并发也只能启动同一工单的一条流', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.generateDraft(dto, actor),
      f.service.generateDraft({ ...dto, idempotencyKey: 'request-2' }, actor),
    ]);
    expect(f.dsh.executeStream).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.reused)).toHaveLength(1);
    f.handles[0].emit('done', { text: '唯一结果' });
    await results.find(result => result.completion)!.completion;
  });
  it('同一请求键更改合同要素返回冲突，不复用错误文档', async () => {
    const f = fixture();
    const first = await f.service.generateDraft(dto, actor);
    await expect(f.service.generateDraft({ ...dto, elements: { partyA: '另一甲方' } }, actor)).rejects.toThrow('不同合同或要素');
    expect(f.dsh.executeStream).toHaveBeenCalledTimes(1);
    f.handles[0].emit('done', { text: '原结果' });
    await first.completion;
  });
});
