import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { BaijianError } from '../../common/baijian/baijian.types';
import { CachedLegalResearchGateway } from '../../common/baijian/cached-legal-research.gateway';
import { DshExecutionResult } from '../../common/services/dsh-agent.types';
import { DshService } from '../../common/services/dsh.service';
import {
  buildStandaloneAiLawResearchPrompt,
  parseAiLawResearchReport,
} from '../../common/services/ai-law-research-report';
import { AuditService } from '../../common/audit/audit.service';
import { AuditRequestContext } from '../../common/audit/audit.types';
import { buildResearchTrace } from '../project/application/research-trace';
import { classifyResearchError, publicResearchError } from '../project/application/consultation-execution.router';
import {
  AiLawReportDownloadDto,
  AiLawResearchDto,
  SearchCasesDto,
  SearchLawsDto,
} from './dto/legal-research.dto';

@Injectable()
export class LegalResearchService {
  constructor(
    private readonly baijian: CachedLegalResearchGateway,
    private readonly dsh: DshService,
    private readonly audit: AuditService,
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

    try {
      const handle = await this.dsh.executeStream(
        buildStandaloneAiLawResearchPrompt(query, this.dsh.getToolCallLimit()),
        {
          sessionId: `legal-research:${actor.id}`,
          researchCapability: 'law_search',
          requireResearchTool: true,
          timeout: 180_000,
          signal,
        },
      );
      const result = await completionOf(handle);
      const parsed = parseAiLawResearchReport(result.text, result.toolResults, query);
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
      return { reportId: result.dshSessionId, report: parsed.report, trace };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const reasonCode = classifyResearchError(failure);
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
