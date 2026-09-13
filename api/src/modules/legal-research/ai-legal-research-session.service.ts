import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiLawResearchReportV1,
  AiLawResearchTurnContext,
} from '../../common/services/ai-law-research-report';
import { ResearchTraceV1 } from '../project/application/research-trace';
import { AiLawResearchDto } from './dto/legal-research.dto';
import { DSH_SESSION_PREFIX } from '../../common/services/dsh-runtime';

export type AiResearchTurnOperation = 'new' | 'continue' | 'correct' | 'new_issue';

const AI_RESEARCH_EXECUTION_TIMEOUT_MS = 180_000;
const AI_RESEARCH_RUN_LEASE_BUFFER_MS = 60_000;

interface ActiveAiResearchRun {
  id: string;
  projectId: string;
  capability: string;
  status: string;
  startedAt: Date;
  updatedAt: Date;
}

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
  private readonly runLeaseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const configuredQueueTimeout = Number(
      config.get<string>('AI_EXECUTION_QUEUE_TIMEOUT_MS')
      ?? config.get<string>('CODEX_QUEUE_TIMEOUT_MS')
      ?? 120_000,
    );
    const queueTimeoutMs = Number.isFinite(configuredQueueTimeout)
      ? Math.max(0, configuredQueueTimeout)
      : 120_000;
    this.runLeaseMs = queueTimeoutMs
      + AI_RESEARCH_EXECUTION_TIMEOUT_MS
      + AI_RESEARCH_RUN_LEASE_BUFFER_MS;
  }

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
    const activeRun = state.activeRunId
      ? await this.prisma.consultationRun.findUnique({
        where: { id: state.activeRunId },
        select: {
          id: true,
          projectId: true,
          capability: true,
          status: true,
          startedAt: true,
          updatedAt: true,
        },
      })
      : null;
    if (isBlockingActiveRun(activeRun, project.id, this.runLeaseMs)) {
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
        where: {
          id: state.lastTurnId, projectId: project.id, status: 'succeeded',
          dshSessionId: { startsWith: DSH_SESSION_PREFIX },
        },
        select: { dshSessionId: true },
      })
      : null;

    await this.prisma.$transaction(async (tx) => {
      if (isExpiredActiveRun(activeRun, project.id, this.runLeaseMs)) {
        const retired = await tx.consultationRun.updateMany({
          where: {
            id: activeRun.id,
            projectId: project.id,
            capability: 'law_search',
            status: 'running',
            updatedAt: activeRun.updatedAt,
          },
          data: {
            status: 'failed',
            errorMessage: 'AI 搜法运行租约已过期，已自动释放会话。',
            completedAt: new Date(),
          },
        });
        if (retired.count !== 1) {
          throw conflict('检索会话运行状态已更新，请刷新后重试', state.contextVersion, state.lastTurnId);
        }
      }
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
    const answerMessageId = randomUUID();
    const outputHash = createHash('sha256').update(result.answer).digest('hex');
    const committed = await this.prisma.$transaction(async (tx) => {
      // consultationRun.status 是终态写入的 CAS 锁：过期回收、成功和失败只能有一方获胜。
      const finalized = await tx.consultationRun.updateMany({
        where: {
          id: prepared.runId,
          projectId: prepared.conversationId,
          capability: 'law_search',
          status: 'running',
        },
        data: { status: 'succeeded' },
      });
      if (finalized.count !== 1) return false;

      const retireLateResult = async () => {
        await tx.consultationRun.updateMany({
          where: {
            id: prepared.runId,
            projectId: prepared.conversationId,
            status: 'succeeded',
          },
          data: {
            status: 'failed',
            errorMessage: 'AI 搜法结果返回时会话已进入新一轮，已丢弃迟到结果。',
            completedAt: new Date(),
          },
        });
      };

      // MySQL 默认 REPEATABLE READ 下不在同一快照内循环重读；
      // 按 consultationRun -> project 的统一顺序锁住项目行，再读取最新会话状态。
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${prepared.conversationId} FOR UPDATE`;
      const project = await tx.project.findUnique({
        where: { id: prepared.conversationId },
        select: { extra: true },
      });
      if (!project) {
        await retireLateResult();
        return false;
      }
      const state = readState(project.extra);
      if (state.activeRunId !== prepared.runId) {
        await retireLateResult();
        return false;
      }
      const nextState: AiResearchConversationStateV1 = {
        ...state,
        knownFacts: result.report.understanding.knownFacts.slice(0, 20),
        legalIssues: result.report.understanding.legalIssues.slice(0, 12),
        lastTurnId: prepared.runId,
        activeRunId: null,
      };
      await tx.project.update({
        where: { id: prepared.conversationId },
        data: {
          status: '已回传',
          isFailed: false,
          result: result.report.summary,
          extra: mergeState(project.extra, nextState),
        },
      });

      await tx.projectMessage.create({
        data: {
          id: answerMessageId,
          projectId: prepared.conversationId,
          role: 'assistant',
          text: result.answer,
          label: 'ai_law_report',
        },
      });
      const stored = await tx.consultationRun.updateMany({
        where: {
          id: prepared.runId,
          projectId: prepared.conversationId,
          status: 'succeeded',
        },
        data: {
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
      });
      if (stored.count !== 1) throw new Error('AI 搜法终态写入失败');
      return true;
    });
    if (!committed) {
      throw conflict('该轮检索已过期或会话已进入新一轮，正在同步最新状态', prepared.contextVersion, null);
    }
  }

  async failTurn(prepared: PreparedAiResearchTurn, error: Error, cancelled = false): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const finalized = await tx.consultationRun.updateMany({
        where: {
          id: prepared.runId,
          projectId: prepared.conversationId,
          capability: 'law_search',
          status: 'running',
        },
        data: {
          status: cancelled ? 'cancelled' : 'failed',
          errorMessage: error.message.slice(0, 2_000),
          completedAt: new Date(),
        },
      });
      if (finalized.count !== 1) return;

      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${prepared.conversationId} FOR UPDATE`;
      const project = await tx.project.findUnique({
        where: { id: prepared.conversationId },
        select: { extra: true },
      });
      if (!project) return;
      const state = readState(project.extra);
      if (state.activeRunId !== prepared.runId) return;
      await tx.project.update({
        where: { id: prepared.conversationId },
        data: { extra: mergeState(project.extra, { ...state, activeRunId: null }) },
      });
    });
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
    const state = readState(project.extra);
    const activeRun = state.activeRunId
      ? runs.find((run) => run.id === state.activeRunId) ?? null
      : null;
    const expiredActiveRunId = isExpiredActiveRun(activeRun, project.id, this.runLeaseMs) ? activeRun.id : null;
    const activeRunId = activeRun && isBlockingActiveRun(activeRun, project.id, this.runLeaseMs) ? activeRun.id : null;
    const messages = new Map(project.messages.map((message) => [message.id, message]));
    return {
      conversationId: project.id,
      title: project.title,
      ...state,
      // GET 恢复时不让终态、丢失或租约过期的 activeRunId 把前端永久锁住。
      // 真正发起下一轮时 prepareTurn 会在事务中持久化清理。
      activeRunId,
      turns: runs.map((run) => {
        const trace = asRecord(run.researchTrace) as unknown as ResearchTraceV1 | undefined;
        const toolSummary = asRecord(run.toolSummary);
        const message = messages.get(run.userMessageId);
        return {
          turnId: run.id,
          question: message?.text ?? '',
          operation: message?.label ?? 'continue',
          status: run.id === expiredActiveRunId ? 'failed' : run.status,
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

function isBlockingActiveRun(
  run: ActiveAiResearchRun | null,
  projectId: string,
  runLeaseMs: number,
): boolean {
  return isMatchingRunningRun(run, projectId) && !isRunLeaseExpired(run, runLeaseMs);
}

function isExpiredActiveRun(
  run: ActiveAiResearchRun | null,
  projectId: string,
  runLeaseMs: number,
): run is ActiveAiResearchRun {
  return isMatchingRunningRun(run, projectId) && isRunLeaseExpired(run, runLeaseMs);
}

function isMatchingRunningRun(run: ActiveAiResearchRun | null, projectId: string): run is ActiveAiResearchRun {
  return Boolean(
    run
    && run.projectId === projectId
    && run.capability === 'law_search'
    && run.status === 'running',
  );
}

function isRunLeaseExpired(run: ActiveAiResearchRun, runLeaseMs: number): boolean {
  const lastActivityAt = Math.max(run.startedAt.getTime(), run.updatedAt.getTime());
  return !Number.isFinite(lastActivityAt) || Date.now() - lastActivityAt > runLeaseMs;
}

function conflict(error: string, currentVersion: number, lastTurnId: string | null) {
  return new ConflictException({
    error,
    code: 'AI_RESEARCH_CONTEXT_CONFLICT',
    currentVersion,
    lastTurnId,
  });
}
