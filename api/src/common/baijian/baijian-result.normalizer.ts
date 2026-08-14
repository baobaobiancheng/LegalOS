import { Injectable } from '@nestjs/common';
import {
  BAIJIAN_CASE_SEARCH_TOOL,
  BAIJIAN_LAW_SEARCH_TOOL,
  BaijianCaseRecord,
  BaijianError,
  BaijianLawRecord,
  BaijianNormalizedResult,
  BaijianRawToolResult,
} from './baijian.types';

@Injectable()
export class BaijianResultNormalizer {
  normalize(raw: BaijianRawToolResult): BaijianNormalizedResult {
    if (raw.isError) {
      const text = extractFirstText(raw.content) ?? '百鉴 MCP 返回 isError=true';
      throw classifySupplierError(text);
    }
    const inner = this.extractInner(raw);
    if (raw.toolName === BAIJIAN_LAW_SEARCH_TOOL) return normalizeLaws(inner);
    if (raw.toolName === BAIJIAN_CASE_SEARCH_TOOL) return normalizeCases(inner);
    throw new BaijianError('BAIJIAN_TOOL_NOT_ALLOWED', '未允许的百鉴工具', false);
  }

  private extractInner(raw: BaijianRawToolResult): Record<string, unknown> {
    if (isRecord(raw.structuredContent)) return raw.structuredContent;
    const text = extractFirstText(raw.content);
    if (!text) throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '百鉴返回内容为空', false);
    try {
      const parsed = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error('not object');
      return parsed;
    } catch {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '百鉴内层结果不是合法 JSON 对象', false);
    }
  }
}

export function classifySupplierError(error: unknown): BaijianError {
  if (error instanceof BaijianError) return error;
  const record = isRecord(error) ? error : undefined;
  const code = record?.code;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);
  const normalized = message.toLowerCase();

  if (String(code) === '-32029' || /quota|额度|upgrade to developer|free plan/.test(normalized)) {
    return new BaijianError('BAIJIAN_QUOTA_EXHAUSTED', '案例库额度已用尽', false, code as string | number);
  }
  if (/abort|timeout|timed out|超时/.test(normalized)) {
    return new BaijianError('BAIJIAN_TIMEOUT', '百鉴请求超时', true, code as string | number);
  }
  if (/401|403|unauthorized|forbidden|鉴权|credential/.test(normalized)) {
    return new BaijianError('BAIJIAN_AUTH_FAILED', '百鉴鉴权失败', false, code as string | number);
  }
  if (/json-rpc|mcp|protocol|parse|invalid response/.test(normalized)) {
    return new BaijianError('BAIJIAN_PROTOCOL_ERROR', '百鉴协议响应异常', true, code as string | number);
  }
  return new BaijianError('BAIJIAN_SUPPLIER_ERROR', '百鉴服务暂不可用', true, code as string | number);
}

function normalizeLaws(inner: Record<string, unknown>): BaijianNormalizedResult {
  const code = inner.code;
  if (String(code) !== '200') {
    const message = typeof inner.msg === 'string' ? inner.msg : `法律之星业务码 ${String(code)}`;
    throw classifySupplierError({ code, message });
  }
  const data = isRecord(inner.data) ? inner.data : undefined;
  if (!data) throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法律之星缺少 data', false);
  const rows = Array.isArray(data.lawdata) ? data.lawdata : [];
  const records = rows.slice(0, 100).map(normalizeLawRecord).filter((v): v is BaijianLawRecord => v !== null);
  const count = safeNonNegativeInteger(data.count, records.length);
  const pageSize = safeNonNegativeInteger(data.pageSize, records.length);
  const totalPages = safeNonNegativeInteger(data.totalPage, pageSize ? Math.ceil(count / pageSize) : 0);
  return {
    toolName: BAIJIAN_LAW_SEARCH_TOOL,
    status: records.length ? 'success_hit' : 'success_empty',
    count,
    page: safePositiveInteger(data.page, 1),
    pageSize,
    totalPages,
    records,
  };
}

function normalizeLawRecord(value: unknown): BaijianLawRecord | null {
  if (!isRecord(value)) return null;
  const recordId = cleanString(value.lawId ?? value.rjs8);
  const lawName = cleanHtml(value.lawName);
  if (!recordId || !lawName) return null;
  return {
    source: 'lawstar',
    recordId,
    lawName,
    issuingOrgan: nullableCleanString(value.issuingOrgan),
    issuingNo: nullableCleanString(value.issuingNo),
    releaseDate: nullableCleanString(value.releaseYearMonthDate),
    implementDate: nullableCleanString(value.implementYearMonthDate),
    timeliness: nullableCleanString(value.timeliness),
  };
}

function normalizeCases(inner: Record<string, unknown>): BaijianNormalizedResult {
  if ('error' in inner && inner.error) throw classifySupplierError(inner.error);
  const hits = Array.isArray(inner.hits) ? inner.hits : [];
  const records = hits.slice(0, 100).map(normalizeCaseRecord).filter((v): v is BaijianCaseRecord => v !== null);
  return {
    toolName: BAIJIAN_CASE_SEARCH_TOOL,
    status: records.length ? 'success_hit' : 'success_empty',
    count: safeNonNegativeInteger(inner.total_hits, records.length),
    query: nullableCleanString(inner.query),
    elapsedMs: nullableNumber(inner.elapsed_ms),
    records,
  };
}

function normalizeCaseRecord(value: unknown): BaijianCaseRecord | null {
  if (!isRecord(value)) return null;
  const sourceName = cleanString(value.source);
  const sourceId = cleanString(value.source_id);
  const title = cleanHtml(value.title);
  if (!sourceName || !sourceId || !title) return null;
  return {
    source: 'ldh',
    recordId: sourceId,
    sourceId,
    sourceName,
    title,
    court: nullableCleanString(value.court),
    date: nullableCleanString(value.date),
    country: nullableCleanString(value.country),
    caseNumber: nullableCleanString(value.case_number),
    jurisdiction: nullableCleanString(value.jurisdiction),
    snippet: nullableCleanHtml(value.snippet),
    url: safePublicUrl(value.url),
    score: nullableNumber(value.score),
  };
}

function extractFirstText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

export function cleanHtml(value: unknown): string {
  return cleanString(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function nullableCleanHtml(value: unknown): string | null {
  const cleaned = cleanHtml(value);
  return cleaned || null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 4_000) : '';
}

function nullableCleanString(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned || null;
}

function safePublicUrl(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeNonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function safePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
