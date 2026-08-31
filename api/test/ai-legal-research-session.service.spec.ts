import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AiLegalResearchSessionService } from '../src/modules/legal-research/ai-legal-research-session.service';

function prismaHarness() {
  const prisma: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'conversation-1' }]),
    projectMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    project: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    consultationRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = vi.fn(async (value: unknown) => {
    if (typeof value === 'function') return (value as (tx: typeof prisma) => unknown)(prisma);
    return Promise.all(value as Promise<unknown>[]);
  });
  return prisma;
}

function sessionService(prisma: any, queueTimeoutMs = 120_000) {
  return new AiLegalResearchSessionService(
    prisma,
    new ConfigService({ AI_EXECUTION_QUEUE_TIMEOUT_MS: queueTimeoutMs }),
  );
}

describe('AiLegalResearchSessionService', () => {
  function activeConversation(activeRunId = 'turn-active') {
    return {
      id: 'conversation-1',
      updatedAt: new Date('2026-08-31T10:00:00Z'),
      extra: {
        aiLegalResearch: {
          schemaVersion: 1,
          contextVersion: 3,
          knownFacts: ['合同于2023年签订'],
          legalIssues: ['违约责任'],
          lastTurnId: 'turn-3',
          activeRunId,
        },
      },
    };
  }

  function activeRun(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      id: 'turn-active',
      projectId: 'conversation-1',
      capability: 'law_search',
      status: 'running',
      startedAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('只有未过期的 running 轮次会阻止追问', async () => {
    const prisma = prismaHarness();
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    const withinQueueAndExecutionWindow = new Date(Date.now() - 5 * 60_000);
    prisma.consultationRun.findUnique.mockResolvedValue(activeRun({
      startedAt: withinQueueAndExecutionWindow,
      updatedAt: withinQueueAndExecutionWindow,
    }));
    const service = sessionService(prisma);

    await expect(service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('使用实际配置的队列超时计算运行租约', async () => {
    const prisma = prismaHarness();
    const queuedWithinConfiguredWindow = new Date(Date.now() - 7 * 60_000);
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    prisma.consultationRun.findUnique.mockResolvedValue(activeRun({
      startedAt: queuedWithinConfiguredWindow,
      updatedAt: queuedWithinConfiguredWindow,
    }));
    const service = sessionService(prisma, 5 * 60_000);

    await expect(service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.consultationRun.updateMany).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed', 'cancelled'])('清理 %s 终态轮次留下的 activeRunId 并允许新一轮', async (status) => {
    const prisma = prismaHarness();
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    prisma.consultationRun.findUnique.mockResolvedValue(activeRun({ status }));
    prisma.consultationRun.findFirst.mockResolvedValue(null);
    const service = sessionService(prisma);

    const prepared = await service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any });

    expect(prepared.contextVersion).toBe(4);
    expect(prepared.runId).not.toBe('turn-active');
    expect(prisma.consultationRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
  });

  it('清理找不到的 activeRunId 并允许新一轮', async () => {
    const prisma = prismaHarness();
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    prisma.consultationRun.findUnique.mockResolvedValue(null);
    prisma.consultationRun.findFirst.mockResolvedValue(null);
    const service = sessionService(prisma);

    const prepared = await service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any });

    expect(prepared.contextVersion).toBe(4);
    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
  });

  it('将过期 running 轮次与新轮认领放在同一事务中', async () => {
    const prisma = prismaHarness();
    const staleAt = new Date(Date.now() - 7 * 60_000);
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    prisma.consultationRun.findUnique.mockResolvedValue(activeRun({ startedAt: staleAt, updatedAt: staleAt }));
    prisma.consultationRun.findFirst.mockResolvedValue(null);
    const service = sessionService(prisma);

    const prepared = await service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any });

    expect(prepared.contextVersion).toBe(4);
    expect(prisma.consultationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'turn-active',
        projectId: 'conversation-1',
        capability: 'law_search',
        status: 'running',
        updatedAt: staleAt,
      },
      data: {
        status: 'failed',
        errorMessage: 'AI 搜法运行租约已过期，已自动释放会话。',
        completedAt: expect.any(Date),
      },
    });
    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.consultationRun.create).toHaveBeenCalledTimes(1);
  });

  it('过期轮次在清理前发生变化时不会覆盖新状态', async () => {
    const prisma = prismaHarness();
    const staleAt = new Date(Date.now() - 7 * 60_000);
    prisma.project.findFirst.mockResolvedValue(activeConversation());
    prisma.consultationRun.findUnique.mockResolvedValue(activeRun({ startedAt: staleAt, updatedAt: staleAt }));
    prisma.consultationRun.findFirst.mockResolvedValue(null);
    prisma.consultationRun.updateMany.mockResolvedValue({ count: 0 });
    const service = sessionService(prisma);

    await expect(service.prepareTurn({
      query: '继续分析',
      conversationId: 'conversation-1',
      contextVersion: 3,
      parentTurnId: 'turn-3',
    }, { id: 'legal-1', role: 'legal_bp' as any })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
    expect(prisma.consultationRun.create).not.toHaveBeenCalled();
  });

  it('恢复会话时将过期 activeRunId 视为已失败，不让前端无限轮询', async () => {
    const prisma = prismaHarness();
    const staleAt = new Date(Date.now() - 7 * 60_000);
    prisma.project.findFirst.mockResolvedValue({
      ...activeConversation(),
      title: '合同违约责任',
      messages: [{ id: 'message-active', text: '继续分析', label: 'continue' }],
    });
    prisma.consultationRun.findMany.mockResolvedValue([{
      ...activeRun({ startedAt: staleAt, updatedAt: staleAt }),
      userMessageId: 'message-active',
      researchTrace: null,
      toolSummary: null,
      dshSessionId: null,
      createdAt: staleAt,
      completedAt: null,
    }]);
    const service = sessionService(prisma);

    const restored = await service.getConversation('conversation-1', 'legal-1');

    expect(restored.activeRunId).toBeNull();
    expect(restored.turns[0]).toMatchObject({ turnId: 'turn-active', status: 'failed' });
    expect(prisma.consultationRun.updateMany).not.toHaveBeenCalled();
  });

  it('使用 contextVersion 与 parentTurnId 拒绝基于旧报告的并发追问', async () => {
    const prisma = prismaHarness();
    prisma.project.findFirst.mockResolvedValue({
      id: 'conversation-1',
      updatedAt: new Date('2026-08-31T10:00:00Z'),
      extra: {
        aiLegalResearch: {
          schemaVersion: 1,
          contextVersion: 3,
          knownFacts: ['合同于2023年签订'],
          legalIssues: ['违约责任'],
          lastTurnId: 'turn-3',
          activeRunId: null,
        },
      },
    });
    const service = sessionService(prisma);

    await expect(service.prepareTurn({
      query: '赔偿范围呢？',
      conversationId: 'conversation-1',
      contextVersion: 2,
      parentTurnId: 'turn-2',
    }, { id: 'legal-1', role: 'legal_bp' as any })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('自动识别事实修正，原子认领下一轮，并恢复上一轮 DSH 会话', async () => {
    const prisma = prismaHarness();
    prisma.project.findFirst.mockResolvedValue({
      id: 'conversation-1',
      updatedAt: new Date('2026-08-31T10:00:00Z'),
      extra: {
        aiLegalResearch: {
          schemaVersion: 1,
          contextVersion: 1,
          knownFacts: ['合同于2024年签订'],
          legalIssues: ['违约责任'],
          lastTurnId: 'turn-1',
          activeRunId: null,
        },
      },
    });
    prisma.consultationRun.findFirst.mockResolvedValue({ dshSessionId: 'dsh-previous' });
    const service = sessionService(prisma);

    const prepared = await service.prepareTurn({
      query: '不是2024年签订，是2023年签订',
      conversationId: 'conversation-1',
      contextVersion: 1,
      parentTurnId: 'turn-1',
      operation: 'auto',
      messageId: '08d85bd8-beb9-4891-9ed7-dc899690bb80',
    }, { id: 'legal-1', role: 'legal_bp' as any });

    expect(prepared).toMatchObject({
      conversationId: 'conversation-1',
      contextVersion: 2,
      operation: 'correct',
      resumeDshSessionId: 'dsh-previous',
      turnContext: {
        operation: 'correct',
        knownFacts: ['合同于2024年签订'],
        legalIssues: ['违约责任'],
      },
    });
    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-1', updatedAt: new Date('2026-08-31T10:00:00Z') },
    }));
    expect(prisma.projectMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clientKey: '08d85bd8-beb9-4891-9ed7-dc899690bb80', label: 'correct' }),
    }));
  });

  it('完成轮次后保存修正后的事实快照并释放 activeRunId', async () => {
    const prisma = prismaHarness();
    prisma.project.findUnique.mockResolvedValue({
      updatedAt: new Date('2026-08-31T10:02:00Z'),
      extra: {
        aiLegalResearch: {
          schemaVersion: 1,
          contextVersion: 2,
          knownFacts: ['合同于2024年签订'],
          legalIssues: ['违约责任'],
          lastTurnId: 'turn-1',
          activeRunId: 'turn-2',
        },
      },
    });
    const service = sessionService(prisma);
    const report: any = {
      summary: '已按2023年签订重新分析。',
      understanding: {
        knownFacts: ['合同于2023年签订'],
        legalIssues: ['违约责任', '诉讼时效'],
      },
    };

    await service.completeTurn({
      conversationId: 'conversation-1',
      contextVersion: 2,
      runId: 'turn-2',
      userMessageId: 'message-2',
      query: '不是2024年，是2023年',
      operation: 'correct',
      turnContext: { operation: 'correct', knownFacts: [], legalIssues: [] },
    }, {
      reportId: 'dsh-turn-2',
      report,
      trace: { report } as any,
      answer: '已修正。',
    });

    expect(prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        extra: expect.objectContaining({
          aiLegalResearch: expect.objectContaining({
            contextVersion: 2,
            knownFacts: ['合同于2023年签订'],
            legalIssues: ['违约责任', '诉讼时效'],
            lastTurnId: 'turn-2',
            activeRunId: null,
          }),
        }),
      }),
    }));
    expect(prisma.consultationRun.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'turn-2', status: 'running' }),
      data: { status: 'succeeded' },
    }));
    expect(prisma.projectMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.consultationRun.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
  });

  it('过期回收已获胜时丢弃迟到的成功结果', async () => {
    const prisma = prismaHarness();
    prisma.consultationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    const service = sessionService(prisma);
    const report: any = {
      summary: '迟到结果',
      understanding: { knownFacts: [], legalIssues: [] },
    };

    await expect(service.completeTurn({
      conversationId: 'conversation-1',
      contextVersion: 2,
      runId: 'turn-expired',
      userMessageId: 'message-expired',
      query: '迟到问题',
      operation: 'continue',
      turnContext: { operation: 'continue', knownFacts: [], legalIssues: [] },
    }, {
      reportId: 'dsh-expired',
      report,
      trace: { report } as any,
      answer: '迟到回答',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
  });

  it('迟到完成不会清除已由新一轮持有的 activeRunId', async () => {
    const prisma = prismaHarness();
    prisma.project.findUnique.mockResolvedValue({
      updatedAt: new Date('2026-08-31T10:03:00Z'),
      extra: {
        aiLegalResearch: {
          schemaVersion: 1,
          contextVersion: 3,
          knownFacts: [],
          legalIssues: [],
          lastTurnId: 'turn-1',
          activeRunId: 'turn-new',
        },
      },
    });
    const service = sessionService(prisma);
    const report: any = {
      summary: '迟到结果',
      understanding: { knownFacts: [], legalIssues: [] },
    };

    await expect(service.completeTurn({
      conversationId: 'conversation-1',
      contextVersion: 2,
      runId: 'turn-old',
      userMessageId: 'message-old',
      query: '旧问题',
      operation: 'continue',
      turnContext: { operation: 'continue', knownFacts: [], legalIssues: [] },
    }, {
      reportId: 'dsh-old',
      report,
      trace: { report } as any,
      answer: '旧回答',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(prisma.projectMessage.create).not.toHaveBeenCalled();
    expect(prisma.consultationRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'turn-old', status: 'succeeded' }),
      data: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('迟到失败不会覆盖已终态轮次或新一轮锁', async () => {
    const prisma = prismaHarness();
    prisma.consultationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    const service = sessionService(prisma);

    await service.failTurn({
      conversationId: 'conversation-1',
      contextVersion: 2,
      runId: 'turn-old',
      userMessageId: 'message-old',
      query: '旧问题',
      operation: 'continue',
      turnContext: { operation: 'continue', knownFacts: [], legalIssues: [] },
    }, new Error('迟到失败'));

    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
