import { createHash } from 'crypto';
import { DshExecutionResult } from '../../../common/services/dsh-agent.types';
import { ConsultationCapability } from '../domain/consultation-capability';
import { AiLawResearchReportV1, verifiedLawDetails } from '../../../common/services/ai-law-research-report';

export interface ResearchTraceV1 {
  schemaVersion: 1;
  capability: Exclude<ConsultationCapability, 'general'>;
  status: 'success_hit' | 'success_empty';
  dshSessionId: string;
  calls: Array<{
    tool: string;
    query: string;
    recordIds: string[];
    records: unknown[];
  }>;
  report?: AiLawResearchReportV1;
  limitations: string[];
}

/** 写库前统一收敛：最多 5 次调用、每次 5 条结果、字符串有界。 */
export function buildResearchTrace(
  capability: Exclude<ConsultationCapability, 'general'>,
  result: DshExecutionResult,
  report?: AiLawResearchReportV1,
): ResearchTraceV1 {
  const detailedLawIds = new Set(verifiedLawDetails(result.toolResults).map((detail) => detail.recordId.toLowerCase()));
  const calls = result.toolResults.slice(0, 5).map((toolResult, index) => {
    const call = result.toolCalls.find((item) => item.callId === toolResult.callId)
      ?? result.toolCalls[index];
    const normalized = toolResult.result;
    const sourceRecords = normalized && 'records' in normalized
      ? (capability === 'law_search' && detailedLawIds.size
        ? normalized.records.filter((record) => detailedLawIds.has(record.recordId.toLowerCase()))
        : normalized.records)
      : [];
    const records = sourceRecords.slice(0, 5).map((record) => boundRecord(record));
    const detailId = normalized && 'contentBlocks' in normalized ? normalized.recordId : '';
    return {
      tool: bound(String(toolResult.name), 80),
      query: extractQuery(call?.arguments),
      recordIds: [detailId, ...records
        .map((record: any) => String(record.recordId ?? record.sourceId ?? ''))
        .filter(Boolean)]
        .filter(Boolean)
        .slice(0, 5),
      records,
    };
  });
  const hit = calls.some((call) => call.records.length > 0);
  const trace: ResearchTraceV1 = {
    schemaVersion: 1,
    capability,
    status: hit ? 'success_hit' : 'success_empty',
    dshSessionId: bound(result.dshSessionId, 128),
    calls,
    ...(report ? { report } : {}),
    limitations: capability === 'law_search'
      ? (verifiedLawDetails(result.toolResults).length
        ? ['条文原文来自已读取的百鉴法规详情；AI分析不等同于正式法律意见']
        : ['未检索到可核验法规正文'])
      : ['案例结果取决于供应商案例库覆盖与可用性'],
  };
  return enforceTraceLimit(trace);
}

function enforceTraceLimit(trace: ResearchTraceV1): ResearchTraceV1 {
  const maxBytes = 64 * 1024;
  if (Buffer.byteLength(JSON.stringify(trace), 'utf8') <= maxBytes) return trace;
  // 超限时先压缩列表摘要与报告长文本，保留核验状态、记录 ID、来源名称和短引文。
  const compact = {
    ...trace,
    ...(trace.report ? { report: compactReport(trace.report, false) } : {}),
    calls: trace.calls.map((call) => ({
      ...call,
      records: call.records.map(compactRecord),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= maxBytes) return compact;
  const aggressive = {
    ...compact,
    ...(trace.report ? { report: compactReport(trace.report, true) } : {}),
    calls: compact.calls.map((call) => ({ ...call, records: [] })),
  };
  if (Buffer.byteLength(JSON.stringify(aggressive), 'utf8') <= maxBytes) return aggressive;
  return {
    ...aggressive,
    calls: aggressive.calls.slice(0, 1),
    ...(trace.report ? {
      report: {
        ...compactReport(trace.report, true),
        sections: compactReport(trace.report, true).sections.slice(0, 2)
          .map((section) => ({ ...section, content: bound(section.content, 300) })),
        sources: compactReport(trace.report, true).sources
          .map((source) => ({ ...source, articles: [] })),
      },
    } : {}),
  };
}

function compactReport(report: AiLawResearchReportV1, aggressive: boolean): AiLawResearchReportV1 {
  const textLimit = aggressive ? 250 : 600;
  return {
    ...report,
    query: bound(report.query, aggressive ? 200 : 500),
    title: bound(report.title, 80),
    scope: bound(report.scope, aggressive ? 200 : 300),
    summary: bound(report.summary, aggressive ? 500 : 1_000),
    generatedAt: bound(report.generatedAt, 40),
    sections: report.sections.slice(0, aggressive ? 3 : 5).map((section) => ({
      ...section,
      id: bound(section.id, 64),
      title: bound(section.title, 60),
      content: bound(section.content, aggressive ? 500 : 1_000),
      sourceIds: section.sourceIds.slice(0, 10).map((id) => bound(id, 64)),
    })),
    sources: report.sources.slice(0, 10).map((source) => ({
      ...source,
      recordId: bound(source.recordId, 64),
      lawName: bound(source.lawName, aggressive ? 120 : 200),
      issuingOrgan: source.issuingOrgan ? bound(source.issuingOrgan, aggressive ? 80 : 120) : null,
      issuingNo: source.issuingNo ? bound(source.issuingNo, aggressive ? 80 : 120) : null,
      releaseDate: source.releaseDate ? bound(source.releaseDate, 40) : null,
      implementDate: source.implementDate ? bound(source.implementDate, 40) : null,
      timeliness: source.timeliness ? bound(source.timeliness, 40) : null,
      articles: source.articles.slice(0, 1).map((article) => ({
        article: bound(article.article, 40),
        text: bound(article.text, textLimit),
      })),
    })),
    limitations: report.limitations.slice(0, aggressive ? 3 : 4)
      .map((item) => bound(item, aggressive ? 120 : 200)),
  };
}

function compactRecord(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const keys = [
    'source', 'recordId', 'sourceId', 'sourceName', 'lawName', 'title', 'issuingOrgan',
    'issuingNo', 'releaseDate', 'implementDate', 'timeliness', 'court', 'date',
    'country', 'caseNumber', 'jurisdiction', 'url', 'score',
  ];
  return Object.fromEntries(keys
    .filter((key) => key in record)
    .map((key) => [
      key,
      typeof record[key] === 'string' ? bound(String(record[key]), 256) : record[key],
    ]));
}

function extractQuery(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const args = value as Record<string, unknown>;
  if (args.query) {
    return `sha256:${createHash('sha256').update(String(args.query)).digest('hex')}`;
  }
  return bound(String(args.keyword ?? args.lawId ?? ''), 200);
}

function boundRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 16)
    .map(([key, item]) => [bound(key, 64), typeof item === 'string' ? bound(item, 1_000) : item]));
}

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
