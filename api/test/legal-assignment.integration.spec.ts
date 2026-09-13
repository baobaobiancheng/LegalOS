import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { ProjectQueryService } from '../src/modules/project/queries/project-query.service';
import { MembersService } from '../src/modules/members/members.service';
import { ClaimProjectUseCase } from '../src/modules/project/application/claim-project.use-case';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('组织职责分配真实 MySQL', () => {
  let db: PrismaClient;
  let requesterId: string;
  let bpId: string;
  let leadId: string;
  const token = randomUUID().slice(0, 12);
  const dtId = `assign-dt-${token}`;
  const parentId = `ru-${token}`;
  const childId = `leaf-${token}`;
  const ruleId = `rule-${token}`;
  const key = () => `assignment-${randomUUID()}`;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    const requester = await db.user.create({ data: { username: `biz-${token}`, displayName: `业务-${token}`, role: 'business', passwordHash: 'test-only', dingtalkUserId: dtId } });
    const bp = await db.user.create({ data: { username: `bp-${token}`, displayName: `法务-${token}`, role: 'legal_bp', passwordHash: 'test-only' } });
    requesterId = requester.id; bpId = bp.id;
    leadId = (await db.user.create({ data: { username: `lead-${token}`, displayName: '测试领导', role: 'legal_lead', passwordHash: 'test-only' } })).id;
    await db.dingTalkDepartment.createMany({ data: [{ id: parentId, name: '测试RU' }, { id: childId, parentId, name: '末级业务组' }] });
    await db.dingTalkContact.create({ data: { userId: dtId, name: requester.displayName, departmentIds: [childId] } });
    await db.legalAssignmentRule.create({ data: { id: ruleId, name: '测试范围', description: '虚构测试', departmentId: parentId, userId: bp.id } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  const create = (idempotencyKey = key()) => new CreateProjectUseCase(db as any).execute({
    kind: 'consult', title: '组织职责测试', input: '虚构咨询', creatorId: requesterId,
    risk: 'P1', route: 'legalbp', legalBpId: null, autoAssignLegal: true,
    enqueueDingtalkGroup: true, idempotencyKey,
  });
  const projectService = (prisma: any = db) => new ProjectService(
    prisma, {} as any, { sendNotification: async () => undefined } as any,
    new CreateProjectUseCase(prisma), new ProjectAccessPolicy(),
    new ProjectQueryService(prisma, new ProjectAccessPolicy()), new ProjectStateMachine(),
    new ClaimProjectUseCase(prisma, new ProjectAccessPolicy()), new EscalateProjectToLegalUseCase(prisma),
    {} as any, {} as any,
  );
  const pendingProject = () => db.project.create({ data: {
    kind: 'consult', title: `待分配回归-${token}`, creatorId: requesterId, ownerId: requesterId,
    route: 'legalbp', status: '待复核', risk: 'P1',
  } });

  it.each(['patch', 'transfer', 'claim', 'reply'] as const)('%s 首次指派无群工单时，指派和补建群通知同事务提交', async method => {
    const project = await pendingProject();
    const actor = { id: leadId, role: 'legal_lead' as const };
    const service = projectService();
    if (method === 'patch') await service.update(project.id, { legalBpId: bpId }, actor);
    if (method === 'transfer') await service.transfer(project.id, bpId, actor);
    if (method === 'claim') await service.claim(project.id, actor);
    if (method === 'reply') await service.reply(project.id, { text: '虚构测试回复' }, actor);
    const expectedId = ['patch', 'transfer'].includes(method) ? bpId : leadId;
    expect(await db.project.findUnique({ where: { id: project.id } })).toMatchObject({ legalBpId: expectedId });
    expect(await db.outboxEvent.findMany({ where: { projectId: project.id } })).toEqual([
      expect.objectContaining({ eventType: 'dingtalk.member.add', payload: { projectId: project.id, userId: expectedId } }),
    ]);
  });

  it.each(['patch', 'transfer', 'claim', 'reply'] as const)('%s 通知入队失败会回滚指派、消息和事件', async method => {
    const project = await pendingProject();
    const proxy = { project: db.project, $transaction: (fn: any, options: any) => db.$transaction(tx => fn({
      ...tx, outboxEvent: { create: () => { throw new Error('outbox write failed'); } },
    }), options) };
    const service = projectService(proxy);
    const actor = { id: leadId, role: 'legal_lead' as const };
    const action = method === 'patch' ? () => service.update(project.id, { legalBpId: bpId }, actor)
      : method === 'transfer' ? () => service.transfer(project.id, bpId, actor)
        : method === 'claim' ? () => service.claim(project.id, actor)
          : () => service.reply(project.id, { text: '虚构测试回复' }, actor);
    await expect(action()).rejects.toThrow('outbox write failed');
    expect(await db.project.findUnique({ where: { id: project.id } })).toMatchObject({ legalBpId: null, status: '待复核' });
    expect(await db.projectMessage.count({ where: { projectId: project.id } })).toBe(0);
    expect(await db.projectEvent.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('并发认领仅一位领导成功且只生成一条通知', async () => {
    const project = await pendingProject();
    const claim = new ClaimProjectUseCase(db as any, new ProjectAccessPolicy());
    const results = await Promise.allSettled([claim.execute(project.id, { id: leadId, role: 'legal_lead' }), claim.execute(project.id, { id: leadId, role: 'legal_lead' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.outboxEvent.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('处理中法务降为业务后工单进入领导队列，原法务不再获得处理权限', async () => {
    const { project } = await create();
    await db.user.update({ where: { id: bpId }, data: { role: 'business' } });
    try {
      const query = new ProjectQueryService(db as any, new ProjectAccessPolicy());
      const result = await query.findAll({ id: leadId, role: 'legal_lead' }, { assignment: 'pending', query: '组织职责测试' });
      expect(result.items.some(item => item.id === project.id)).toBe(true);
      await expect(query.findOne(project.id, { id: bpId, role: 'business' })).rejects.toThrow('无权');
    } finally { await db.user.update({ where: { id: bpId }, data: { role: 'legal_bp' } }); }
  });

  it('下级部门自动命中父级范围，指派/首消息/事件/建群任务原子落库，普通 BP 不见别人的单', async () => {
    const { project } = await create();
    expect(project).toMatchObject({ legalBpId: bpId, ownerId: bpId });
    expect(await db.projectMessage.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.projectEvent.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { projectId: project.id } })).toBe(1);
    const query = new ProjectQueryService(db as any, new ProjectAccessPolicy());
    expect((await query.findAll({ id: 'unassigned-bp', role: 'legal_bp' }, {})).items).toEqual([]);
    await expect(query.findOne(project.id, { id: 'unassigned-bp', role: 'legal_bp' })).rejects.toThrow('无权');
  });
  it('并发幂等请求只产生一个指派工单及一个外部任务', async () => {
    const idempotencyKey = key();
    const results = await Promise.all([create(idempotencyKey), create(idempotencyKey)]);
    expect(results[0].project.id).toBe(results[1].project.id);
    expect(await db.outboxEvent.count({ where: { projectId: results[0].project.id } })).toBe(1);
  });
  it('无规则时是共享领导待分配队列，列表/分组数量/详情权限一致', async () => {
    await db.legalAssignmentRule.update({ where: { id: ruleId }, data: { isActive: false } });
    try {
      const { project } = await create();
      expect(project.legalBpId).toBeNull();
      expect(await db.outboxEvent.count({ where: { projectId: project.id } })).toBe(0);
      const query = new ProjectQueryService(db as any, new ProjectAccessPolicy());
      const result = await query.findAll({ id: 'lead', role: 'legal_lead' }, { assignment: 'pending', query: '组织职责测试' });
      expect(result.items.some(item => item.id === project.id)).toBe(true);
      expect((await query.findAll({ id: bpId, role: 'legal_bp' }, {})).items.some(item => item.id === project.id)).toBe(false);
    } finally { await db.legalAssignmentRule.update({ where: { id: ruleId }, data: { isActive: true } }); }
  });
  it('停用法务不会被自动分配', async () => {
    await db.user.update({ where: { id: bpId }, data: { isActive: false } });
    try { expect((await create()).project.legalBpId).toBeNull(); }
    finally { await db.user.update({ where: { id: bpId }, data: { isActive: true } }); }
  });
  it('咨询/合同进入人工法务时共用组织规则', async () => {
    const project = await db.project.create({ data: { kind: 'contract', title: '测试合同', creatorId: requesterId, ownerId: requesterId, route: 'llm' } });
    const result = await new EscalateProjectToLegalUseCase(db as any).execute({ projectId: project.id, status: '待复核' });
    expect(result.project).toMatchObject({ legalBpId: bpId, ownerId: bpId, route: 'legalbp' });
    expect(await db.outboxEvent.count({ where: { projectId: project.id } })).toBe(1);
  });
  it('事件写入失败时回滚工单及指派，不遗留半成品', async () => {
    const idempotencyKey = key();
    const proxy = {
      project: db.project,
      $transaction: (fn: any, options: any) => db.$transaction(tx => fn({ ...tx, projectEvent: { create: () => { throw new Error('event write failed'); } } }), options),
    };
    await expect(new CreateProjectUseCase(proxy as any).execute({
      kind: 'consult', title: '回滚测试', input: 't', creatorId: requesterId, risk: 'P1', route: 'legalbp',
      legalBpId: null, autoAssignLegal: true, idempotencyKey,
    })).rejects.toThrow('event write failed');
    expect(await db.project.findUnique({ where: { idempotencyKey } })).toBeNull();
  });
  it('真实 staging/bulk merge 保留部门树和多部门 ID，失败批次不覆盖有效组织', async () => {
    const contacts = [{ userId: dtId, name: `业务-${token}`, department: '末级业务组', departmentIds: [childId, parentId] }];
    const departments = [{ id: parentId, parentId: null, name: '测试RU' }, { id: childId, parentId, name: '末级业务组' }];
    const service = new MembersService(db as any, { syncContacts: async () => ({ contacts, departments, complete: true, departmentCount: 2, pageCount: 1, warnings: [] }) } as any, { get: () => '' } as any);
    await service.syncContacts();
    expect(await db.dingTalkContact.findUnique({ where: { userId: dtId } })).toMatchObject({ departmentIds: [childId, parentId] });
    expect(await db.dingTalkDepartment.findUnique({ where: { id: childId } })).toMatchObject({ parentId, isActive: true });
    const failed = new MembersService(db as any, { syncContacts: async () => ({ contacts: [], departments: [], complete: false }) } as any, { get: () => '' } as any);
    await expect(failed.syncContacts()).resolves.toMatchObject({ complete: false });
    expect(await db.dingTalkDepartment.findUnique({ where: { id: childId } })).toMatchObject({ parentId, isActive: true });
  });
});
