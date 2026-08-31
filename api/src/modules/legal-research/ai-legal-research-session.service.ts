import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiLawResearchReportV1,
  AiLawResearchTurnContext,
} from '../../common/services/ai-law-research-report';
import { ResearchTraceV1 } from '../project/application/research-trace';
import { AiLawResearchDto } from './dto/legal-research.dto';

export type AiResearchTurnOperation = 'new' | 'continue' | 'correct' | 'new_issue';

interface AiResearchConversationStateV1 {
  schemaVersion: 1;
  contextVersion: number;
  knownFacts: string[];
  legalIssues: string[];
  lastTurnId: string | null;
  activeRunId: string | null;
}

export interface PreparedAiResearchTurn {
  conversationId: string;
  contextVersion: number;
  runId: string;
  userMessageId: string;
  query: string;
  operation: AiResearchTurnOperation;
  turnContext: AiLawResearchTurnContext;
  resumeDshSessionId?: string;
  replay?: {
    reportId: string;
    report: AiLawResearchReportV1;
    trace: ResearchTraceV1;
    degraded?: boolean;
    warning?: { code: string; message: string };
  };
}

@Injectable()
export class AiLegalResearchSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async prepareTurn(dto: AiLawResearchDto, actor: { id: string; role: Role }): Promise<PreparedAiResearchTurn> {
    const query = dto.query.trim();
    const clientMessageId = dto.messageId ?? randomUUID();
    const duplicate = await this.prisma.projectMessage.findUnique({ where: { clientKey: clientMessageId } });
    if (duplicate) return this.replayExistingTurn(duplicate.projectId, duplicate.id, actor.id);

    if (!dto.conversationId) {
      return this.createConversation(query, clientMessageId, actor);
    }

    const project = await this.prisma.project.findFirst({
      where: { id: dto.conversationId, kind: 'research', creatorId: actor.id },
      select: { id: true, extra: true, updatedAt: true },
    });
    if (!project) throw new NotFoundException({ error: '检索会话不存在或无权访问', code: 'AI_RESEARCH_CONVERSATION_NOT_FOUND' });
    const state = readState(project.extra);
    if (state.activeRunId) {
      throw conflict('上一轮仍在处理中，请等待完成后继续追问', state.contextVersion, state.lastTurnId);
    }
    if (dto.contextVersion !== undefined && dto.contextVersion !== state.contextVersion) {
      throw conflict('检索会话已更新，请刷新后再继续追问', state.contextVersion, state.lastTurnId);
    }
    if (dto.parentTurnId && dto.parentTurnId !== state.lastTurnId) {
      throw conflict('追问基于的报告不是最新版本，请刷新后重试', state.contextVersion, state.lastTurnId);
    }

    const operation = normalizeOperation(dto.operation, query, true);
    const runId = randomUUID();
    const userMessageId = randomUUID();
    const nextVersion = state.contextVersion + 1;
    const claimedState: AiResearchConversationStateV1 = {
      ...state,
      contextVersion: nextVersion,
      activeRunId: runId,
    };
    const previous = state.lastTurnId
      ? await this.prisma.consultationRun.findFirst({
        where: { id: state.lastTurnId, projectId: project.id, status: 'succeeded' },
        select: { dshSessionId: true },
      })
      : null;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.project.updateMany({
        where: { id: project.id, updatedAt: project.updatedAt },
        data: { extra: mergeState(project.extra, claimedState) },
      });
      if (claimed.count !== 1) {
        throw conflict('检索会话已被另一轮更新，请刷新后重试', state.contextVersion, state.lastTurnId);
      }
      await tx.projectMessage.create({
        data: {
          id: userMessageId,
          projectId: project.id,
          role: 'user',
          text: query,
          label: operation,
          clientKey: clientMessageId,
        },
      });
      await tx.consultationRun.create({
        data: {
          id: runId,
          projectId: project.id,
          userMessageId,
          status: 'running',
          capability: 'law_search',
        },
      });
    });

    return {
      conversationId: project.id,
      contextVersion: nextVersion,
      runId,
      userMessageId,
      query,
      operation,
      turnContext: {
        operation,
        knownFacts: state.knownFacts,
        legalIssues: state.legalIssues,
      },
      ...(previous?.dshSessionId ? { resumeDshSessionId: previous.dshSessionId } : {}),
    };
  }

  async completeTurn(
    prepared: PreparedAiResearchTurn,
    result: {
      reportId: string;
      report: AiLawResearchReportV1;
      trace: ResearchTraceV1;
      answer: string;
      degraded?: boolean;
      warning?: { code: string; message: string };
    },
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: prepared.conversationId },
      select: { extra: true },
    });
    if (!project) return;
    const state = readState(project.extra);
    const nextState: AiResearchConversationStateV1 = state.activeRunId === prepared.runId
      ? {
        ...state,
        knownFacts: result.report.understanding.knownFacts.slice(0, 20),
        legalIssues: result.report.understanding.legalIssues.slice(0, 12),
        lastTurnId: prepared.runId,
        activeRunId: null,
      }
      : state;
    const answerMessageId = randomUUID();
    const outputHash = createHash('sha256').update(result.answer).digest('hex');
    await this.prisma.$transaction([
      this.prisma.projectMessage.create({
        data: {
          id: answerMessageId,
          projectId: prepared.conversationId,
          role: 'assistant',
          text: result.answer,
          label: 'ai_law_report',
        },
      }),
      this.prisma.consultationRun.update({
        where: { id: prepared.runId },
        data: {
          status: 'succeeded',
          answerMessageId,
          dshSessionId: result.reportId,
          researchTrace: result.trace as unknown as Prisma.InputJsonValue,
          toolSummary: {
            operation: prepared.operation,
            degraded: Boolean(result.degraded),
            warning: result.warning ?? null,
          },
          outputHash,
          completedAt: new Date(),
        },
      }),
      this.prisma.project.update({
        where: { id: prepared.conversationId },
        data: {
          status: '已回传',
          isFailed: false,
          result: result.report.summary,
          extra: mergeState(project.extra, nextState),
        },
      }),
    ]);
  }

  async failTurn(prepared: PreparedAiResearchTurn, error: Error, cancelled = false): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: prepared.conversationId },
      select: { extra: true },
    }).catch(() => null);
    const state = readState(project?.extra);
    const nextState = state.activeRunId === prepared.runId ? { ...state, activeRunId: null } : state;
    await this.prisma.$transaction([
      this.prisma.consultationRun.update({
        where: { id: prepared.runId },
        data: {
          status: cancelled ? 'cancelled' : 'failed',
          errorMessage: error.message.slice(0, 2_000),
          completedAt: new Date(),
        },
      }),
      ...(project ? [this.prisma.project.update({
        where: { id: prepared.conversationId },
        data: { extra: mergeState(project.extra, nextState) },
      })] : []),
    ]).catch(() => undefined);
  }

  async getConversation(conversationId: string, actorId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: conversationId, kind: 'research', creatorId: actorId },
      select: {
        id: true,
        title: true,
        extra: true,
        messages: { where: { role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!project) throw new NotFoundException({ error: '检索会话不存在或无权访问', code: 'AI_RESEARCH_CONVERSATION_NOT_FOUND' });
    const runs = await this.prisma.consultationRun.findMany({
      where: { projectId: conversationId, capability: 'law_search' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const messages = new Map(project.messages.map((message) => [message.id, message]));
    return {
      conversationId: project.id,
      title: project.title,
      ...readState(project.extra),
      turns: runs.map((run) => {
        const trace = asRecord(run.researchTrace) as unknown as ResearchTraceV1 | undefined;
        const toolSummary = asRecord(run.toolSummary);
        const message = messages.get(run.userMessageId);
        return {
          turnId: run.id,
          question: message?.text ?? '',
          operation: message?.label ?? 'continue',
          status: run.status,
          reportId: run.dshSessionId,
          report: trace?.report,
          degraded: toolSummary?.degraded === true,
          warning: isWarning(toolSummary?.warning) ? toolSummary.warning : undefined,
          createdAt: run.createdAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  private async createConversation(
    query: string,
    clientMessageId: string,
    actor: { id: string; role: Role },
  ): Promise<PreparedAiResearchTurn> {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const userMessageId = randomUUID();
    const state: AiResearchConversationStateV1 = {
      schemaVersion: 1,
      contextVersion: 1,
      knownFacts: [],
      legalIssues: [],
      lastTurnId: null,
      activeRunId: runId,
    };
    await this.prisma.$transaction([
      this.prisma.project.create({
        data: {
          id: conversationId,
          kind: 'research',
          title: query.slice(0, 80),
          status: '分析中',
          risk: 'P2',
          route: 'llm',
          creatorId: actor.id,
          ownerId: actor.id,
          extra: mergeState(null, state),
        },
      }),
      this.prisma.projectMessage.create({
        data: {
          id: userMessageId,
          projectId: conversationId,
          role: 'user',
          text: query,
          label: 'new',
          clientKey: clientMessageId,
        },
      }),
      this.prisma.consultationRun.create({
        data: {
          id: runId,
          projectId: conversationId,
          userMessageId,
          status: 'running',
          capability: 'law_search',
        },
      }),
    ]);
    return {
      conversationId,
      contextVersion: 1,
      runId,
      userMessageId,
      query,
      operation: 'new',
      turnContext: { operation: 'new', knownFacts: [], legalIssues: [] },
    };
  }

  private async replayExistingTurn(projectId: string, userMessageId: string, actorId: string): Promise<PreparedAiResearchTurn> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, kind: 'research', creatorId: actorId },
      select: { extra: true },
    });
    if (!project) throw conflict('消息幂等键已被其他会话使用', 0, null);
    const run = await this.prisma.consultationRun.findUnique({ where: { userMessageId } });
    if (!run || run.status !== 'succeeded' || !run.researchTrace || !run.dshSessionId) {
      throw conflict('该轮检索正在处理或尚未成功，请稍后刷新', readState(project.extra).contextVersion, run?.id ?? null);
    }
    const trace = run.researchTrace as unknown as ResearchTraceV1;
    if (!trace.report) throw conflict('已完成轮次缺少结构化报告，请重新发起检索', readState(project.extra).contextVersion, run.id);
    const toolSummary = asRecord(run.toolSummary);
    const userMessage = await this.prisma.projectMessage.findUnique({ where: { id: userMessageId } });
    const state = readState(project.extra);
    if (state.lastTurnId !== run.id) {
      throw conflict('该幂等消息属于历史轮次，请刷新当前检索会话', state.contextVersion, state.lastTurnId);
    }
    return {
      conversationId: projectId,
      contextVersion: state.contextVersion,
      runId: run.id,
      userMessageId,
      query: userMessage?.text ?? trace.report.query,
      operation: normalizeStoredOperation(userMessage?.label),
      turnContext: {
        operation: normalizeStoredOperation(userMessage?.label),
        knownFacts: state.knownFacts,
        legalIssues: state.legalIssues,
      },
      replay: {
        reportId: run.dshSessionId,
        report: trace.report,
        trace,
        ...(toolSummary?.degraded === true ? { degraded: true } : {}),
        ...(isWarning(toolSummary?.warning) ? { warning: toolSummary.warning } : {}),
      },
    };
  }
}

function normalizeOperation(
  requested: AiLawResearchDto['operation'],
  query: string,
  hasConversation: boolean,
): AiResearchTurnOperation {
  if (!hasConversation) return 'new';
  if (requested && requested !== 'auto') return requested;
  return /(?:不是|说错了|更正|纠正|改为|实际是|应为)/u.test(query) ? 'correct' : 'continue';
}

function normalizeStoredOperation(value: string | null | undefined): AiResearchTurnOperation {
  return value === 'new' || value === 'correct' || value === 'new_issue' ? value : 'continue';
}

function readState(extra: unknown): AiResearchConversationStateV1 {
  const root = asRecord(extra);
  const value = asRecord(root?.aiLegalResearch);
  return {
    schemaVersion: 1,
    contextVersion: positiveInt(value?.contextVersion, 0),
    knownFacts: stringArray(value?.knownFacts, 20, 300),
    legalIssues: stringArray(value?.legalIssues, 12, 160),
    lastTurnId: typeof value?.lastTurnId === 'string' ? value.lastTurnId : null,
    activeRunId: typeof value?.activeRunId === 'string' ? value.activeRunId : null,
  };
}

function mergeState(extra: unknown, state: AiResearchConversationStateV1): Prisma.InputJsonValue {
  const root = asRecord(extra) ?? {};
  return {
    ...root,
    aiLegalResearch: state,
  } as unknown as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength));
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isWarning(value: unknown): value is { code: string; message: string } {
  const record = asRecord(value);
  return typeof record?.code === 'string' && typeof record.message === 'string';
}

function conflict(error: string, currentVersion: number, lastTurnId: string | null) {
  return new ConflictException({
    error,
    code: 'AI_RESEARCH_CONTEXT_CONFLICT',
    currentVersion,
    lastTurnId,
  });
}
