import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validate } from 'class-validator';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { ProjectService } from '../src/modules/project/project.service';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { ConsultationReplyOrchestrator } from '../src/modules/project/application/consultation-reply.orchestrator';
import { CreateProjectDto } from '../src/modules/project/dto/create-project.dto';

/**
 * 首轮咨询「双重提交」回归 + 多轮上下文改造（review 2026-08-11/12）：
 * - create(llm) 只落首条消息,不再自动触发 AI
 * - createMessage(firstReply=true) 不重复写用户消息、只启动一次 AI 流
 * - 追问分支也认领 ConsultationRun（每轮幂等）
 * - 同 idempotencyKey 重复请求复用已有答案，不重复建消息/不重复触发
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
  const emitter = new EventEmitter();
  return Object.assign(emitter, { stdout: new PassThrough(), thinking: new PassThrough() });
}

function buildContextMessages(userText: string) {
  return {
    messages: [
      { role: 'system' as const, content: '规则' },
      { role: 'user' as const, content: userText },
    ],
    includedMessageIds: ['m1'],
    estimatedInputTokens: 10,
    summaryVersion: null,
    contextPolicyVersion: 'v1',
  };
}

describe('首轮咨询链路（双重提交回归 + 多轮幂等）', () => {
  let service: ProjectService;
  let prisma: any;
  let risk: any;
  let consultationChat: any;
  let contextBuilder: any;
  let attachmentService: any;
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
      consultationRun: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    };
    makeTransaction(prisma);
    risk = { assess: vi.fn() };
    consultationChat = { stream: vi.fn().mockResolvedValue(fakeStream()) };
    contextBuilder = {
      build: vi.fn(async (input: any) => buildContextMessages(`ctx-${input.currentUserMessageId}`)),
    };
    attachmentService = { validateForUser: vi.fn(), bind: vi.fn(), getTexts: vi.fn(), upload: vi.fn() };
    dingtalk = {
      createGroup: vi.fn(), addMember: vi.fn(), sendNotification: vi.fn(), syncContacts: vi.fn(),
    };
    service = new ProjectService(
      prisma as any,
      risk as any,
      { writeBack: vi.fn() } as any,
      dingtalk as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { findAll: vi.fn(), findOne: vi.fn() } as any,
      new ProjectStateMachine() as any,
      { execute: vi.fn() } as any,
      new EscalateProjectToLegalUseCase(prisma) as any,
      // 真实编排器：内部调用 consultationChat/contextBuilder mock，原断言不变
      new ConsultationReplyOrchestrator(
        prisma,
        consultationChat,
        contextBuilder,
        { get: vi.fn((_k: string, d: unknown) => d) } as any,
        attachmentService,
      ) as any,
      attachmentService as any,
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
    expect(consultationChat.stream).not.toHaveBeenCalled();
  });

  it('风险分级包含受限附件正文（P1-4）：附件有重大违约则升级', async () => {
    risk.assess.mockResolvedValue({ risk: 'P1', route: 'legalbp', domain: '合同与交易' });
    attachmentService.getTexts.mockResolvedValue(['附件正文：合同约定违约金为合同总价 50%']);
    prisma.bpDomainMap.findMany.mockResolvedValue([]); // legalbp 需要匹配 BP

    await service.create(
      { kind: 'consult', title: '审查附件', input: '请审查附件', attachmentIds: ['att-1'] },
      'u-biz',
    );

    expect(attachmentService.validateForUser).toHaveBeenCalledWith(['att-1'], 'u-biz');
    expect(risk.assess).toHaveBeenCalledWith(expect.stringContaining('违约金'));
    expect(risk.assess).toHaveBeenCalledWith(expect.stringContaining('附件正文'));
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
    expect(consultationChat.stream).toHaveBeenCalledTimes(1); // 只启动一次 AI
    // 上下文经 ConsultationContextBuilder 重建（不传原始文本）
    expect(contextBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-1', currentUserMessageId: 'm1' }),
    );
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

    expect(consultationChat.stream).toHaveBeenCalledTimes(1); // 只有一个请求获得执行权
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

    expect(consultationChat.stream).not.toHaveBeenCalled();
    expect(result.message).toMatchObject({ id: 'a1', text: '已有答案' });
    expect(result.status).toBe('succeeded'); // F6：前端据此直接渲染已有答案
  });

  it('追问分支：写消息 + 认领 ConsultationRun + 上下文重建 + 触发一次 AI', async () => {
    prisma.projectMessage.create.mockResolvedValue({ id: 'm2', text: '追问' });
    prisma.consultationRun.findUnique.mockResolvedValue(null);
    prisma.consultationRun.create.mockResolvedValue({ id: 'run-2', status: 'running' });
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: null });

    const result = await service.createMessage('p-1', { text: '追问' }, { id: 'u-biz', role: 'business' });

    expect(prisma.projectMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.consultationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: 'p-1', userMessageId: 'm2' }) }),
    );
    expect(contextBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ currentUserMessageId: 'm2' }),
    );
    expect(consultationChat.stream).toHaveBeenCalledTimes(1);
    expect(result.route).toBe('llm');
  });

  it('追问已 succeeded 返回已有答案，不二次触发（每轮幂等）', async () => {
    prisma.projectMessage.create.mockResolvedValue({ id: 'm2', text: '追问' });
    prisma.projectMessage.findUnique.mockResolvedValue({ id: 'a2', role: 'assistant', text: '已有追问答案' });
    prisma.consultationRun.findUnique.mockResolvedValue({
      id: 'run-2', status: 'succeeded', answerMessageId: 'a2',
    });
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: null });

    const result = await service.createMessage('p-1', { text: '追问' }, { id: 'u-biz', role: 'business' });

    expect(consultationChat.stream).not.toHaveBeenCalled();
    expect(result.message).toMatchObject({ id: 'a2', text: '已有追问答案' });
  });

  it('F3：failed run 并发重试 CAS 抢占，只有一个请求启动模型', async () => {
    // 同 idempotencyKey 的两个并发重试，都读到同一个 failed run
    prisma.projectMessage.findUnique.mockResolvedValue({ id: 'm-ex', projectId: 'p-1', role: 'user', text: '问题' });
    prisma.consultationRun.findUnique.mockResolvedValue({ id: 'run-f', status: 'failed', answerMessageId: null });
    // CAS：第一个 updateMany 抢到(count=1)，第二个已被人抢(count=0)
    prisma.consultationRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await Promise.all([
      service.createMessage('p-1', { text: '问题', idempotencyKey: 'key-cas' }, { id: 'u-biz', role: 'business' }),
      service.createMessage('p-1', { text: '问题', idempotencyKey: 'key-cas' }, { id: 'u-biz', role: 'business' }),
    ]);

    expect(prisma.consultationRun.updateMany).toHaveBeenCalledTimes(2);
    expect(consultationChat.stream).toHaveBeenCalledTimes(1); // 只有 CAS 获胜者触发
  });

  it('同 idempotencyKey 重复请求：返回已有答案，不重复建消息/不重复触发', async () => {
    // 第一次：无既有消息 → 事务建消息 → 认领 run → 触发
    prisma.projectMessage.findUnique.mockResolvedValue(null); // clientKey 查询：无
    prisma.consultationRun.findUnique.mockResolvedValue(null);
    prisma.consultationRun.create.mockResolvedValue({ id: 'run-3', status: 'running' });
    prisma.projectMessage.create.mockResolvedValue({ id: 'm3', text: '问题' });
    risk.assess.mockResolvedValue({ risk: 'P2', route: 'llm', domain: null });

    await service.createMessage('p-1', { text: '问题', idempotencyKey: 'key-1' }, { id: 'u-biz', role: 'business' });
    expect(consultationChat.stream).toHaveBeenCalledTimes(1);

    // 第二次（同 key）：clientKey 命中已有消息 → run succeeded → 返回已有答案
    consultationChat.stream.mockClear();
    prisma.consultationRun.findUnique.mockResolvedValue({
      id: 'run-3', status: 'succeeded', answerMessageId: 'a3',
    });
    // 第 1 次 projectMessage.findUnique = clientKey 查询 → m3；后续 = answerMessageId 查询 → a3
    prisma.projectMessage.findUnique
      .mockResolvedValueOnce({ id: 'm3', projectId: 'p-1', role: 'user', text: '问题' })
      .mockResolvedValue({ id: 'a3', role: 'assistant', text: '答案' });

    const result = await service.createMessage('p-1', { text: '问题', idempotencyKey: 'key-1' }, { id: 'u-biz', role: 'business' });

    expect(prisma.projectMessage.create).toHaveBeenCalledTimes(1); // 不重复建消息
    expect(consultationChat.stream).not.toHaveBeenCalled(); // 不重复触发
    expect(result.message).toMatchObject({ id: 'a3', text: '答案' });
    expect(result.status).toBe('succeeded');
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
