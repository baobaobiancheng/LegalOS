import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationReplyOrchestrator } from '../src/modules/project/application/consultation-reply.orchestrator';

const PROJECT_VERSION = {
  extra: null,
  skillName: null,
  updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  route: 'llm',
  status: '分析中',
  result: null,
  reviewStatus: null,
  ownerId: 'owner-1',
  legalBpId: null,
};

function statefulConsultationDb() {
  const state = {
    project: { ...PROJECT_VERSION },
    run: { id: 'run-late', projectId: 'p-late', userMessageId: 'm-late', status: 'running', capability: 'general' },
    messages: [] as any[],
    events: [] as any[],
  };
  const matchesProject = (where: any) =>
    where.id === 'p-late'
    && where.updatedAt?.getTime() === state.project.updatedAt.getTime()
    && ['route', 'status', 'result', 'reviewStatus', 'ownerId', 'legalBpId']
      .every((key) => where[key] === (state.project as any)[key]);
  const matchesRun = (where: any) =>
    where.id === state.run.id
    && where.projectId === state.run.projectId
    && where.userMessageId === state.run.userMessageId
    && where.status === state.run.status;
  const prisma: any = {
    project: {
      findUnique: vi.fn(async () => ({ ...state.project })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!matchesProject(where)) return { count: 0 };
        Object.assign(state.project, data);
        return { count: 1 };
      }),
    },
    projectMessage: {
      create: vi.fn(async ({ data }: any) => {
        state.messages.push(data);
        return data;
      }),
    },
    projectEvent: {
      create: vi.fn(async ({ data }: any) => {
        state.events.push(data);
        return data;
      }),
    },
    consultationRun: {
      findUnique: vi.fn(async () => ({ ...state.run })),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!matchesRun(where)) return { count: 0 };
        Object.assign(state.run, data);
        return { count: 1 };
      }),
    },
  };
  prisma.$transaction = vi.fn(async (callback: any) => {
    const projectBefore = { ...state.project };
    const runBefore = { ...state.run };
    const messageCount = state.messages.length;
    const eventCount = state.events.length;
    try {
      return await callback(prisma);
    } catch (error) {
      Object.assign(state.project, projectBefore);
      Object.assign(state.run, runBefore);
      state.messages.splice(messageCount);
      state.events.splice(eventCount);
      throw error;
    }
  });
  return { prisma, state };
}

describe('ConsultationReplyOrchestrator 审计关联', () => {
  it('数据库及失败审计同时故障时，完成回调不泄漏拒绝且释放串行锁', async () => {
    const { prisma } = statefulConsultationDb();
    const child: any = Object.assign(new EventEmitter(), { stdout: new PassThrough(), __finalText: '测试结果' });
    const audit = { record: vi.fn().mockResolvedValue({}), digestCanonical: vi.fn().mockReturnValue('hash') };
    const orchestrator = new ConsultationReplyOrchestrator(prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any, {} as any, audit as any);
    const result = await orchestrator.reply('p-late', 'm-late', undefined, 'run-late', 'general');
    prisma.$transaction.mockRejectedValue(new Error('database unavailable'));
    audit.record.mockRejectedValue(new Error('audit unavailable'));
    // 直接观察 EventEmitter 将忽略的返回值，确保这个异步监听器本身也已处理拒绝。
    await expect(child.listeners('close')[0](0)).resolves.toBeUndefined();
    await expect(result.completion).rejects.toThrow('database unavailable');
    const release = await (orchestrator as any).acquireProjectTurn('p-late');
    release();
  });
  it('A 释放后 B 执行期间新来的 C 仍排在 B 之后', async () => {
    const orchestrator = new ConsultationReplyOrchestrator(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const acquire = (projectId: string) => (orchestrator as any).acquireProjectTurn(projectId) as Promise<() => void>;

    const releaseA = await acquire('p-serial');
    const waitingB = acquire('p-serial');
    releaseA();
    const releaseB = await waitingB;
    let cEntered = false;
    const waitingC = acquire('p-serial').then((release) => {
      cEntered = true;
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cEntered).toBe(false);

    releaseB();
    const releaseC = await waitingC;
    expect(cEntered).toBe(true);
    releaseC();
  });

  it('AI 完成时保存模型、工具摘要、输出哈希并写 ai.run.succeeded', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
      __finalText: 'AI 法律结论',
    });
    const prisma: any = {
      project: {
        // 上一轮 AI 已回传但没有人工 review_completed，后续 AI 轮次仍允许完成。
        findUnique: vi.fn().mockResolvedValue({ ...PROJECT_VERSION, status: '已回传' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      projectMessage: { create: vi.fn().mockResolvedValue({ id: 'answer-1', text: 'AI 法律结论' }) },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-1', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    const audit = {
      record: vi.fn().mockResolvedValue({ eventId: 'audit-ai-1' }),
      digestCanonical: vi.fn().mockReturnValue('output-hash'),
    };
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: '问题' }] }) } as any,
      { get: (key: string, fallback?: unknown) => key === 'LLM_MODEL' ? 'glm-5-2' : fallback } as any,
      {} as any,
      audit as any,
    );

    const result = await orchestrator.reply('p-1', 'message-1', undefined, 'run-1', 'general');
    child.emit('close', 0);
    await result.completion;

    expect(prisma.consultationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-1', status: 'running' }),
      data: expect.objectContaining({
        status: 'succeeded',
        modelVersion: 'glm-5-2',
        toolSummary: [],
        outputHash: 'output-hash',
      }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.run.succeeded',
      resourceId: 'run-1',
      projectId: 'p-1',
      metadata: expect.objectContaining({
        modelVersion: 'glm-5-2',
        outputHash: 'output-hash',
      }),
    }), prisma);
  });

  it('业务咨询法规核验降级时写 partial 审计事件和原因码', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
      __finalText: '已保留可安全展示的法规原文',
      __researchDegraded: { level: 'verified_evidence', reasonCode: 'RESEARCH_CITATION_MISSING' },
    });
    const prisma: any = {
      project: {
        findUnique: vi.fn().mockResolvedValue(PROJECT_VERSION),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      projectMessage: { create: vi.fn().mockResolvedValue({ id: 'answer-degraded' }) },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-degraded', capability: 'law_search' }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    const audit = {
      record: vi.fn().mockResolvedValue({}),
      digestCanonical: vi.fn().mockReturnValue('degraded-output-hash'),
    };
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: '法律问题' }] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
      audit as any,
    );

    const result = await orchestrator.reply('p-degraded', 'message-degraded', undefined, 'run-degraded', 'law_search');
    child.emit('close', 0);
    await result.completion;

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.run.degraded',
      outcome: 'partial',
      reasonCode: 'RESEARCH_CITATION_MISSING',
      metadata: expect.objectContaining({ fallbackLevel: 'verified_evidence' }),
    }), prisma);
  });

  it('AI 执行器启动失败时，Run 与 ai.run.failed 在同一事务落库', async () => {
    const prisma: any = {
      project: { findUnique: vi.fn().mockResolvedValue(PROJECT_VERSION) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-start-fail', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    const audit = {
      record: vi.fn().mockResolvedValue({}),
      digestCanonical: vi.fn().mockReturnValue('error-hash'),
    };
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockRejectedValue(new Error('spawn failed')) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
      audit as any,
    );

    await expect(orchestrator.reply('p-1', 'message-1', undefined, 'run-start-fail', 'general'))
      .rejects.toThrow('spawn failed');

    expect(prisma.consultationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-start-fail', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', modelVersion: 'glm-5-2' }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.run.failed',
      reasonCode: 'AI_START_FAILED',
      metadata: expect.objectContaining({ phase: 'startup' }),
    }), prisma);
  });

  it('AI 流同时发出 error 和 close 时只写一次失败终态', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
    });
    const prisma: any = {
      project: {
        findUnique: vi.fn().mockResolvedValue(PROJECT_VERSION),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-dual-event', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: any) => callback(prisma)),
    };
    const audit = {
      record: vi.fn().mockResolvedValue({}),
      digestCanonical: vi.fn().mockReturnValue('error-hash'),
    };
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
      audit as any,
    );

    const result = await orchestrator.reply('p-1', 'message-1', undefined, 'run-dual-event', 'general');
    child.emit('error', new Error('stream failed'));
    child.emit('close', 1);
    await expect(result.completion).rejects.toThrow('stream failed');
    await new Promise((resolve) => setImmediate(resolve));

    const failedCalls = audit.record.mock.calls.filter(([input]: any[]) => input.action === 'ai.run.failed');
    expect(failedCalls).toHaveLength(1);
    expect(prisma.projectEvent.create).toHaveBeenCalledTimes(1);
  });

  it('排队期间转成人工终态时不启动执行器，并结束已认领 run', async () => {
    const projectState: any = { ...PROJECT_VERSION };
    const execute = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma: any = {
      project: { findUnique: vi.fn(async () => ({ ...projectState })) },
      consultationRun: { updateMany },
    };
    prisma.$transaction = vi.fn(async (callback: any) => callback(prisma));
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute } as any,
      { build: vi.fn() } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
    );
    const releaseAhead = await (orchestrator as any).acquireProjectTurn('p-queued');
    const queued = orchestrator.reply('p-queued', 'm-queued', undefined, 'run-queued', 'general');

    Object.assign(projectState, {
      status: '已回传',
      result: '排队期间的人工回复',
      reviewStatus: 'review_completed',
    });
    releaseAhead();

    await expect(queued).rejects.toThrow('工单已进入人工流程');
    expect(execute).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-queued', status: 'running' }),
      data: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('人工正式回复与 AI 成功交错时保留人工结果，并将迟到 run 置为 cancelled', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
      __finalText: '迟到的 AI 结果',
    });
    const { prisma, state } = statefulConsultationDb();
    const audit = { record: vi.fn(), digestCanonical: vi.fn().mockReturnValue('hash') };
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
      audit as any,
    );

    const result = await orchestrator.reply('p-late', 'm-late', undefined, 'run-late', 'general');
    Object.assign(state.project, {
      status: '已回传',
      result: '人工法务结论',
      reviewStatus: 'review_completed',
      updatedAt: new Date('2026-09-08T00:00:01.000Z'),
    });
    child.emit('close', 0);
    await expect(result.completion).rejects.toThrow();

    expect(state.project).toMatchObject({
      status: '已回传', result: '人工法务结论', reviewStatus: 'review_completed',
    });
    expect(state.run.status).toBe('cancelled');
    expect(state.messages).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('人工正式回复与 AI 失败交错时不复活待处理状态，run 不悬挂', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
      __errorMessage: '上游失败',
    });
    const { prisma, state } = statefulConsultationDb();
    const orchestrator = new ConsultationReplyOrchestrator(
      prisma,
      { execute: vi.fn().mockResolvedValue(child) } as any,
      { build: vi.fn().mockResolvedValue({ messages: [] }) } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
    );

    const result = await orchestrator.reply('p-late', 'm-late', undefined, 'run-late', 'general');
    Object.assign(state.project, {
      status: '已回传',
      result: '人工法务结论',
      reviewStatus: 'review_completed',
      updatedAt: new Date('2026-09-08T00:00:01.000Z'),
    });
    child.emit('close', 1);
    await expect(result.completion).rejects.toThrow('上游失败');

    expect(state.project).toMatchObject({ status: '已回传', result: '人工法务结论' });
    expect(state.run.status).toBe('cancelled');
    expect(state.events).toEqual([]);
  });
});
