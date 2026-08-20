import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

/**
 * 工单创建时的技能解析覆盖/快照/兜底（工程评审决策 OV#2）：
 * - 客户端 skillId/skillName 仅参考，服务端解析覆盖（防伪造与快照分歧）
 * - prompt 快照入 extra.skillPrompt（在途多轮对话稳定）
 * - 解析失败 → 按无技能处理 + 工单事件提示
 * - P1-03 改造后 create 走事务用例（$transaction），以下断言仍基于同一批 mock
 */

const mockProject = (over: any = {}) => ({
  id: 'p-1',
  kind: 'consult',
  route: 'legalbp',
  ...over,
});

const mockSkill = {
  id: 'sk-1',
  slug: 'data-compliance',
  name: '数据合规评估',
  prompt: '你是数据合规专家。',
};

/** 事务代理：让 tx.* 委托到同一批 prisma mock（保持既有断言有效） */
function makeTransaction(prisma: any) {
  prisma.$transaction = vi.fn(async (arg: any) => {
    if (typeof arg === 'function') {
      const tx = {
        project: prisma.project,
        projectMessage: prisma.projectMessage,
        projectEvent: prisma.projectEvent,
        outboxEvent: prisma.outboxEvent,
      };
      return arg(tx);
    }
    return arg;
  });
}

describe('ProjectService.create 技能解析', () => {
  let service: ProjectService;
  let prisma: any;
  let risk: any;
  let crm: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      skill: { findFirst: vi.fn() },
      project: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(),
      },
      projectMessage: { create: vi.fn() },
      projectEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
      bpDomainMap: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findUnique: vi.fn().mockResolvedValue(undefined), findFirst: vi.fn().mockResolvedValue(null) },
    };
    makeTransaction(prisma);
    risk = { assess: vi.fn().mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: null }) }; // legalbp 避免触发 AI
    crm = { writeBack: vi.fn() };
    dingtalk = {
      createGroup: vi.fn().mockResolvedValue({ chatId: 'c1', members: ['m1'] }),
      sendNotification: vi.fn(),
    };
    service = new ProjectService(
      prisma as any,
      risk as any,
      crm as any,
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
  });

  it('有效技能：服务端解析覆盖 skillId/skillName + prompt 快照进 extra（忽略客户端伪造名）', async () => {
    prisma.skill.findFirst.mockResolvedValue(mockSkill);
    await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', skillId: 'sk-1', skillName: '伪造名' },
      'u-1',
    );
    const data = prisma.project.create.mock.calls[0][0].data;
    expect(data.skillId).toBe('sk-1');
    expect(data.skillName).toBe('数据合规评估'); // 覆盖客户端伪造名
    expect(data.extra).toEqual({ skillPrompt: '你是数据合规专家。' });
  });

  it('无效 skillId：按无技能处理（skillId null + 无快照）+ 工单事件提示', async () => {
    prisma.skill.findFirst.mockResolvedValue(null); // 不存在/停用/无权
    await service.create(
      { kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', skillId: 'junk-id' },
      'u-1',
    );
    const data = prisma.project.create.mock.calls[0][0].data;
    expect(data.skillId).toBeNull();
    expect(data.skillName).toBeNull();

    // 用户可见反馈事件
    const events = prisma.projectEvent.create.mock.calls.map((c: any) => c[0].data.text);
    expect(events.some((t: string) => t.includes('所选技能不可用'))).toBe(true);
  });

  it('不传 skillId：无技能字段，无兜底事件', async () => {
    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-1');
    const data = prisma.project.create.mock.calls[0][0].data;
    expect(data.skillId).toBeNull();
    const events = prisma.projectEvent.create.mock.calls.map((c: any) => c[0].data.text);
    expect(events.some((t: string) => t.includes('所选技能不可用'))).toBe(false);
  });

  it('技能解析查询异常：不阻断工单创建（按无技能处理）', async () => {
    prisma.skill.findFirst.mockRejectedValue(new Error('db down'));
    await expect(
      service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题', skillId: 'sk-1' }, 'u-1'),
    ).resolves.toBeDefined();
    expect(prisma.project.create).toHaveBeenCalled();
  });
});
