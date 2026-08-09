import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * MySQL 集成测试（P1-12 §11.4）：
 * 验证 mock 单测无法覆盖的真实库约束 —— 事务原子性、唯一约束。
 * 需要 `TEST_DATABASE_URL`（CI 的 GitLab masked/protected variable）；
 * 本机无测试库时整组跳过，不影响 `npm run test:unit`。
 *
 * 运行：TEST_DATABASE_URL=mysql://user:pass@host:3306/legalos_test npm run test:integration
 */

// 只认显式的 TEST_DATABASE_URL（CI masked variable），绝不回退到开发库 DATABASE_URL
const DB_URL = process.env.TEST_DATABASE_URL;
const HAS_DB = !!DB_URL;

describe.skipIf(!HAS_DB)('MySQL 集成（事务/唯一约束）', () => {
  let prisma: PrismaClient;
  let seq = 0;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('P1-03/P1-11：Project+首消息+Outbox+RiskLog 可同一事务提交（表结构/外键就绪）', async () => {
    const created = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          username: `it-user-${Date.now()}-${++seq}`,
          passwordHash: 'x',
          displayName: '集成用户',
          role: 'business',
        },
      });
      const p = await tx.project.create({
        data: { kind: 'consult', title: 'it', risk: 'P1', route: 'legalbp', creatorId: u.id, ownerId: u.id },
      });
      await tx.projectMessage.create({ data: { projectId: p.id, role: 'user', text: 't' } });
      await tx.outboxEvent.create({
        data: { eventType: 'test', aggregateType: 'project', aggregateId: p.id, dedupKey: `it:${p.id}`, payload: {}, projectId: p.id },
      });
      await tx.riskAssessmentLog.create({
        data: { projectId: p.id, finalRisk: 'P1', route: 'legalbp', matchedRuleIds: [], classifierVersion: 'test' },
      });
      return p.id;
    });
    expect(created).toBeTruthy();
  });

  it('P1-07：User.dingtalkUserId 唯一约束 → 第二个用户绑同一联系人 P2002', async () => {
    const a = await prisma.user.create({
      data: {
        username: `it-a-${Date.now()}-${++seq}`,
        passwordHash: 'x',
        displayName: 'A',
        role: 'business',
        dingtalkUserId: `DT-${Date.now()}-${seq}`,
      },
    });
    await expect(
      prisma.user.create({
        data: {
          username: `it-b-${Date.now()}-${++seq}`,
          passwordHash: 'x',
          displayName: 'B',
          role: 'business',
          dingtalkUserId: a.dingtalkUserId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('P1-09：SkillReviewLog eventId 唯一约束 → 重复 eventId P2002', async () => {
    const owner = await prisma.user.create({
      data: {
        username: `it-owner-${Date.now()}-${++seq}`,
        passwordHash: 'x',
        displayName: '技能主',
        role: 'legal_bp',
      },
    });
    const skill = await prisma.skill.create({
      data: {
        slug: `it-skill-${Date.now()}-${seq}`,
        name: '集成技能',
        group: '合规法务',
        description: '',
        prompt: 'p',
        visibility: 'pending',
        creatorId: owner.id,
      },
    });
    const eventId = `it:${skill.id}:approve`;
    await prisma.skillReviewLog.create({
      data: { eventId, skillId: skill.id, action: 'approve', fromState: 'pending', toState: 'public', actorId: owner.id },
    });
    await expect(
      prisma.skillReviewLog.create({
        data: { eventId, skillId: skill.id, action: 'reject', fromState: 'pending', toState: 'private', actorId: owner.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
