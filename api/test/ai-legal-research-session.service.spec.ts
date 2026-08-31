import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiLegalResearchSessionService } from '../src/modules/legal-research/ai-legal-research-session.service';

function prismaHarness() {
  const prisma: any = {
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
      update: vi.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = vi.fn(async (value: unknown) => {
    if (typeof value === 'function') return (value as (tx: typeof prisma) => unknown)(prisma);
    return Promise.all(value as Promise<unknown>[]);
  });
  return prisma;
}

describe('AiLegalResearchSessionService', () => {
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
    const service = new AiLegalResearchSessionService(prisma);

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
    const service = new AiLegalResearchSessionService(prisma);

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
    const service = new AiLegalResearchSessionService(prisma);
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
  });
});
