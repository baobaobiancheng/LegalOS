import { describe, expect, it, vi } from 'vitest';
import { assignLegalBp, AssignmentRule, matchAssignmentRules } from '../src/modules/project/domain/legal-assignment';
import { LEGAL_RESPONSIBILITIES } from '../src/modules/members/legal-responsibility.catalog';
import { LegalResponsibilityService } from '../src/modules/members/legal-responsibility.service';
import { ProjectController } from '../src/modules/project/project.controller';
import { MembersController } from '../src/modules/members/members.controller';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';

const departments = [{ id: 'root', parentId: null }, { id: 'ru', parentId: 'root' },
  { id: 'leaf', parentId: 'ru' }, { id: 'other', parentId: 'root' }];
const rule = (departmentId = 'ru', userId = 'bp', id = 'r'): AssignmentRule => ({ id, departmentId, userId, includeDescendants: true });
function database() {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ dingtalkUserId: 'dt-user' }), findMany: vi.fn().mockResolvedValue([{ id: 'bp' }]) },
    dingTalkContact: { findUnique: vi.fn().mockResolvedValue({ isActive: true, departmentIds: ['leaf'] }) },
    dingTalkDepartment: { findMany: vi.fn().mockResolvedValue(departments) },
    legalAssignmentRule: { findMany: vi.fn().mockResolvedValue([rule()]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

describe('业务组织职责匹配', () => {
  it('按祖先 ID 匹配 RU 全员，同名但 ID 不同不匹配', () => {
    expect(matchAssignmentRules(['leaf'], departments, [rule()])).toEqual([rule()]);
    expect(matchAssignmentRules(['untrusted-name'], departments, [rule()])).toEqual([]);
  });
  it('同一部门链优先最具体范围，关闭下级覆盖时仅匹配直属成员', () => {
    expect(matchAssignmentRules(['leaf'], departments, [rule(), rule('leaf', 'bp2', 'child')])).toEqual([rule('leaf', 'bp2', 'child')]);
    expect(matchAssignmentRules(['leaf'], departments, [{ ...rule(), includeDescendants: false }])).toEqual([]);
  });
  it('损坏环不无限递归，缺失父部门不猜归属', () => {
    expect(matchAssignmentRules(['a'], [{ id: 'a', parentId: 'a' }], [rule()])).toEqual([]);
    expect(matchAssignmentRules(['leaf'], [{ id: 'leaf', parentId: 'missing' }], [rule()])).toEqual([]);
  });
  it('仅使用已绑定通讯录，不接受请求正文的部门名和模型领域', async () => {
    const db = database();
    expect(await assignLegalBp(db as any, 'requester')).toEqual({ legalBpId: 'bp', reason: 'assigned', ruleIds: ['r'] });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 'requester' }, select: { dingtalkUserId: true } });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['bp'] }, isActive: true, role: 'legal_bp' } }));
  });
  it.each([null, { isActive: false, departmentIds: ['leaf'] }, { isActive: true, departmentIds: null }])('缺失或失效通讯录交领导：%j', async contact => {
    const db = database(); db.dingTalkContact.findUnique.mockResolvedValue(contact as any);
    expect(await assignLegalBp(db as any, 'requester')).toMatchObject({ legalBpId: null, reason: 'no_org' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('不同组织命中不同负责人时交领导，不从中任选一位', async () => {
    const db = database();
    db.dingTalkContact.findUnique.mockResolvedValue({ isActive: true, departmentIds: ['leaf', 'other'] });
    db.legalAssignmentRule.findMany.mockResolvedValue([rule(), rule('other', 'bp2', 'r2')]);
    expect(await assignLegalBp(db as any, 'requester')).toMatchObject({ legalBpId: null, reason: 'ambiguous' });
  });
  it('多个范围指向同一负责人只分配一次；目标停用或非普通法务则交领导', async () => {
    const db = database();
    db.dingTalkContact.findUnique.mockResolvedValue({ isActive: true, departmentIds: ['leaf', 'other'] });
    db.legalAssignmentRule.findMany.mockResolvedValue([rule(), rule('other', 'bp', 'r2')]);
    expect(await assignLegalBp(db as any, 'requester')).toMatchObject({ legalBpId: 'bp' });
    db.user.findMany.mockResolvedValue([]);
    expect(await assignLegalBp(db as any, 'requester')).toMatchObject({ legalBpId: null, reason: 'no_candidate' });
  });
  it('未命中职责进入领导队列；数据库失败不伪装为无匹配', async () => {
    const db = database(); db.legalAssignmentRule.findMany.mockResolvedValue([]);
    expect(await assignLegalBp(db as any, 'requester')).toMatchObject({ legalBpId: null, reason: 'no_rule' });
    db.legalAssignmentRule.findMany.mockRejectedValue(new Error('db unavailable'));
    await expect(assignLegalBp(db as any, 'requester')).rejects.toThrow('db unavailable');
  });
});

describe('职责清单与管理入口', () => {
  it('BaaS/生态直接归李潇潇，不轮询刁英楠；杨露不入本次清单', () => {
    const li = LEGAL_RESPONSIBILITIES.find(person => person.name === '李潇潇')!;
    expect(li.scopes.map(scope => scope.id)).toEqual(['709180775', '918051239']);
    expect(LEGAL_RESPONSIBILITIES.filter(person => person.scopes.some(scope => ['709180775', '918051239'].includes(scope.id)))).toEqual([li]);
    expect(LEGAL_RESPONSIBILITIES.some(person => person.name === '杨露')).toBe(false);
    expect(LEGAL_RESPONSIBILITIES.find(person => person.name === '陈东')!.scopes[0].name).toBe('华西南RU');
  });
  it('未知账号不猜 CAS 名；未核实海外/企业 EX 范围不自动生效', () => {
    expect(LEGAL_RESPONSIBILITIES.find(person => person.name === '王玉')!.casUsername).toBeNull();
    expect(LEGAL_RESPONSIBILITIES.find(person => person.name === '孙文弘')!.scopes).toEqual([]);
    expect(LEGAL_RESPONSIBILITIES.find(person => person.name === '彭宇欣')!.pendingScopes).toHaveLength(1);
  });
  it('领导候选人和认领入口不向普通 BP 开放；职责修改仅管理员可用', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ProjectController.prototype.assignees)).toEqual(['admin', 'legal_lead']);
    expect(Reflect.getMetadata(ROLES_KEY, ProjectController.prototype.claim)).toEqual(['admin', 'legal_lead']);
    expect(Reflect.getMetadata(ROLES_KEY, MembersController)).toEqual(['admin']);
  });
  it('预览阻断账号/部门不一致；应用只写这份部分清单并同事务记录审计', async () => {
    const person = LEGAL_RESPONSIBILITIES[2];
    const db: any = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'li', casUsername: person.casUsername, displayName: person.name, role: 'legal_bp', isActive: true, dingtalkUserId: 'dt-li' }]) },
      dingTalkDepartment: { findMany: vi.fn().mockResolvedValue(person.scopes) },
      legalAssignmentRule: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn(), updateMany: vi.fn() },
    };
    db.$transaction = vi.fn(fn => fn(db));
    const audit = { record: vi.fn() };
    const service = new LegalResponsibilityService(db, audit as any);
    expect((await service.preview())[2].scopes.every(scope => scope.state === 'ready')).toBe(true);
    expect(await service.apply({ id: 'admin', role: 'admin' })).toMatchObject({ applied: 2 });
    expect(db.legalAssignmentRule.upsert).toHaveBeenCalledTimes(2);
    expect(db.legalAssignmentRule.upsert.mock.calls[0][0].create.userId).toBe('li');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.assignment_rules.apply' }), db);
    db.user.findMany.mockResolvedValue([]);
    expect((await service.preview())[2].scopes.every(scope => scope.state === 'blocked')).toBe(true);
  });
  it('已给定职责与系统关联分开：区分组织未同步、部门不符和账号未就绪', async () => {
    const person = LEGAL_RESPONSIBILITIES[2];
    const db: any = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'li', casUsername: person.casUsername, displayName: person.name, role: 'legal_bp', isActive: true, dingtalkUserId: 'dt-li' }]) },
      dingTalkDepartment: { findMany: vi.fn().mockResolvedValue([]) },
      legalAssignmentRule: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new LegalResponsibilityService(db, {} as any);
    const missingOrg = (await service.preview())[2];
    expect(missingOrg.description).toBe(person.description);
    expect(missingOrg.scopes[0]).toMatchObject({ ...person.scopes[0], state: 'blocked', issueCode: 'DEPARTMENT_NOT_SYNCED' });
    expect(missingOrg.scopes[0].issue).toContain('无需重复填写职责');

    db.dingTalkDepartment.findMany.mockResolvedValue([{ ...person.scopes[0], name: '改名后的部门' }, person.scopes[1]]);
    expect((await service.preview())[2].scopes.map(scope => scope.issueCode)).toEqual(['DEPARTMENT_MISMATCH', null]);
    db.user.findMany.mockResolvedValue([]);
    expect((await service.preview())[2].scopes.every(scope => scope.issueCode === 'ACCOUNT_NOT_READY')).toBe(true);

    db.user.findMany.mockResolvedValue([{ id: 'li', casUsername: person.casUsername, displayName: person.name, role: 'legal_bp', isActive: true, dingtalkUserId: 'dt-li' }]);
    db.dingTalkDepartment.findMany.mockResolvedValue(person.scopes);
    db.legalAssignmentRule.findMany.mockResolvedValue([{ id: `${person.key}:${person.scopes[0].id}`, userId: 'li', departmentId: person.scopes[0].id, isActive: true }]);
    expect((await service.preview())[2].scopes.map(scope => ({ state: scope.state, issueCode: scope.issueCode })))
      .toEqual([{ state: 'active', issueCode: null }, { state: 'ready', issueCode: null }]);
  });
});
