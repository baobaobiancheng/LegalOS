import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '../src/modules/project/project.service';

/**
 * 钉钉拉群链路（2026-08-05 工程评审决策 #1-17）：
 * - create legalbp：领域匹配 BP → 指派 → 建群（提出人+BP）+ 首条消息
 * - 技能 group 优先领域（工程评审 #10）
 * - 匹配失败兜底 legal_lead（工程评审 #4）
 * - 无法务成员 → 不建群 + 事件（工程评审 #9）
 * - P2 不拉群（回归：AI 处理语义）
 * - 升级补建群（工程评审 #1/#14）
 * - 三处转派检测 transfer/update/reply + 角色校验（工程评审 #2/#3）
 */

const mockProject = (over: any = {}) => ({
  id: 'p-1',
  kind: 'consult',
  title: '测试工单',
  route: 'legalbp',
  risk: 'P1',
  legalBpId: null,
  dingtalkChatId: null,
  dingtalkMembers: null,
  creatorId: 'u-biz',
  ...over,
});

describe('ProjectService 钉钉拉群链路', () => {
  let service: ProjectService;
  let prisma: any;
  let risk: any;
  let codex: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      skill: { findFirst: vi.fn() },
      project: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
      projectMessage: { create: vi.fn(), findFirst: vi.fn() },
      projectEvent: { create: vi.fn() },
      bpDomainMap: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn() },
    };
    risk = { assess: vi.fn() };
    codex = { executeStream: vi.fn() };
    dingtalk = {
      createGroup: vi.fn().mockResolvedValue({ chatId: 'c1', title: '群', members: ['u1'] }),
      addMember: vi.fn().mockResolvedValue(undefined),
      sendNotification: vi.fn().mockResolvedValue(undefined),
      syncContacts: vi.fn().mockResolvedValue([]),
    };
    service = new ProjectService(prisma as any, codex as any, risk as any, { writeBack: vi.fn() } as any, dingtalk as any);

    prisma.project.create.mockResolvedValue(mockProject());
    prisma.project.findUnique.mockResolvedValue(mockProject());
    // 用户映射：业务（已绑定）/ BP 彭宇欣（已绑定）/ 负责人（已绑定）
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'u-biz') return { id: 'u-biz', displayName: '业务-王五', role: 'business', dingtalkUserId: 'U-biz' };
      if (where.id === 'u-bp') return { id: 'u-bp', displayName: '彭宇欣', role: 'legal_bp', dingtalkUserId: 'U-bp' };
      if (where.id === 'u-lead') return { id: 'u-lead', displayName: '法务负责人', role: 'legal_lead', dingtalkUserId: 'U-lead' };
      return undefined;
    });
  });

  it('create legalbp + 技能 group：匹配 BP → 指派 + 建群（提出人+BP）+ 首条消息', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.skill.findFirst.mockResolvedValue({ id: 'sk-1', name: '数据合规评估', group: '合规法务', prompt: '你是数据合规专家' });
    // BP 映射：彭宇欣(legal_bp) → 合规法务，已绑定
    prisma.bpDomainMap.findMany.mockResolvedValue([
      { user: { id: 'u-bp', dingtalkUserId: 'U-bp' } },
    ]);

    await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', skillId: 'sk-1' },
      'u-biz',
    );

    // 指派 BP（技能 group 优先领域）
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBe('u-bp');

    // 建群：成员 = creator + BP（去重）
    const [members, title] = dingtalk.createGroup.mock.calls[0];
    expect(members).toEqual(['U-biz', 'U-bp']);
    expect(title).toContain('工单#');
    expect(prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dingtalkChatId: 'c1' }),
    }));
    // 首条消息：纯文字（标题/风险/提出人）
    const msg = dingtalk.sendNotification.mock.calls[0][1];
    expect(msg).toContain('测试工单');
    expect(msg).toContain('P1');
    expect(msg).toContain('业务-王五');
  });

  it('无技能：LLM 领域兜底匹配 BP', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合同与交易' });
    prisma.bpDomainMap.findMany.mockResolvedValue([
      { user: { id: 'u-bp2', dingtalkUserId: 'U-bp2' } },
    ]);

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(prisma.bpDomainMap.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { domain: '合同与交易' },
    }));
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBe('u-bp2');
  });

  it('匹配失败：兜底拉法务负责人（已绑定）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '争议法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([]); // 无 BP 映射
    prisma.user.findFirst.mockResolvedValue({ id: 'u-lead', dingtalkUserId: 'U-lead' }); // 兜底负责人

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBe('u-lead');
    // 建群仍进行（有法务成员）
    expect(dingtalk.createGroup).toHaveBeenCalled();
  });

  it('无法务成员（BP 未绑定且无兜底）：不建群 + 事件请人工建群', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null });
    prisma.bpDomainMap.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null); // 无兜底负责人

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    const events = prisma.projectEvent.create.mock.calls.map((c: any) => c[0].data.text);
    expect(events.some((t: string) => t.includes('请人工建群'))).toBe(true);
  });

  it('建群失败：不阻断工单创建 + 事件记录（回归：现有 try/catch 模式）', async () => {
    // domain 非空 → 走 bpDomainMap 匹配路径（domain=null 会走兜底且 findFirst mock 为空）
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合规法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([{ user: { id: 'u-bp', dingtalkUserId: 'U-bp' } }]);
    // ensureDingTalkGroup 内部 project.findUnique 需返回 { dingtalkChatId: null }（未建群）
    prisma.project.findUnique.mockResolvedValue({ dingtalkChatId: null });
    dingtalk.createGroup.mockRejectedValue(new Error('errcode=50001'));

    await expect(
      service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz'),
    ).resolves.toBeDefined();
    const events = prisma.projectEvent.create.mock.calls.map((c: any) => c[0].data.text);
    expect(events.some((t: string) => t.includes('钉钉拉群失败'))).toBe(true);
  });

  it('P2（llm）工单：不建群不匹配（回归：AI 处理不打扰 BP）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: '合规法务' });
    prisma.project.create.mockResolvedValue(mockProject({ route: 'llm' }));

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    expect(prisma.bpDomainMap.findMany).not.toHaveBeenCalled();
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    const created = prisma.project.create.mock.calls[0][0].data;
    expect(created.legalBpId).toBeNull();
  });

  it('升级补建群：P2→legalbp 重新匹配 BP（llm 工单创建时 legalBpId 恒 null）→ 指派并建群', async () => {
    // /review 2026-08-05：升级路径真实行为——update 只写 route/status/risk，legalBpId 仍为 null；
    // 修复后按新领域重新 matchLegalBp → 指派 u-bp → 建群（工程评审决策 #1）
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合规法务' });
    prisma.bpDomainMap.findMany.mockResolvedValue([{ user: { id: 'u-bp', dingtalkUserId: 'U-bp' } }]);
    prisma.project.findUnique.mockResolvedValue(mockProject({ route: 'llm', status: '分析中', legalBpId: null }));
    prisma.project.update.mockResolvedValue(mockProject({ route: 'legalbp', legalBpId: null }));
    prisma.projectMessage.findFirst.mockResolvedValue(null);

    const result = await service.createMessage(
      'p-1',
      { text: '追问触发升级', role: 'user' },
      'u-biz',
    );

    expect(result.route).toBe('legalbp');
    // 修复验证：legalBpId 被重新匹配并写库（第二次 update 带 legalBpId: 'u-bp'）
    const updates = prisma.project.update.mock.calls.map((c: any) => c[0].data);
    expect(updates.some((d: any) => d.legalBpId === 'u-bp')).toBe(true);
    // 异步建群已触发（等待微任务）
    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.createGroup).toHaveBeenCalled();
  });

  it('转派（transfer）：legalBpId 变更 → 新 BP 进群（旧 BP 留群）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', dingtalkChatId: 'c1' }));
    prisma.project.update.mockResolvedValue(mockProject({ legalBpId: 'u-new' }));
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'u-new' ? { id: 'u-new', displayName: '法务BP-新', role: 'legal_bp', dingtalkUserId: 'U-new' } : undefined,
    );

    await service.transfer('p-1', 'u-new');

    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.addMember).toHaveBeenCalledWith('c1', 'U-new');
  });

  it('转派目标未绑定钉钉：跳过加人 + 事件记录', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', dingtalkChatId: 'c1' }));
    prisma.project.update.mockResolvedValue(mockProject({ legalBpId: 'u-new' }));
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'u-new' ? { id: 'u-new', displayName: '法务BP-新', role: 'legal_bp', dingtalkUserId: null } : undefined,
    );

    await service.transfer('p-1', 'u-new');

    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.addMember).not.toHaveBeenCalled();
    const events = prisma.projectEvent.create.mock.calls.map((c: any) => c[0].data.text);
    expect(events.some((t: string) => t.includes('未绑定钉钉'))).toBe(true);
  });

  it('update：legalBpId 设为非法务角色 → 拒绝（工程评审 #3 角色校验）', async () => {
    prisma.project.findUnique.mockResolvedValue(mockProject());
    prisma.user.findUnique.mockResolvedValue({ id: 'u-biz2', role: 'business' });

    await expect(
      service.update('p-1', { legalBpId: 'u-biz2' } as any),
    ).rejects.toThrow('目标用户不是法务 BP');
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('reply 回传认领：回传人 ≠ 原 BP → 触发加人（三处检测之 reply）', async () => {
    prisma.project.updateMany.mockResolvedValue({ count: 1 });
    prisma.project.findUnique.mockResolvedValue(mockProject({ legalBpId: 'u-old', dingtalkChatId: 'c1', status: '待复核' }));
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'u-bp' ? { id: 'u-bp', displayName: '法务BP-张三', role: 'legal_bp', dingtalkUserId: 'U-bp' } : undefined,
    );

    await service.reply('p-1', { text: '法务意见', role: 'legal' }, 'u-bp');

    await new Promise((r) => setTimeout(r, 10));
    expect(dingtalk.addMember).toHaveBeenCalledWith('c1', 'U-bp');
  });
});
