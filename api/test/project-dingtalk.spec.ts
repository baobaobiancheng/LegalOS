import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';

/**
 * 钉钉拉群链路（P1-04 改造后）：
 * - create legalbp：领域匹配 BP → 指派 → 事务内入队 Outbox 建群事件（不再同步调钉钉）
 * - 技能 group 优先领域（工程评审 #10）；匹配失败兜底 legal_lead（工程评审 #4）
 * - P2 不拉群（回归：AI 处理语义）；升级补建群改入队 Outbox
 * - 转派/认领检测 transfer/update/reply + 角色校验（工程评审 #2/#3）；P1-01 对象级授权
 */

const mockProject = (over: any = {}) => ({
  id: 'p-1',
  kind: 'consult',
  title: '测试工单',
  route: 'legalbp',
  risk: 'P1',
  legalBpId: null,
  ownerId: 'u-biz',
  dingtalkChatId: null,
  dingtalkMembers: null,
  creatorId: 'u-biz',
  ...over,
});

function makeTransaction(prisma: any) {
  prisma.$transaction = vi.fn(async (arg: any) => {
    if (typeof arg === 'function') {
      const tx = {
        ...prisma,
        project: prisma.project,
        projectMessage: prisma.projectMessage,
        projectEvent: prisma.projectEvent,
        outboxEvent: prisma.outboxEvent,
        bpDomainMap: prisma.bpDomainMap,
        user: prisma.user,
      };
      return arg(tx);
    }
    return arg;
  });
}

describe('ProjectService 钉钉拉群链路', () => {
  let service: ProjectService;
  let prisma: any;
  let risk: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      skill: { findFirst: vi.fn() },
      project: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
      projectMessage: { create: vi.fn(), findFirst: vi.fn() },
      projectEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
      bpDomainMap: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({ id }))) },
      dingTalkContact: { findUnique: vi.fn().mockResolvedValue({ isActive: true, departmentIds: ['east'] }) },
      dingTalkDepartment: { findMany: vi.fn().mockResolvedValue([{ id: 'east', parentId: null }]) },
      legalAssignmentRule: { findMany: vi.fn().mockResolvedValue([{ id: 'east-bp', departmentId: 'east', includeDescendants: true, userId: 'u-bp' }]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    makeTransaction(prisma);
    risk = { assess: vi.fn() };
    dingtalk = {
      createGroup: vi.fn().mockResolvedValue({ chatId: 'c1', title: '群', members: ['u1'] }),
      addMember: vi.fn().mockResolvedValue(undefined),
      sendNotification: vi.fn().mockResolvedValue(undefined),
      syncContacts: vi.fn().mockResolvedValue([]),
    };
    service = new ProjectService(
      prisma as any,
      risk as any,
      dingtalk as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { findAll: vi.fn(), findOne: vi.fn() } as any,
      new ProjectStateMachine() as any,
      { execute: vi.fn() } as any,
      new EscalateProjectToLegalUseCase(prisma) as any,
      { claimRun: vi.fn(), reply: vi.fn(), buildRiskInput: vi.fn(async (t: string) => t) } as any,
      { validateForUser: vi.fn(), bind: vi.fn(), getTexts: vi.fn(), upload: vi.fn() } as any,
    );

    prisma.project.create.mockResolvedValue(mockProject());
    prisma.project.findUnique.mockResolvedValue(mockProject());
    // 用户映射：业务（已绑定）/ BP 彭宇欣（已绑定）/ 负责人（已绑定）
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'u-biz') return { id: 'u-biz', displayName: '业务-王五', role: 'business', isActive: true, dingtalkUserId: 'U-biz' };
      if (where.id === 'u-bp') return { id: 'u-bp', displayName: '彭宇欣', role: 'legal_bp', isActive: true, dingtalkUserId: 'U-bp' };
      if (where.id === 'u-lead') return { id: 'u-lead', displayName: '法务负责人', role: 'legal_lead', isActive: true, dingtalkUserId: 'U-lead' };
      if (where.id === 'u-new') return { id: 'u-new', displayName: '法务BP-新', role: 'legal_bp', isActive: true, dingtalkUserId: 'U-new' };
      return undefined;
    });
  });

  it('create legalbp：按申请人的组织匹配 BP，与专业技能领域无关，事务内入队建群', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.skill.findFirst.mockResolvedValue({ id: 'sk-1', name: '数据合规评估', group: '合规法务', prompt: '你是数据合规专家' });
    prisma.bpDomainMap.findMany.mockResolvedValue([
      { userId: 'u-bp' },
    ]);

    await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', skillId: 'sk-1' },
      'u-biz',
    );

    // 指派 BP 只认组织职责；专业领域映射不参与。
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBe('u-bp');
    expect(created.ownerId).toBe('u-bp');
    expect(prisma.bpDomainMap.findMany).not.toHaveBeenCalled();

    // P1-04：create 不再同步建群，改为事务内入队 Outbox（dedupKey 稳定业务键）
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'dingtalk.group.create',
          aggregateId: 'p-1',
          dedupKey: 'project:p-1:dingtalk-group:create:v1',
          projectId: 'p-1',
        }),
      }),
    );
  });

  it('LLM 领域不能覆盖组织职责指定的 BP', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合同与交易' });
    prisma.bpDomainMap.findMany.mockResolvedValue([
      { userId: 'u-bp2' },
    ]);

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(prisma.bpDomainMap.findMany).not.toHaveBeenCalled();
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBe('u-bp');
  });

  it('未命中组织职责：进入共享领导队列，不选择第一位领导或创建单人群', async () => {
    prisma.legalAssignmentRule.findMany.mockResolvedValue([]);
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '争议法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([]); // 无 BP 映射
    prisma.user.findFirst.mockResolvedValue({ id: 'u-lead', dingtalkUserId: 'U-lead' }); // 兜底负责人

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBeNull();
    // 建群由 Worker 执行：create 只入队
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(prisma.projectEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ text: expect.stringContaining('领导待分配队列') }) }));
  });

  it('申请人无有效组织身份：建单保留但不入队建群', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue(null);
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.bpDomainMap.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null); // 无兜底负责人

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('create 与钉钉解耦：即使建群可能失败，create 也只入队并成功返回（P1-04 语义）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合规法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([{ userId: 'u-bp' }]);
    dingtalk.createGroup.mockRejectedValue(new Error('errcode=50001'));

    await expect(
      service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz'),
    ).resolves.toBeDefined();
    expect(prisma.outboxEvent.create).toHaveBeenCalled();
  });

  it('P2（llm）工单：不匹配不建群不入队（回归：AI 处理不打扰 BP）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: '合规法务' });
    prisma.project.create.mockResolvedValue(mockProject({ route: 'llm' }));

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(prisma.bpDomainMap.findMany).not.toHaveBeenCalled();
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBeNull();
  });

  it('升级补建群：P2→legalbp 重新匹配 BP → 指派并入队建群 Outbox', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合规法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([{ userId: 'u-bp' }]);
    prisma.project.findUnique.mockResolvedValue(mockProject({ route: 'llm', status: '分析中', legalBpId: null }));
    prisma.project.update.mockResolvedValue(mockProject({ route: 'legalbp', legalBpId: null }));
    prisma.projectMessage.findFirst.mockResolvedValue(null);

    const result = await service.createMessage(
      'p-1',
      { text: '追问触发升级' },
      { id: 'u-biz', role: 'business' },
    );

    expect(result.route).toBe('legalbp');
    // 统一升级用例：匹配结果与 route/status 在条件更新中一次提交
    expect(prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p-1', route: 'llm', status: { not: '已取消' } }),
        data: expect.objectContaining({ route: 'legalbp', legalBpId: 'u-bp' }),
      }),
    );
    // 升级补建群改入队 Outbox（不再同步建群）
    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).toHaveBeenCalled();
  });

  it('转派（transfer）：legal_lead 可转派，legalBpId 变更 → 入队补人事件（旧 BP 留群）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', dingtalkChatId: 'c1' }));
    prisma.project.update.mockResolvedValue(mockProject({ legalBpId: 'u-new' }));

    await service.transfer('p-1', 'u-new', { id: 'u-lead', role: 'legal_lead' });

    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.addMember).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'dingtalk.member.add',
          payload: { projectId: 'p-1', userId: 'u-new' },
        }),
      }),
    );
  });

  it('转派目标未绑定钉钉：仍入队，由 Worker 记录人工处理事件', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', dingtalkChatId: 'c1' }));
    prisma.project.update.mockResolvedValue(mockProject({ legalBpId: 'u-new' }));
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'u-new' ? { id: 'u-new', displayName: '法务BP-新', role: 'legal_bp', isActive: true, dingtalkUserId: null } : undefined,
    );

    await service.transfer('p-1', 'u-new', { id: 'u-lead', role: 'legal_lead' });

    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.addMember).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'dingtalk.member.add' }) }),
    );
  });

  it('转派目标已停用时拒绝，不改写工单', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old' }));
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-disabled', displayName: '已停用法务', role: 'legal_bp', isActive: false,
    });

    await expect(service.transfer('p-1', 'u-disabled', { id: 'u-lead', role: 'legal_lead' }))
      .rejects.toThrow('账号须启用');
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('法务 BP 不能自行转派（P1-01）：transfer 抛 Forbidden', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-bp', dingtalkChatId: 'c1' }));

    await expect(
      service.transfer('p-1', 'u-new', { id: 'u-bp', role: 'legal_bp' }),
    ).rejects.toThrow('无权执行此操作');
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('update：legalBpId 设为非法务角色 → 拒绝（工程评审 #3 角色校验）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject());
    prisma.user.findUnique.mockResolvedValue({ id: 'u-biz2', role: 'business', isActive: true });

    await expect(
      service.update('p-1', { legalBpId: 'u-biz2' } as any, { id: 'u-lead', role: 'legal_lead' }),
    ).rejects.toThrow('目标用户不是法务 BP');
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('reply 不能借 ownerId 覆盖 legalBpId 的明确指派', async () => {
    prisma.project.updateMany.mockResolvedValue({ count: 1 });
    // 历史 owner 不产生正式回复权限。
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', ownerId: 'u-bp', dingtalkChatId: 'c1', status: '待复核' }));

    await expect(service.reply('p-1', { text: '法务意见' }, { id: 'u-bp', role: 'legal_bp' })).rejects.toThrow('无权');
    expect(dingtalk.addMember).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it('reply 未指派：legal_bp 无权回传（P1-01：仅已指派给自己）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-other', ownerId: 'u-biz', dingtalkChatId: 'c1', status: '待复核' }));

    await expect(
      service.reply('p-1', { text: '法务意见' }, { id: 'u-bp', role: 'legal_bp' }),
    ).rejects.toThrow('无权执行此操作');
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
  });

  it('幂等：同一 idempotencyKey 已存在工单 → 直接返回，不重复创建/入队（P1-03）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.project.findUnique.mockResolvedValue(
      mockProject({ id: 'p-existing', idempotencyKey: 'key-1' }),
    );

    const result = await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', idempotencyKey: 'key-1' },
      'u-biz',
    );

    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(result.id).toBe('p-existing');
  });

  it('幂等：并发撞唯一约束(P2002) → 返回已存在工单，不入队（P1-03 兜底）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.project.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    prisma.project.findUnique.mockResolvedValue(
      mockProject({ id: 'p-existing', idempotencyKey: 'key-1' }),
    );

    const result = await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', idempotencyKey: 'key-1' },
      'u-biz',
    );

    expect(result.id).toBe('p-existing');
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
