import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationReplyOrchestrator } from '../src/modules/project/application/consultation-reply.orchestrator';

describe('ConsultationReplyOrchestrator 审计关联', () => {
  it('AI 完成时保存模型、工具摘要、输出哈希并写 ai.run.succeeded', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      thinking: new PassThrough(),
      __finalText: 'AI 法律结论',
    });
    const prisma: any = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ extra: null, skillName: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      projectMessage: { create: vi.fn().mockResolvedValue({ id: 'answer-1', text: 'AI 法律结论' }) },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-1', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
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

    expect(prisma.consultationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1' },
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
        findUnique: vi.fn().mockResolvedValue({ extra: null, skillName: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      projectMessage: { create: vi.fn().mockResolvedValue({ id: 'answer-degraded' }) },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-degraded', capability: 'law_search' }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
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
      project: { findUnique: vi.fn().mockResolvedValue({ extra: null, skillName: null }) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-start-fail', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
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

    expect(prisma.consultationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-start-fail' },
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
        findUnique: vi.fn().mockResolvedValue({ extra: null, skillName: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      projectEvent: { create: vi.fn().mockResolvedValue({}) },
      consultationRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-dual-event', capability: 'general' }),
        update: vi.fn().mockResolvedValue({}),
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
});
