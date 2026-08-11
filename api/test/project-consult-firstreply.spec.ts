import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validate } from 'class-validator';
import { PassThrough } from 'stream';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { CreateProjectDto } from '../src/modules/project/dto/create-project.dto';

/**
 * 首轮咨询「双重提交」回归（review 2026-08-11 P0）：
 * - create(llm) 只落首条消息,不再自动触发 AI
 * - createMessage(firstReply=true) 不重复写用户消息、不重复风险评估,只启动一次 AI 流
 * - 短推荐问题(≥5 字)可通过建单校验
 */

const mockProject = (over: any = {}) => ({
  id: 'p-1',
  kind: 'consult',
  title: '测试工单',
  route: 'llm',
  risk: 'P2',
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

function fakeStream() {
  const emitter = new (require('events').EventEmitter)();
  return Object.assign(emitter, { stdout: new PassThrough(), thinking: new PassThrough() });
}

describe('首轮咨询链路（双重提交回归）', () => {
  let service: ProjectService;
  let prisma: any;
  let risk: any;
  let codex: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      skill: { findFirst: vi.fn() },
      project: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
      projectMessage: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
      projectEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
      bpDomainMap: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn() },
      consultationRun: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    };
    makeTransaction(prisma);
    risk = { assess: vi.fn() };
    codex = { executeStream: vi.fn().mockResolvedValue(fakeStream()) };
    dingtalk = {
      createGroup: vi.fn(), addMember: vi.fn(), sendNotification: vi.fn(), syncContacts: vi.fn(),
    };
    service = new ProjectService(
      prisma as any,
      codex as any,
      risk as any,
      { writeBack: vi.fn() } as any,
      dingtalk as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { findAll: vi.fn(), findOne: vi.fn() } as any,
      new ProjectStateMachine() as any,
      { execute: vi.fn() } as any,
      new EscalateProjectToLegalUseCase(prisma) as any,
    );
    prisma.project.create.mockResolvedValue(mockProject());
    prisma.project.findUnique.mockResolvedValue(mockProject());
  });

  it('create(llm) 只落首条消息,不自动触发 AI（不再双重 AI）', async () => {
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: null });

    await service.create({ kind: 'consult', title: '测试工单', input: '这是一个足够长的测试问题' }, 'u-biz');

    // 首条消息由建单落库（create-project.use-case 事务内 projectMessage.create）
    expect(prisma.projectMessage.create).toHaveBeenCalled();
    // 不再在 create 里自动触发 AI
    expect(codex.executeStream).not.toHaveBeenCalled();
  });

  it('createMessage(firstReply=true) 不重复写用户消息,只启动一次 AI 流', async () => {
    prisma.projectMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', text: '这是首条消息' });
    prisma.consultationRun.findUnique.mockResolvedValue(null);
    prisma.consultationRun.create.mockResolvedValue({ id: 'run-1', status: 'running' });

    const result = await service.createMessage(
      'p-1',
      { text: '这是首条消息', firstReply: true },
      { id: 'u-biz', role: 'business' },
    );

    expect(prisma.projectMessage.create).not.toHaveBeenCalled(); // 首条已由建单落库,不重复写
    expect(risk.assess).not.toHaveBeenCalled(); // 不重复风险评估
    expect(codex.executeStream).toHaveBeenCalledTimes(1); // 只启动一次 AI
    expect(codex.executeStream.mock.calls[0][0]).toContain('这是首条消息'); // 用首条消息作 prompt
    expect(prisma.consultationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userMessageId: 'm1', status: 'running' }) }),
    );
    expect(result.route).toBe('llm');
  });

  it('两个并发 firstReply 只启动一次模型(ConsultationRun 唯一约束兜底)', async () => {
    prisma.projectMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', text: '这是首条消息' });
    prisma.consultationRun.findUnique.mockResolvedValue(null);
    // 第一个 create 成功,第二个撞 userMessageId 唯一约束
    prisma.consultationRun.create
      .mockResolvedValueOnce({ id: 'run-1', status: 'running' })
      .mockRejectedValueOnce({ code: 'P2002' });

    await Promise.all([
      service.createMessage('p-1', { text: '这是首条消息', firstReply: true }, { id: 'u-biz', role: 'business' }),
      service.createMessage('p-1', { text: '这是首条消息', firstReply: true }, { id: 'u-biz', role: 'business' }),
    ]);

    expect(codex.executeStream).toHaveBeenCalledTimes(1); // 只有一个请求获得执行权
    // 两个请求都尝试认领(create),但唯一约束只让一个成功,另一个 P2002 → 库里只有一条 run
    expect(prisma.consultationRun.create).toHaveBeenCalledTimes(2);
  });

  it('firstReply 已 succeeded 时返回已有答案,不再启动模型', async () => {
    prisma.projectMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', text: '这是首条消息' });
    prisma.projectMessage.findUnique.mockResolvedValue({ id: 'a1', role: 'assistant', text: '已有答案' });
    prisma.consultationRun.findUnique.mockResolvedValue({
      id: 'run-1', status: 'succeeded', answerMessageId: 'a1',
    });

    const result = await service.createMessage(
      'p-1',
      { text: '这是首条消息', firstReply: true },
      { id: 'u-biz', role: 'business' },
    );

    expect(codex.executeStream).not.toHaveBeenCalled();
    expect(result.message).toMatchObject({ id: 'a1', text: '已有答案' });
  });

  it('createMessage(普通追问) 仍写消息 + 触发 AI（一次）', async () => {
    prisma.projectMessage.create.mockResolvedValue({ id: 'm2', text: '追问' });
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: null });

    await service.createMessage('p-1', { text: '追问' }, { id: 'u-biz', role: 'business' });

    expect(prisma.projectMessage.create).toHaveBeenCalledTimes(1);
    expect(codex.executeStream).toHaveBeenCalledTimes(1);
  });

  it('短推荐问题(≥5 字)可通过建单校验(10→5)', async () => {
    const dto = new CreateProjectDto();
    dto.kind = 'consult';
    dto.title = '短问题';
    dto.input = '促销活动合规吗？'; // 8 字
    const errors = await validate(dto);
    const inputErr = errors.find((e) => e.property === 'input');
    expect(inputErr).toBeUndefined();
  });
});
