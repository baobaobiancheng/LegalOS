import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { BaijianError } from '../../common/baijian/baijian.types';
import { CachedLegalResearchGateway } from '../../common/baijian/cached-legal-research.gateway';
import {
  DshExecutionResult,
  DshToolCallEvent,
  DshToolResultEvent,
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
} from '../../common/services/dsh-agent.types';
import { DshService, partialResearchResult } from '../../common/services/dsh.service';
import {
  buildAiLawResearchFallback,
  buildStandaloneAiLawResearchPrompt,
  AiLawResearchReportV1,
  AiLawResearchTurnContext,
  parseAiLawResearchReport,
} from '../../common/services/ai-law-research-report';
import { AuditService } from '../../common/audit/audit.service';
import { AuditRequestContext } from '../../common/audit/audit.types';
import { buildResearchTrace } from '../project/application/research-trace';
import {
  classifyResearchError,
  publicResearchDegradedWarning,
  publicResearchError,
} from '../project/application/consultation-execution.router';
import {
  AiLawReportDownloadDto,
  AiLawResearchDto,
  SearchCasesDto,
  SearchLawsDto,
} from './dto/legal-research.dto';
import {
  AiLegalResearchSessionService,
  PreparedAiResearchTurn,
} from './ai-legal-research-session.service';

export type AiLegalResearchStreamEvent =
  | {
    type: 'research_session';
    runId: string;
    conversationId: string;
    turnId: string;
    contextVersion: number;
    operation: string;
    question: string;
    replayed?: boolean;
  }
  | {
    type: 'research_stage';
    stage: 'understand' | 'recall' | 'verify' | 'answer';
    status: 'running' | 'completed' | 'empty' | 'degraded';
    title: string;
    detail: string;
  }
  | { type: 'research_metrics'; candidateCount?: number; verifiedSourceCount?: number; toolName?: string }
  | { type: 'answer_delta'; delta: string }
  | { type: 'report_start'; report: Omit<AiLawResearchReportV1, 'summary' | 'sections' | 'sources' | 'limitations'> }
  | { type: 'report_summary'; summary: string }
  | { type: 'report_section'; section: AiLawResearchReportV1['sections'][number] }
  | { type: 'report_source'; source: AiLawResearchReportV1['sources'][number] }
  | { type: 'report_limitations'; limitations: string[] }
  | {
    type: 'report_completed';
    runId: string;
    conversationId: string;
    turnId: string;
    contextVersion: number;
    reportId: string;
    degraded?: boolean;
    warning?: { code: string; message: string };
  };

interface AiSearchExecutionResponse {
  reportId: string;
  report: AiLawResearchReportV1;
  trace: ReturnType<typeof buildResearchTrace>;
  answer: string;
  degraded?: boolean;
  warning?: { code: string; message: string };
}

interface AiResearchProgress {
  candidateIds: Set<string>;
  verifiedSourceIds: Set<string>;
  successfulSearchCount: number;
}

@Injectable()
export class LegalResearchService {
  constructor(
    private readonly baijian: CachedLegalResearchGateway,
    private readonly dsh: DshService,
    private readonly audit: AuditService,
    private readonly sessions: AiLegalResearchSessionService,
  ) {}

  async searchLaws(dto: SearchLawsDto, signal?: AbortSignal) {
    try {
      const { refresh, ...searchInput } = dto;
      const requestedKeyword = searchInput.keyword.trim();
      const searchedKeyword = requestedKeyword;
      const result = await this.baijian.searchLaws(
        { ...searchInput, keyword: searchedKeyword },
        signal,
        { refresh },
      );
      const records = result.records.filter((record) => !isCaseLikeTitle(record.lawName));
      return {
        ...result,
        records,
        requestedKeyword,
        searchedKeyword,
        filteredCaseLikeCount: result.records.length - records.length,
      };
    } catch (error) {
      throw presentResearchError(error);
    }
  }

  async getLawDetail(lawId: string, refresh = false, signal?: AbortSignal) {
    try {
      return await this.baijian.getLawDetail({ lawId }, signal, { refresh });
    } catch (error) {
      throw presentResearchError(error);
    }
  }

  async searchCases(dto: SearchCasesDto, signal?: AbortSignal) {
    try {
      const { refresh, ...searchInput } = dto;
      return await this.baijian.searchCases(searchInput, signal, { refresh });
    } catch (error) {
      throw presentResearchError(error);
    }
  }

  async aiSearch(
    dto: AiLawResearchDto,
    actor: { id: string; role: Role },
    request?: AuditRequestContext,
    signal?: AbortSignal,
  ) {
    const query = dto.query.trim();
    const result = await this.executeAiSearch(
      query,
      actor,
      request,
      signal,
      {
        sessionId: `legal-research:${actor.id}`,
        turnContext: { operation: 'new', knownFacts: [], legalIssues: [] },
      },
    );
    const { answer: _answer, ...response } = result;
    return response;
  }

  async streamAiSearch(
    dto: AiLawResearchDto,
    actor: { id: string; role: Role },
    request: AuditRequestContext | undefined,
    signal: AbortSignal,
    emit: (event: AiLegalResearchStreamEvent) => void,
  ): Promise<void> {
    const prepared = await this.sessions.prepareTurn(dto, actor);
    emit({
      type: 'research_session',
      runId: prepared.runId,
      conversationId: prepared.conversationId,
      turnId: prepared.runId,
      contextVersion: prepared.contextVersion,
      operation: prepared.operation,
      question: prepared.query,
      ...(prepared.replay ? { replayed: true } : {}),
    });

    if (prepared.replay) {
      emitReport(prepared, prepared.replay, emit);
      return;
    }

    emit({
      type: 'research_stage',
      stage: 'understand',
      status: 'running',
      title: '分析法条检索需求',
      detail: thinkingCopy(prepared),
    });
    try {
      const progress: AiResearchProgress = {
        candidateIds: new Set<string>(),
        verifiedSourceIds: new Set<string>(),
        successfulSearchCount: 0,
      };
      const result = await this.executeAiSearch(
        prepared.query,
        actor,
        request,
        signal,
        {
          sessionId: prepared.conversationId,
          resumeDshSessionId: prepared.resumeDshSessionId,
          turnContext: prepared.turnContext,
          onToolCall: (call) => emitToolCallProgress(call, emit),
          onToolResult: (toolResult) => emitToolResultProgress(toolResult, emit, progress),
        },
      );
      await this.sessions.completeTurn(prepared, result);
      emitReport(prepared, result, emit);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.sessions.failTurn(prepared, failure, signal.aborted);
      throw error;
    }
  }

  getAiConversation(conversationId: string, actorId: string) {
    return this.sessions.getConversation(conversationId, actorId);
  }

  private async executeAiSearch(
    query: string,
    actor: { id: string; role: Role },
    request: AuditRequestContext | undefined,
    signal: AbortSignal | undefined,
    options: {
      sessionId: string;
      resumeDshSessionId?: string;
      turnContext: AiLawResearchTurnContext;
      onToolCall?: (call: DshToolCallEvent) => void;
      onToolResult?: (result: DshToolResultEvent) => void;
    },
  ): Promise<AiSearchExecutionResponse> {
    const correlationId = randomUUID();
    const queryHash = createHash('sha256').update(query).digest('hex');
    await this.audit.record({
      actor,
      action: 'ai.legal_research.started',
      resourceType: 'ai_legal_research_report',
      resourceId: correlationId,
      source: 'dsh',
      outcome: 'success',
      request,
      correlationId,
      metadata: { queryHash },
      retentionClass: 'ai',
    });

    let completedResult: DshExecutionResult | undefined;
    try {
      const handle = await this.dsh.executeStream(
        buildStandaloneAiLawResearchPrompt(query, this.dsh.getToolCallLimit(), options.turnContext),
        {
          sessionId: options.sessionId,
          resumeDshSessionId: options.resumeDshSessionId,
          researchCapability: 'law_search',
          requireResearchTool: true,
          timeout: 180_000,
          signal,
        },
      );
      if (options.onToolCall) handle.on('tool_call', options.onToolCall);
      if (options.onToolResult) handle.on('tool_result', options.onToolResult);
      const result = await completionOf(handle);
      completedResult = result;
      const parsed = parseAiLawResearchReport(result.text, result.toolResults, query, options.turnContext);
      const trace = buildResearchTrace('law_search', result, parsed.report);
      await this.audit.record({
        actor,
        action: 'ai.legal_research.succeeded',
        resourceType: 'ai_legal_research_report',
        resourceId: correlationId,
        source: 'dsh',
        outcome: 'success',
        request,
        correlationId: result.dshSessionId,
        after: {
          reportId: result.dshSessionId,
          verifiedSourceCount: parsed.report.metrics.verifiedSourceCount,
          citedSourceCount: parsed.report.metrics.citedSourceCount,
        },
        metadata: { queryHash, toolCalls: result.toolCalls.length },
        retentionClass: 'ai',
      });
      return { reportId: result.dshSessionId, report: parsed.report, trace, answer: parsed.answer };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const reasonCode = classifyResearchError(failure);
      const fallbackResult = completedResult ?? partialResearchResult(error);
      const fallback = fallbackResult
        ? buildAiLawResearchFallback(query, fallbackResult, reasonCode, options.turnContext)
        : undefined;
      if (fallback && fallbackResult) {
        const trace = buildResearchTrace('law_search', fallbackResult, fallback.report);
        await this.audit.record({
          actor,
          action: 'ai.legal_research.degraded',
          resourceType: 'ai_legal_research_report',
          resourceId: correlationId,
          source: 'dsh',
          outcome: 'partial',
          reasonCode,
          request,
          correlationId: fallbackResult.dshSessionId,
          after: {
            reportId: fallbackResult.dshSessionId,
            fallbackLevel: fallback.level,
            verifiedSourceCount: fallback.report.metrics.verifiedSourceCount,
            candidateCount: fallback.report.metrics.candidateCount,
          },
          metadata: { queryHash, toolCalls: fallbackResult.toolCalls.length },
          retentionClass: 'ai',
        });
        return {
          reportId: fallbackResult.dshSessionId,
          report: fallback.report,
          trace,
          answer: fallback.answer,
          degraded: true,
          warning: { code: reasonCode, message: publicResearchDegradedWarning(reasonCode) },
        };
      }
      await this.audit.record({
        actor,
        action: 'ai.legal_research.failed',
        resourceType: 'ai_legal_research_report',
        resourceId: correlationId,
        source: 'dsh',
        outcome: 'failed',
        reasonCode,
        request,
        correlationId,
        metadata: { queryHash },
        retentionClass: 'ai',
      });
      throw new ServiceUnavailableException({
        code: reasonCode,
        message: publicResearchError(reasonCode),
        actions: ['retry'],
        retryable: true,
      }, { cause: error });
    }
  }

  async recordAiReportDownload(
    dto: AiLawReportDownloadDto,
    actor: { id: string; role: Role },
    request?: AuditRequestContext,
  ) {
    await this.audit.record({
      actor,
      action: 'legal_research.report.download',
      resourceType: 'ai_legal_research_report',
      resourceId: dto.reportId,
      source: 'web',
      outcome: 'success',
      request,
      metadata: { format: dto.format },
      retentionClass: 'business',
    });
  }
}

function completionOf(handle: Awaited<ReturnType<DshService['executeStream']>>): Promise<DshExecutionResult> {
  return new Promise((resolve, reject) => {
    handle.once('done', resolve);
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('法律检索已取消')));
  });
}

function emitReport(
  prepared: PreparedAiResearchTurn,
  result: {
    reportId: string;
    report: AiLawResearchReportV1;
    degraded?: boolean;
    warning?: { code: string; message: string };
  },
  emit: (event: AiLegalResearchStreamEvent) => void,
) {
  const { summary, sections, sources, limitations, ...reportMeta } = result.report;
  emit({
    type: 'research_stage',
    stage: 'understand',
    status: 'completed',
    title: '分析法条检索需求',
    detail: result.report.understanding.analysis,
  });
  emit({
    type: 'research_stage',
    stage: 'recall',
    status: result.report.metrics.candidateCount ? 'completed' : 'empty',
    title: '定位与检索',
    detail: result.report.understanding.retrievalPlan,
  });
  emit({
    type: 'research_stage',
    stage: 'verify',
    status: result.report.metrics.verifiedSourceCount ? 'completed' : (result.degraded ? 'degraded' : 'empty'),
    title: '读取权威正文',
    detail: result.report.metrics.verifiedSourceCount
      ? `已读取 ${result.report.metrics.verifiedSourceCount} 部法规详情正文。`
      : '本轮没有完成法规详情正文读取。',
  });
  emit({
    type: 'research_stage',
    stage: 'answer',
    status: 'running',
    title: '生成搜法报告',
    detail: result.degraded
      ? '正在基于已取得的工具结果输出降级报告。'
      : '法规检索与详情读取条件已满足，正在整理总结、具体分析和法规原文。',
  });
  emit({ type: 'report_start', report: reportMeta });
  emit({ type: 'report_summary', summary });
  for (const section of sections) emit({ type: 'report_section', section });
  for (const source of sources) emit({ type: 'report_source', source });
  emit({ type: 'report_limitations', limitations });
  emit({
    type: 'research_stage',
    stage: 'answer',
    status: result.degraded ? 'degraded' : 'completed',
    title: '生成搜法报告',
    detail: result.degraded ? '已生成安全降级报告。' : '结构化搜法报告已生成。',
  });
  emit({
    type: 'report_completed',
    runId: prepared.runId,
    conversationId: prepared.conversationId,
    turnId: prepared.runId,
    contextVersion: prepared.contextVersion,
    reportId: result.reportId,
    ...(result.degraded ? { degraded: true } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
  });
}

function emitToolCallProgress(
  call: DshToolCallEvent,
  emit: (event: AiLegalResearchStreamEvent) => void,
) {
  if ([DSH_LAW_SEARCH_TOOL, DSH_LAW_ADVANCED_SEARCH_TOOL, DSH_LAW_SEMANTIC_SEARCH_TOOL].includes(call.name as any)) {
    emit({
      type: 'research_stage',
      stage: 'understand',
      status: 'completed',
      title: '分析法条检索需求',
      detail: '已完成问题理解，并确定本轮检索范围。',
    });
    emit({
      type: 'research_stage',
      stage: 'recall',
      status: 'running',
      title: '定位与检索',
      detail: `${searchStrategyLabel(call.name)}正在召回候选法规${displaySearchQuery(call.arguments)}。`,
    });
    return;
  }
  if ([DSH_LAW_DETAIL_TOOL, DSH_LAW_BATCH_DETAIL_TOOL].includes(call.name as any)) {
    emit({
      type: 'research_stage',
      stage: 'verify',
      status: 'running',
      title: '读取权威正文',
      detail: call.name === DSH_LAW_BATCH_DETAIL_TOOL
        ? `正在批量读取 ${detailRequestCount(call.arguments)} 部候选法规详情正文。`
        : '正在读取候选法规的权威正文。',
    });
  }
}

function emitToolResultProgress(
  toolResult: DshToolResultEvent,
  emit: (event: AiLegalResearchStreamEvent) => void,
  progress: AiResearchProgress,
) {
  if (toolResult.isError) {
    const detailStep = [DSH_LAW_DETAIL_TOOL, DSH_LAW_BATCH_DETAIL_TOOL].includes(toolResult.name as any);
    emit({
      type: 'research_stage',
      stage: detailStep ? 'verify' : 'recall',
      status: 'running',
      title: detailStep ? '继续读取权威正文' : '调整检索方式',
      detail: detailStep
        ? '一次详情读取未完成，系统正在根据已取得的候选法规继续处理。'
        : '当前检索方式未取得可用结果，系统正在尝试其他受控检索方式。',
    });
    return;
  }
  const value = toolResult.result;
  if (value && 'records' in value) {
    if ([DSH_LAW_SEARCH_TOOL, DSH_LAW_ADVANCED_SEARCH_TOOL, DSH_LAW_SEMANTIC_SEARCH_TOOL]
      .includes(toolResult.name as any)) {
      progress.successfulSearchCount += 1;
    }
    for (const record of value.records) {
      if (record.recordId) progress.candidateIds.add(record.recordId.toLowerCase());
    }
    const candidateCount = progress.candidateIds.size;
    emit({ type: 'research_metrics', candidateCount, toolName: toolResult.name });
    emit({
      type: 'research_stage',
      stage: 'recall',
      status: candidateCount ? 'completed' : 'empty',
      title: '定位与检索',
      detail: candidateCount
        ? `已召回 ${candidateCount} 部候选法规，正在选择最相关法规读取详情正文。`
        : '本次检索未召回候选法规，系统将如实生成零结果说明。',
    });
    return;
  }
  const previousVerifiedSourceCount = progress.verifiedSourceIds.size;
  if (value && 'details' in value) {
    for (const detail of value.details) {
      if (detail.recordId && detail.contentBlocks?.length) {
        progress.verifiedSourceIds.add(detail.recordId.toLowerCase());
      }
    }
  } else if (value && 'contentBlocks' in value && value.recordId && value.contentBlocks.length) {
    progress.verifiedSourceIds.add(value.recordId.toLowerCase());
  }
  const verifiedSourceCount = progress.verifiedSourceIds.size;
  if (verifiedSourceCount > previousVerifiedSourceCount) {
    emit({ type: 'research_metrics', verifiedSourceCount, toolName: toolResult.name });
    emit({
      type: 'research_stage',
      stage: 'verify',
      status: 'completed',
      title: '读取权威正文',
      detail: `已读取 ${verifiedSourceCount} 部法规详情正文，正在整理报告。`,
    });
    emit({
      type: 'research_stage',
      stage: 'answer',
      status: 'running',
      title: '生成搜法报告',
      detail: '正在基于检索结果和已读取的法规详情整理报告。',
    });
  }
}

function thinkingCopy(prepared: PreparedAiResearchTurn): string {
  if (prepared.operation === 'correct') {
    return '正在识别本轮更正事实，并判断上一轮哪些结论和检索依据需要重新核验。';
  }
  if (prepared.operation === 'new_issue') {
    return '正在继承已确认事实，并拆解本轮新增法律争点。';
  }
  if (prepared.operation === 'continue') {
    return '正在结合上一轮已确认事实，理解本次追问及其指代关系。';
  }
  return '正在梳理用户问题中的已知事实、法律关系和需要核验的争点。';
}

function searchStrategyLabel(name: string): string {
  if (name === DSH_LAW_SEMANTIC_SEARCH_TOOL) return '语义检索';
  if (name === DSH_LAW_ADVANCED_SEARCH_TOOL) return '高级条件检索';
  return '关键词检索';
}

function displaySearchQuery(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const args = value as Record<string, unknown>;
  const query = typeof args.keyword === 'string'
    ? args.keyword
    : typeof args.query === 'string' ? args.query : '';
  const clean = query.replace(/\s+/gu, ' ').trim().slice(0, 80);
  return clean ? `：“${clean}”` : '';
}

function detailRequestCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 1;
  const ids = (value as Record<string, unknown>).lawIds;
  return Array.isArray(ids) && ids.length ? Math.min(ids.length, 10) : 1;
}

export function isCaseLikeTitle(title: string): boolean {
  const value = title.replace(/\s+/g, '');
  return /(?:^|[\s——：:])(?:指导性|典型|参考)?案例\d*[：:]?/u.test(title)
    || /纠纷案(?:$|[（(])/u.test(value)
    || /^[^\s]{1,40}诉[^\s]{1,80}案$/u.test(value)
    || /案例$/.test(value);
}

function presentResearchError(error: unknown): ServiceUnavailableException {
  const supplier = error instanceof BaijianError ? error : undefined;
  const code = supplier?.code ?? 'BAIJIAN_SUPPLIER_ERROR';
  const message = code === 'BAIJIAN_QUOTA_EXHAUSTED'
    ? '案例库额度暂不可用，请稍后重试'
    : code === 'BAIJIAN_TIMEOUT'
      ? '检索超时，请重试'
      : '法律数据源暂不可用，请稍后重试';
  return new ServiceUnavailableException(
    {
      code,
      message,
      actions: supplier?.retryable === false ? [] : ['retry'],
      retryable: supplier?.retryable ?? true,
    },
    { cause: error },
  );
}
