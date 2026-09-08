import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  aiProjectVersionSelect,
  aiProjectVersionWhere,
  nextProjectVersion,
} from '../src/modules/project/domain/ai-project-version';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('AI 项目版本真实 MySQL CAS', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const projectIds: string[] = [];
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: {
      username: `ai-version-test-${randomUUID()}`,
      displayName: '版本并发测试', passwordHash: 'not-a-login-hash', role: 'business',
    } });
    userId = user.id;
  });

  afterAll(async () => {
    try {
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
