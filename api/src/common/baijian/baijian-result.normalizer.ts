import { Injectable } from '@nestjs/common';
import {
  BAIJIAN_CASE_SEARCH_TOOL,
  BAIJIAN_LAW_ADVANCED_SEARCH_TOOL,
  BAIJIAN_LAW_DETAIL_TOOL,
  BAIJIAN_LAW_SEARCH_TOOL,
  BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL,
  BaijianCaseRecord,
  BaijianError,
  BaijianLawContentBlock,
  BaijianLawDetail,
  BaijianLawRecord,
  BaijianLawTocItem,
  BaijianNormalizedResult,
  BaijianNormalizedToolResult,
  BaijianRawToolResult,
} from './baijian.types';

@Injectable()
export class BaijianResultNormalizer {
  normalize(raw: BaijianRawToolResult & { toolName: typeof BAIJIAN_LAW_DETAIL_TOOL }): BaijianLawDetail;
  normalize(raw: BaijianRawToolResult & { toolName: typeof BAIJIAN_LAW_SEARCH_TOOL | typeof BAIJIAN_LAW_ADVANCED_SEARCH_TOOL | typeof BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL | typeof BAIJIAN_CASE_SEARCH_TOOL }): BaijianNormalizedResult;
  normalize(raw: BaijianRawToolResult): BaijianNormalizedToolResult;
  normalize(raw: BaijianRawToolResult): BaijianNormalizedToolResult {
    if (raw.isError) {
      const text = extractFirstText(raw.content) ?? '百鉴 MCP 返回 isError=true';
      throw classifySupplierError(text);
    }
    const inner = this.extractInner(raw);
    if (raw.toolName === BAIJIAN_LAW_SEARCH_TOOL || raw.toolName === BAIJIAN_LAW_ADVANCED_SEARCH_TOOL) {
      return normalizeLaws(inner, raw.toolName);
    }
    if (raw.toolName === BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL) return normalizeSemanticLaws(inner);
    if (raw.toolName === BAIJIAN_LAW_DETAIL_TOOL) return normalizeLawDetail(inner);
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

export function normalizeLawDetail(inner: Record<string, unknown>): BaijianLawDetail {
  const code = inner.code;
  if (code !== undefined && String(code) !== '200') {
    const message = typeof inner.msg === 'string' ? inner.msg : `法律之星业务码 ${String(code)}`;
    throw classifySupplierError({ code, message });
  }
  const data = isRecord(inner.data) ? inner.data : inner;
  const recordId = cleanString(data.rjs8 ?? data.lawId);
  const lawName = cleanHtml(data.lawName);
  if (!recordId || !lawName) {
    throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规详情缺少法规 ID 或名称', false);
  }

  return {
    toolName: BAIJIAN_LAW_DETAIL_TOOL,
    recordId,
    lawName,
    issuingOrgan: nullableDisplayString(data.issuingOrgan),
    issuingNo: nullableDisplayString(data.issuingNo),
    releaseDate: nullableDisplayString(data.releaseYearMonthDate),
    implementDate: nullableDisplayString(data.implementYearMonthDate),
    timeliness: nullableDisplayString(data.timeliness),
    hasCompare: String(data.hasCompare ?? '') === '1',
    historyCount: safeArrayLength(data.hisgroup),
    enclosureCount: safeArrayLength(data.enclosure),
    basisCount: safeArrayLength(data.basisList),
    toc: normalizeToc(data.tocItem),
    contentBlocks: normalizeLawContent(data.lawSourceContent),
  };
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

function normalizeLaws(
  inner: Record<string, unknown>,
  toolName: typeof BAIJIAN_LAW_SEARCH_TOOL | typeof BAIJIAN_LAW_ADVANCED_SEARCH_TOOL,
): BaijianNormalizedResult {
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
    toolName,
    status: records.length ? 'success_hit' : 'success_empty',
    count,
    page: safePositiveInteger(data.page, 1),
    pageSize,
    totalPages,
    records,
  };
}

function normalizeSemanticLaws(inner: Record<string, unknown>): BaijianNormalizedResult {
  const code = inner.code;
  if (String(code) !== '200') {
    const message = typeof inner.msg === 'string' ? inner.msg : `法律之星业务码 ${String(code)}`;
    throw classifySupplierError({ code, message });
  }
  const data = isRecord(inner.data) ? inner.data : undefined;
  if (!data) throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法律之星语义检索缺少 data', false);
  const rows = Array.isArray(data.result) ? data.result : [];
  const records: BaijianLawRecord[] = [];
  for (const value of rows.slice(0, 100)) {
    const record = normalizeLawRecord(value);
    if (!record || !isRecord(value)) continue;
    records.push({
      ...record,
      issuingNo: nullableDisplayString(value.filenum ?? value.issuingNo),
      matchedContent: nullableCleanHtml(value.content),
      articleNumber: nullableDisplayString(value.rawnumber),
      score: nullableNumber(value.score),
    });
  }
  return {
    toolName: BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL,
    status: records.length ? 'success_hit' : 'success_empty',
    count: safeNonNegativeInteger(data.count ?? data.total, records.length),
    page: 1,
    pageSize: records.length,
    totalPages: records.length ? 1 : 0,
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
    issuingOrgan: nullableDisplayString(value.issuingOrgan),
    issuingNo: nullableDisplayString(value.issuingNo),
    releaseDate: nullableDisplayString(value.releaseYearMonthDate),
    implementDate: nullableDisplayString(value.implementYearMonthDate),
    timeliness: nullableDisplayString(value.timeliness),
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
    query: nullableDisplayString(inner.query),
    elapsedMs: nullableNumber(inner.elapsed_ms),
    records,
  };
}

function normalizeCaseRecord(value: unknown): BaijianCaseRecord | null {
  if (!isRecord(value)) return null;
  const sourceName = cleanDisplayString(value.source);
  const sourceId = cleanString(value.source_id);
  const title = cleanHtml(value.title);
  if (!sourceName || !sourceId || !title) return null;
  return {
    source: 'ldh',
    recordId: sourceId,
    sourceId,
    sourceName,
    title,
    court: nullableDisplayString(value.court),
    date: nullableDisplayString(value.date),
    country: nullableDisplayString(value.country),
    caseNumber: nullableDisplayString(value.case_number),
    jurisdiction: nullableDisplayString(value.jurisdiction),
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
  return cleanDisplayString(cleanString(value).replace(/<[^>]*>/g, ''));
}

function normalizeLawContent(value: unknown): BaijianLawContentBlock[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  if (Buffer.byteLength(value, 'utf8') > 2_000_000) {
    throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规正文超过安全大小上限', false);
  }
  const blocks: BaijianLawContentBlock[] = [];
  const paragraphs = value.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi);
  for (const match of paragraphs) {
    if (blocks.length >= 10_000) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规正文段落数超过安全上限', false);
    }
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const text = cleanLongHtml(inner);
    if (!text) continue;
    const idMatch = attrs.match(/\bid\s*=\s*(['"])([^'"]+)\1/i);
    const id = idMatch ? safeAnchorId(idMatch[2]) : null;
    const isHeading = /<strong\b/i.test(inner)
      || /text-align\s*:\s*center/i.test(attrs)
      || /^\u7b2c[^\s]{1,12}[编章节]\s/.test(text);
    const kind: BaijianLawContentBlock['kind'] = isHeading
      ? 'heading'
      : /text-align\s*:\s*right/i.test(attrs)
        ? 'signature'
        : 'paragraph';
    blocks.push({ id, kind, text });
  }
  if (blocks.length) return blocks;
  const fallback = cleanLongHtml(value);
  return fallback ? [{ id: null, kind: 'paragraph', text: fallback }] : [];
}

function normalizeToc(value: unknown): BaijianLawTocItem[] {
  if (!Array.isArray(value)) return [];
  let count = 0;
  const walk = (items: unknown[], depth: number): BaijianLawTocItem[] => {
    if (depth > 8) return [];
    const output: BaijianLawTocItem[] = [];
    for (const item of items) {
      if (count >= 1_000 || !isRecord(item)) break;
      const id = safeAnchorId(item.id);
      const text = cleanHtml(item.text);
      if (!id || !text) continue;
      count += 1;
      output.push({
        id,
        text,
        level: Math.min(8, Math.max(0, safeNonNegativeInteger(item.indentLevel, depth))),
        children: walk(Array.isArray(item.children) ? item.children : [], depth + 1),
      });
    }
    return output;
  };
  return walk(value, 0);
}

function cleanLongHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity: string, code: string) => decodeCodePoint(entity, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (entity: string, code: string) => decodeCodePoint(entity, Number.parseInt(code, 16)));
}

function decodeCodePoint(entity: string, codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function safeAnchorId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[\w\-一-鿿]{1,80}$/u.test(id) ? id : null;
}

function safeArrayLength(value: unknown): number {
  return Array.isArray(value) ? Math.min(value.length, 10_000) : 0;
}

function nullableCleanHtml(value: unknown): string | null {
  const cleaned = cleanHtml(value);
  return cleaned || null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 4_000) : '';
}

function cleanDisplayString(value: unknown): string {
  return decodeHtmlEntities(cleanString(value))
    .replace(/\s+/g, ' ')
    .trim();
}

function nullableDisplayString(value: unknown): string | null {
  const cleaned = cleanDisplayString(value);
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
