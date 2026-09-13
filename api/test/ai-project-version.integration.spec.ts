import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractService } from '../src/modules/contract/contract.service';
import { ContractFileService } from '../src/modules/contract/contract-file.service';
import { ContractFileProcessor } from '../src/modules/contract/application/contract-file.processor';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import {
  aiProjectVersionSelect,
  aiProjectVersionWhere,
  nextProjectVersion,
} from '../src/modules/project/domain/ai-project-version';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('AI 项目版本真实 MySQL CAS', () => {
  let prisma: PrismaClient;
  const projectIds: string[] = [];
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const user = await prisma.user.create({ data: {
      username: `ai-version-test-${randomUUID()}`,
      displayName: '版本并发测试', passwordHash: 'not-a-login-hash', role: 'business',
    } });
    userId = user.id;
  });

  afterAll(async () => {
    try {
      await prisma.contractGenerationRun.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.contractDocument.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.contractFile.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      if (userId) await prisma.user.delete({ where: { id: userId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  const fixture = async () => {
    const project = await prisma.project.create({ data: {
      title: '虚构版本测试', kind: 'consult', route: 'llm', status: '待复核',
      creatorId: userId, ownerId: userId,
    } });
    projectIds.push(project.id);
    return project;
  };

  it('两个已建立旧快照的事务仍分配连续且唯一的合同版本', async () => {
    const project = await fixture();
    const writer = new ContractDocumentWriter();
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const write = (content: string) => prisma.$transaction(async (tx) => {
      await tx.contractDocument.count({ where: { projectId: project.id } });
      if (++ready === 2) release();
      await barrier;
      return writer.create(tx, { projectId: project.id, content, documentType: 'draft' });
    }, { maxWait: 10_000, timeout: 10_000, isolationLevel: 'RepeatableRead' });
    const documents = await Promise.all([write('第一版'), write('第二版')]);
    expect(documents.map(document => document.version).sort()).toEqual([1, 2]);
  });

  it('真实行锁下不同请求键只启动一次生成，失败后同键重试落库', async () => {
    const initial = await fixture();
    const project = await prisma.project.update({ where: { id: initial.id }, data: { kind: 'contract' } });
    const handles: EventEmitter[] = [];
    const service = new ContractService(prisma as any, {
      executeStream: async () => { const handle = new EventEmitter(); handles.push(handle); return handle; },
    } as any, {
      findBySlug: async () => ({ slug: 'approved', name: '测试模板', prompt: '' }),
      readApprovedText: async () => '审定模板正文',
    } as any, new ContractDocumentWriter(), {} as any, {} as any, new ProjectAccessPolicy(), {} as any);
    const actor = { id: userId, role: 'business' as const };
    const requests = ['first', 'second'].map(key => ({
      projectId: project.id, templateSlug: 'approved', idempotencyKey: `${project.id}-${key}`,
      elements: { partyA: '虚构甲方' },
    }));
    const results = await Promise.all(requests.map(dto => service.generateDraft(dto, actor)));
    expect(handles).toHaveLength(1);
    const winner = results.findIndex(result => result.completion);
    expect(results.filter(result => result.reused)).toHaveLength(1);
    handles[0].emit('error', new Error('test upstream failure'));
    await expect(results[winner].completion).rejects.toThrow('AI 合同生成失败');
    const retry = await service.generateDraft(requests[winner], actor);
    expect(handles).toHaveLength(2);
    handles[1].emit('done', { text: '真实事务重试结果' });
    await retry.completion;
    expect(await prisma.contractDocument.count({ where: { projectId: project.id } })).toBe(1);
    expect(await prisma.contractGenerationRun.findUnique({ where: { id: retry.generationRunId } }))
      .toMatchObject({ status: 'succeeded', documentId: expect.any(String) });
    expect(await prisma.project.findUnique({ where: { id: project.id } }))
      .toMatchObject({ status: '待复核', result: '真实事务重试结果', isFailed: false });
  });

  it('并发附件上传按相同锁顺序提交，不在文件外键共享锁上死锁', async () => {
    const project = await fixture();
    const root = await mkdtemp(join(tmpdir(), 'legalos-concurrent-upload-'));
    const previousRoot = process.env.CONTRACT_STORAGE_DIR;
    process.env.CONTRACT_STORAGE_DIR = root;
    const service = new ContractFileService(prisma as any, new ProjectAccessPolicy(),
      new ContractDocumentWriter(), new ContractFileProcessor());
    if (previousRoot === undefined) delete process.env.CONTRACT_STORAGE_DIR;
    else process.env.CONTRACT_STORAGE_DIR = previousRoot;
    try {
      const uploads = await Promise.all(['first.txt', 'second.txt'].map(async name => {
        const path = join(root, name);
        await writeFile(path, '虚构合同正文');
        return { path, filename: name, originalname: name, size: 18, mimetype: 'text/plain' } as Express.Multer.File;
      }));
      await Promise.all(uploads.map(file => service.uploadFile(project.id, file, 'revised', { id: userId, role: 'business' })));
      const documents = await prisma.contractDocument.findMany({ where: { projectId: project.id }, orderBy: { version: 'asc' } });
      expect(documents.map(document => document.version)).toEqual([1, 2]);
      expect(await prisma.contractFile.count({ where: { projectId: project.id } })).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('升级事务已读取申请人后发生并发取消，仍返回冲突而非旧快照成功', async () => {
    const project = await fixture();
    let signalRead!: () => void;
    let continueUpgrade!: () => void;
    const assigneeRead = new Promise<void>(resolve => { signalRead = resolve; });
    const proceed = new Promise<void>(resolve => { continueUpgrade = resolve; });
    const useCase = new EscalateProjectToLegalUseCase({
      project: prisma.project,
      $transaction: (operation: (tx: any) => Promise<unknown>, options: any) => prisma.$transaction(async tx => operation({
        ...tx,
        user: { ...tx.user, findUnique: async (args: any) => {
          const user = await tx.user.findUnique(args);
          signalRead();
          await proceed;
          return user;
        } },
      }), options),
    } as any);
    const upgrade = useCase.execute({ projectId: project.id });
    const assertion = expect(upgrade).rejects.toMatchObject({ status: 409 });
    await assigneeRead;
    try {
      await prisma.project.update({ where: { id: project.id }, data: { status: '已取消' } });
    } finally {
      continueUpgrade();
    }
    await assertion;
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toMatchObject({ route: 'llm', status: '已取消' });
  });

  it('同一快照的两个并发提交只有一个成功；新快照允许正常后续轮次', async () => {
    const project = await fixture();
    const write = (result: string) => prisma.project.updateMany({
      where: aiProjectVersionWhere(project.id, project),
      data: { result, status: '已回传', updatedAt: nextProjectVersion(project) },
    });
    const results = await Promise.all([write('第一候选结果'), write('第二候选结果')]);
    expect(results.map((result) => result.count).sort()).toEqual([0, 1]);

    const next = await prisma.project.findUniqueOrThrow({
      where: { id: project.id }, select: aiProjectVersionSelect,
    });
    expect(next.updatedAt.getTime()).toBeGreaterThan(project.updatedAt.getTime());
    const continuation = await prisma.project.updateMany({
      where: aiProjectVersionWhere(project.id, next),
      data: { result: '后续轮次', updatedAt: nextProjectVersion(next) },
    });
    expect(continuation.count).toBe(1);
  });

  it('人工提交即使保留相同毫秒和 LLM 路由，也不能被旧 AI 快照覆盖', async () => {
    const project = await fixture();
    await prisma.project.update({
      where: { id: project.id },
      data: {
        result: '法务确认结果', status: '已回传', reviewStatus: 'review_completed',
        updatedAt: project.updatedAt,
      },
    });
    const stale = await prisma.project.updateMany({
      where: aiProjectVersionWhere(project.id, project),
      data: { result: '迟到 AI', status: '待处理', updatedAt: nextProjectVersion(project) },
    });
    expect(stale.count).toBe(0);
    const retained = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(retained).toMatchObject({
      result: '法务确认结果', status: '已回传', reviewStatus: 'review_completed', route: 'llm',
    });
  });
});
