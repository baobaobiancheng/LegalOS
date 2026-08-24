import { createHash } from 'crypto';
import { DshExecutionResult } from '../../../common/services/dsh-agent.types';
import { ConsultationCapability } from '../domain/consultation-capability';

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
  limitations: string[];
}

/** 写库前统一收敛：最多 8 次调用、每次 5 条结果、字符串有界。 */
export function buildResearchTrace(
  capability: Exclude<ConsultationCapability, 'general'>,
  result: DshExecutionResult,
): ResearchTraceV1 {
  const detailedLawIds = new Set(result.toolResults.flatMap((item) =>
    item.result && 'contentBlocks' in item.result ? [item.result.recordId] : []));
  const calls = result.toolResults.slice(0, 8).map((toolResult, index) => {
    const call = result.toolCalls.find((item) => item.callId === toolResult.callId)
      ?? result.toolCalls[index];
    const normalized = toolResult.result;
    const sourceRecords = normalized && 'records' in normalized
      ? (capability === 'law_search' && detailedLawIds.size
        ? normalized.records.filter((record) => detailedLawIds.has(record.recordId))
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
    limitations: capability === 'law_search'
      ? (result.toolResults.some((item) => item.result && 'contentBlocks' in item.result)
        ? ['条文原文来自已读取的百鉴法规详情；AI分析不等同于正式法律意见']
        : ['未检索到可核验法规正文'])
      : ['案例结果取决于供应商案例库覆盖与可用性'],
  };
  return enforceTraceLimit(trace);
}

function enforceTraceLimit(trace: ResearchTraceV1): ResearchTraceV1 {
  const maxBytes = 64 * 1024;
  if (Buffer.byteLength(JSON.stringify(trace), 'utf8') <= maxBytes) return trace;
  // 超限时优先删除非权威长摘要，保留状态、查询、记录 ID 与公开来源字段。
  const compact = {
    ...trace,
    calls: trace.calls.map((call) => ({
      ...call,
      records: call.records.map(compactRecord),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= maxBytes) return compact;
  return {
    ...compact,
    calls: compact.calls.slice(0, 1).map((call) => ({ ...call, records: call.records.slice(0, 3) })),
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
