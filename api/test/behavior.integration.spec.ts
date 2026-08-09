import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { SkillService } from '../src/modules/skill/skill.service';
import { MembersService } from '../src/modules/members/members.service';
import { DeterministicRiskClassifier } from '../src/common/risk/deterministic-risk-classifier';

/**
 * 行为级集成测试（P1-12 §11.4）：真实 use-case/服务 + MySQL 8，覆盖
 * mock 单测无法验证的事务、唯一约束、幂等、升级用例、自动绑定等行为。
 * 需要 TEST_DATABASE_URL（本地已建 legalos_test；CI 用 GitLab masked variable）。
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const HAS_DB = !!DB_URL;

describe.skipIf(!HAS_DB)('行为级集成（MySQL）', () => {
  let prisma: PrismaClient;
  let seq = 0;
  const uniq = () => `${Date.now()}-${++seq}`;
  const mkUser = (role: 'business' | 'legal_bp' = 'business', name?: string) =>
    prisma.user.create({
      data: { username: `it-${uniq()}`, passwordHash: 'x', displayName: name ?? 'U', role },
    });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('P1-03/P1-11：工单创建事务原子写 Project+首消息+事件+Outbox+RiskLog', async () => {
    const uc = new CreateProjectUseCase(prisma as any);
    const u = await mkUser();
    const { project } = await uc.execute({
      kind: 'consult',
      title: '事务测试',
      input: '问题',
      creatorId: u.id,
      risk: 'P1',
      route: 'legalbp',
      legalBpId: null,
      events: ['x · 工单已创建'],
      enqueueDingtalkGroup: true,
      riskLog: { finalRisk: 'P1', route: 'legalbp', ruleFloor: 'P1', matchedRuleIds: ['R101'], modelRisk: 'P2', classifierVersion: 'test' },
    } as any);
    const [msgs, evts, outbox, riskLogs] = await Promise.all([
      prisma.projectMessage.count({ where: { projectId: project.id } }),
      prisma.projectEvent.count({ where: { projectId: project.id } }),
      prisma.outboxEvent.count({ where: { projectId: project.id } }),
      prisma.riskAssessmentLog.count({ where: { projectId: project.id } }),
    ]);
    expect(msgs).toBe(1);
    expect(evts).toBe(1);
    expect(outbox).toBe(1);
    expect(riskLogs).toBe(1);
  });

  it('P1-03 幂等：同幂等键重复创建只返回同一个 Project', async () => {
    const uc = new CreateProjectUseCase(prisma as any);
    const u = await mkUser();
    const key = `idem-${uniq()}`;
    const a = await uc.execute({ kind: 'consult', title: 't', input: 'i', creatorId: u.id, risk: 'P2', route: 'llm', legalBpId: null, idempotencyKey: key } as any);
    const b = await uc.execute({ kind: 'consult', title: 't', input: 'i', creatorId: u.id, risk: 'P2', route: 'llm', legalBpId: null, idempotencyKey: key } as any);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.project.id).toBe(b.project.id);
  });

  it('P1-10：统一法务升级 use-case——升级 route+写事件+Outbox 建群，重复升级幂等', async () => {
    const uc = new EscalateProjectToLegalUseCase(prisma as any);
    const u = await mkUser();
    const p = await prisma.project.create({ data: { kind: 'consult', title: 't', risk: 'P2', route: 'llm', creatorId: u.id, ownerId: u.id } });
    const { upgraded, project } = await uc.execute({ projectId: p.id, route: 'legalbp', status: '待复核', eventTexts: ['x · 升级'] } as any);
    expect(upgraded).toBe(true);
    expect((project as any).route).toBe('legalbp');
    const outbox = await prisma.outboxEvent.count({ where: { projectId: p.id, eventType: 'dingtalk.group.create' } });
    expect(outbox).toBe(1);
    const again = await uc.execute({ projectId: p.id, route: 'legalbp' } as any);
    expect(again.upgraded).toBe(false);
  });

  it('P1-11：确定性风险下限不可被模型降级（纯规则）', () => {
    const c = new DeterministicRiskClassifier();
    expect(c.classify('涉及刑事犯罪被公安立案调查').floor).toBe('P0');
    expect(c.classify('这是数据出境问题').floor).toBe('P1');
    expect(c.classify('普通合同条款询问').floor).toBe('P2');
  });

  it('P1-09：SkillService.review 事务写状态+审计日志（真实表）', async () => {
    const svc = new SkillService(prisma as any);
    const owner = await mkUser('legal_bp');
    const skill = await prisma.skill.create({ data: { slug: `it-${uniq()}`, name: 'S', group: '合规法务', description: '', prompt: 'p', visibility: 'pending', creatorId: owner.id } });
    const r = await svc.review(skill.id, { approved: true }, owner.id);
    expect(r.visibility).toBe('public');
    const log = await prisma.skillReviewLog.count({ where: { skillId: skill.id } });
    expect(log).toBe(1);
    const fresh = await prisma.skill.findUnique({ where: { id: skill.id } });
    expect(fresh.visibility).toBe('public');
  });

  it('P1-07：MembersService 自动绑定唯一姓名（真实 staging/merge/绑定）', async () => {
    const uniqueName = `唯一真人${uniq()}`;
    const contactId = `DU-${uniq()}`;
    const svc = new MembersService(prisma as any, {
      syncContacts: async () => ({ contacts: [{ userId: contactId, name: uniqueName, mobile: '1' }], complete: true, departmentCount: 1, pageCount: 1, warnings: [] }),
    } as any);
    const u = await mkUser('business', uniqueName);
    const result = await svc.syncContacts();
    expect(result.autoBound).toBe(1);
    const updated = await prisma.user.findUnique({ where: { id: u.id } });
    expect(updated.dingtalkUserId).toBe(contactId);
    // 批次已 complete
    const batch = await prisma.dingTalkSyncBatch.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(batch.status).toBe('complete');
  });
});
