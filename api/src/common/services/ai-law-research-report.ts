import {
  DshExecutionResult,
  DshToolResultEvent,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
} from './dsh-agent.types';
import { BaijianLawDetail, BaijianLawRecord } from '../baijian/baijian.types';

export interface AiLawResearchSectionV1 {
  id: string;
  title: string;
  content: string;
  sourceIds: string[];
}

export interface AiLawResearchSourceV1 {
  recordId: string;
  lawName: string;
  issuingOrgan: string | null;
  issuingNo: string | null;
  releaseDate: string | null;
  implementDate: string | null;
  timeliness: string | null;
  lastVerifiedAt: string | null;
  articles: Array<{ article: string; text: string }>;
}

export interface AiLawResearchReportV1 {
  schemaVersion: 1;
  resultStatus: 'complete' | 'degraded';
  query: string;
  title: string;
  scope: string;
  summary: string;
  sections: AiLawResearchSectionV1[];
  sources: AiLawResearchSourceV1[];
  limitations: string[];
  generatedAt: string;
  metrics: {
    candidateCount: number;
    verifiedSourceCount: number;
    citedSourceCount: number;
  };
}

export interface ParsedAiLawResearchReport {
  answer: string;
  report: AiLawResearchReportV1;
}

export interface AiLawResearchFallback extends ParsedAiLawResearchReport {
  level: 'verified_text' | 'candidate_only' | 'empty';
}

interface ModelReport {
  query?: unknown;
  title?: unknown;
  scope?: unknown;
  summary?: unknown;
  answer?: unknown;
  sections?: unknown;
  evidenceQuotes?: unknown;
  limitations?: unknown;
}

export const AI_LAW_REPORT_OUTPUT_RULE = `最终只输出一个 JSON 对象，不要输出 Markdown 围栏或额外说明。结构必须是：
{"query":"本轮问题","title":"不超过40字的报告标题","scope":"本轮检索范围","summary":"两段以内总结","answer":"供咨询对话直接展示的Markdown答复","sections":[{"title":"分析主题","content":"具体分析","sourceIds":["已核验法规ID"]}],"evidenceQuotes":[{"recordId":"已核验法规ID","article":"具体条号","text":"工具返回的逐字原文"}],"limitations":["适用边界"]}。
answer 必须包含结论、具体分析、适用边界和来源名称；不得泄露内部推理过程。没有直接引用时 evidenceQuotes 可为空数组；一旦引用，text 必须逐字复制已读取的法规正文连续片段。`;

export function buildStandaloneAiLawResearchPrompt(query: string, toolCallLimit: number): string {
  return `你是企业法律检索 Agent。围绕用户问题完成一份可审计的 AI 搜法报告。
默认只用 search_laws_semantic、search_laws 或 search_laws_advanced 中的一种召回候选；仅在首次零结果或明显缺少规范层级时补充第二次召回，本轮最多两次。如需直接引用法规原文，优先只调用一次 get_law_details 批量读取最多3部最相关法规；仅在单条精确定位时使用 get_law_detail，且本轮不得连续调用多个单条详情。
本轮最多调用工具 ${toolCallLimit} 次；获得足以回答的证据后立即停止。若全部召回为零结果，answer、summary 必须以“未检索到可核验来源”开头，sources 与 evidenceQuotes 为空，不得生成确定性法规结论。
${AI_LAW_REPORT_OUTPUT_RULE}

【用户问题】
${query}`;
}

export function parseAiLawResearchReport(
  text: string,
  toolResults: DshToolResultEvent[],
  requestedQuery = '',
): ParsedAiLawResearchReport {
  const value = parseModelJson(text);
  const answer = requiredText(value.answer, 'answer', 20_000);
  const verifiedDetails = verifiedLawDetails(toolResults).slice(0, 10);
  const verifiedIds = new Set(verifiedDetails.map((detail) => detail.recordId.toLowerCase()));
  const evidenceQuotes = parseEvidenceQuotes(value.evidenceQuotes, verifiedDetails);
  const quotesBySource = new Map<string, Array<{ article: string; text: string }>>();
  for (const quote of evidenceQuotes) {
    const entries = quotesBySource.get(quote.recordId) ?? [];
    entries.push({ article: quote.article, text: quote.text });
    quotesBySource.set(quote.recordId, entries);
  }

  const sections = parseSections(value.sections, verifiedIds);
  const sources = verifiedDetails.map((detail) => ({
    recordId: bound(detail.recordId, 64),
    lawName: bound(detail.lawName, 300),
    issuingOrgan: nullableText(detail.issuingOrgan, 200),
    issuingNo: nullableText(detail.issuingNo, 200),
    releaseDate: nullableText(detail.releaseDate, 40),
    implementDate: nullableText(detail.implementDate, 40),
    timeliness: nullableText(detail.timeliness, 40),
    lastVerifiedAt: lawDetailLastVerifiedAt(detail),
    articles: (quotesBySource.get(detail.recordId.toLowerCase()) ?? []).slice(0, 3),
  }));
  const candidateIds = new Set(toolResults.flatMap((result) => {
    if (!result.result || !('records' in result.result)) return [];
    return result.result.records.map((record) => record.recordId.toLowerCase());
  }));
  const citedSourceCount = new Set(evidenceQuotes.map((quote) => quote.recordId)).size;
  const query = bound(requestedQuery.trim() || optionalText(value.query, 1_000) || '', 1_000);

  return {
    answer,
    report: {
      schemaVersion: 1,
      resultStatus: 'complete',
      query,
      title: requiredText(value.title, 'title', 100),
      scope: requiredText(value.scope, 'scope', 500),
      summary: requiredText(value.summary, 'summary', 2_000),
      sections,
      sources,
      limitations: parseStringArray(value.limitations, 5, 300),
      generatedAt: new Date().toISOString(),
      metrics: {
        candidateCount: candidateIds.size,
        verifiedSourceCount: sources.length,
        citedSourceCount,
      },
    },
  };
}

export function verifiedLawDetails(toolResults: DshToolResultEvent[]): BaijianLawDetail[] {
  const details = toolResults.flatMap((result) => {
    if (result.isError || !result.result) return [];
    if (result.name === DSH_LAW_DETAIL_TOOL && 'contentBlocks' in result.result) {
      return [result.result];
    }
    if (result.name === DSH_LAW_BATCH_DETAIL_TOOL && 'details' in result.result) {
      return result.result.details;
    }
    return [];
  });
  const unique = new Map<string, BaijianLawDetail>();
  for (const detail of details) {
    if (!detail.recordId || !detail.contentBlocks?.length) continue;
    unique.set(detail.recordId.toLowerCase(), detail);
  }
  return [...unique.values()];
}

/**
 * 证据闸门或报告解析失败时的安全降级。此函数刻意不读取 result.text：
 * 只从受控工具的结构化结果生成内容，避免把未通过核验的 AI 结论绕过闸门。
 */
export function buildAiLawResearchFallback(
  query: string,
  result: DshExecutionResult,
  reasonCode: string,
): AiLawResearchFallback | undefined {
  if (reasonCode === 'RESEARCH_TOOL_NOT_ALLOWED') return undefined;
  const candidates = uniqueLawCandidates(result.toolResults).slice(0, 10);
  const candidateIds = new Set(candidates.map((record) => record.recordId.toLowerCase()));
  const details = verifiedLawDetails(result.toolResults)
    .filter((detail) => candidateIds.has(detail.recordId.toLowerCase()))
    .slice(0, 5);
  const lawSearchTools = new Set<string>([
    DSH_LAW_SEARCH_TOOL,
    DSH_LAW_ADVANCED_SEARCH_TOOL,
    DSH_LAW_SEMANTIC_SEARCH_TOOL,
  ]);
  const hadSuccessfulSearch = result.toolResults.some((item) =>
    lawSearchTools.has(item.name) && !item.isError && item.result && 'records' in item.result);
  if (!hadSuccessfulSearch) return undefined;

  const normalizedQuery = bound(query.trim(), 1_000);
  const generatedAt = new Date().toISOString();
  const failureNote = `AI 生成内容未通过证据核验（${bound(reasonCode, 80)}），系统已拦截该结论。`;

  if (details.length) {
    const sources = details.map((detail) => ({
      recordId: bound(detail.recordId, 64),
      lawName: bound(detail.lawName, 300),
      issuingOrgan: nullableText(detail.issuingOrgan, 200),
      issuingNo: nullableText(detail.issuingNo, 200),
      releaseDate: nullableText(detail.releaseDate, 40),
      implementDate: nullableText(detail.implementDate, 40),
      timeliness: nullableText(detail.timeliness, 40),
      lastVerifiedAt: lawDetailLastVerifiedAt(detail),
      articles: selectEvidenceBlocks(detail, normalizedQuery),
    }));
    const quotedSources = sources.filter((source) => source.articles.length > 0);
    const sourceSummary = sources.map((source) =>
      `- ${source.lawName}${source.timeliness ? `（${source.timeliness}）` : ''}`).join('\n');
    const quotedText = quotedSources.flatMap((source) => [
      `### ${source.lawName}`,
      ...source.articles.map((article) => `> ${article.article}：${article.text}`),
    ]).join('\n\n');
    const answer = [
      '## AI 结论未通过核验',
      '系统已拦截本轮 AI 分析结论。下面仅展示已从权威法规详情中读取的原文片段，不作延伸解释。',
      quotedText || sourceSummary,
      '### 处理建议',
      '可重试生成完整分析；在新结论通过原文核验前，请勿将上述片段直接视为具体案件结论。',
    ].filter(Boolean).join('\n\n');
    return {
      level: 'verified_text',
      answer,
      report: {
        schemaVersion: 1,
        resultStatus: 'degraded',
        query: normalizedQuery,
        title: '已保留的权威法规证据',
        scope: '本轮已成功读取的法规详情正文',
        summary: `${failureNote}以下内容仅为系统已读取的权威法规原文，不包含未核验的 AI 推断。`,
        sections: [{
          id: 'verified-evidence',
          title: '已核验法规范围',
          content: sourceSummary || '已完成法规详情读取。',
          sourceIds: sources.map((source) => source.recordId.toLowerCase()),
        }],
        sources,
        limitations: [failureNote, '原文片段不等同于针对具体事实的法律意见，请重试或转人工复核。'],
        generatedAt,
        metrics: {
          candidateCount: candidates.length,
          verifiedSourceCount: sources.length,
          citedSourceCount: quotedSources.length,
        },
      },
    };
  }

  if (candidates.length) {
    const candidateText = candidates.map((record) =>
      `- ${record.lawName}${record.issuingOrgan ? `｜${record.issuingOrgan}` : ''}${record.timeliness ? `｜${record.timeliness}` : ''}`).join('\n');
    return {
      level: 'candidate_only',
      answer: [
        '## 已找到候选法规，正文尚未核验',
        '本轮 AI 结论已被拦截。以下仅是检索召回的候选法规，尚未完成权威正文读取，不得作为法律结论或引用依据。',
        candidateText,
        '请重试以完成正文核验，或缩小问题范围后重新检索。',
      ].join('\n\n'),
      report: {
        schemaVersion: 1,
        resultStatus: 'degraded',
        query: normalizedQuery,
        title: '候选法规已召回，正文待核验',
        scope: '本轮法规检索召回结果',
        summary: `${failureNote}系统仅保留候选法规清单，没有输出未经正文核验的法律结论。`,
        sections: [{ id: 'candidate-laws', title: '候选法规', content: candidateText, sourceIds: [] }],
        sources: [],
        limitations: [failureNote, '候选法规尚未读取详情正文，不得用于正式引用。'],
        generatedAt,
        metrics: { candidateCount: candidates.length, verifiedSourceCount: 0, citedSourceCount: 0 },
      },
    };
  }

  return {
    level: 'empty',
    answer: '## 未检索到可核验来源\n\n本轮法规检索已完成，但未召回候选法规。系统未生成确定性法律结论，请更换关键词或缩小问题范围后重试。',
    report: {
      schemaVersion: 1,
      resultStatus: 'degraded',
      query: normalizedQuery,
      title: '未检索到可核验法规',
      scope: '本轮法规检索',
      summary: '本轮未召回候选法规，系统未输出确定性法律结论。',
      sections: [{ id: 'empty-result', title: '检索结果', content: '未检索到可核验来源。', sourceIds: [] }],
      sources: [],
      limitations: [failureNote, '不能由零检索结果推导“不存在相关法规”。'],
      generatedAt,
      metrics: { candidateCount: 0, verifiedSourceCount: 0, citedSourceCount: 0 },
    },
  };
}

function uniqueLawCandidates(toolResults: DshToolResultEvent[]): BaijianLawRecord[] {
  const unique = new Map<string, BaijianLawRecord>();
  for (const toolResult of toolResults) {
    if (toolResult.isError || !toolResult.result || !('records' in toolResult.result)) continue;
    for (const record of toolResult.result.records) {
      if (!('lawName' in record) || !record.recordId || !record.lawName) continue;
      unique.set(record.recordId.toLowerCase(), record);
    }
  }
  return [...unique.values()];
}

function selectEvidenceBlocks(
  detail: BaijianLawDetail,
  query: string,
): Array<{ article: string; text: string }> {
  const terms = queryTerms(query);
  return detail.contentBlocks
    .map((block, index) => ({
      block,
      index,
      score: terms.reduce((sum, term) => sum + (block.text.includes(term) ? 1 : 0), 0),
    }))
    .filter(({ block }) => block.kind !== 'signature' && block.text.trim().length >= 8)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .map(({ block }, index) => {
      const text = bound(block.text.trim(), 800);
      const article = text.match(/第[\d零〇一二三四五六七八九十百千万亿两]+条(?:之[\d零〇一二三四五六七八九十百千万亿两]+)?/u)?.[0]
        ?? (block.kind === 'heading' ? bound(text, 40) : `正文片段 ${index + 1}`);
      return { article, text };
    });
}

function queryTerms(query: string): string[] {
  const compact = query.replace(/[^\p{L}\p{N}]/gu, '');
  const terms = new Set<string>();
  for (let index = 0; index < compact.length - 1 && terms.size < 80; index += 1) {
    terms.add(compact.slice(index, index + 2));
  }
  return [...terms];
}

function parseModelJson(text: string): ModelReport {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
    : trimmed;
  try {
    const parsed = JSON.parse(withoutFence);
    if (!isRecord(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new Error('dsh Agent AI 搜法报告结构无效：不是合法 JSON 对象');
  }
}

function parseSections(value: unknown, verifiedIds: Set<string>): AiLawResearchSectionV1[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('dsh Agent AI 搜法报告结构无效：sections 不能为空');
  }
  return value.slice(0, 6).map((item, index) => {
    if (!isRecord(item)) throw new Error('dsh Agent AI 搜法报告结构无效：section 不是对象');
    const sourceIds = parseStringArray(item.sourceIds, 10, 64)
      .map((id) => id.toLowerCase())
      .filter((id) => verifiedIds.has(id));
    return {
      id: `analysis-${index + 1}`,
      title: requiredText(item.title, 'section.title', 80),
      content: requiredText(item.content, 'section.content', 3_000),
      sourceIds,
    };
  });
}

function parseEvidenceQuotes(value: unknown, verifiedDetails: BaijianLawDetail[]) {
  if (!Array.isArray(value)) return [];
  const bodies = verifiedDetails.map((detail) => ({
    recordId: detail.recordId.toLowerCase(),
    body: normalizeEvidenceText(detail.contentBlocks.map((block) => block.text).join('\n')),
  }));
  return value.slice(0, 30).flatMap((item) => {
    if (!isRecord(item)
      || typeof item.article !== 'string'
      || typeof item.text !== 'string') return [];
    const quotedText = normalizeEvidenceText(item.text);
    const preferredId = typeof item.recordId === 'string' ? item.recordId.toLowerCase() : '';
    const matched = bodies.find((body) => body.recordId === preferredId && body.body.includes(quotedText))
      ?? bodies.find((body) => body.body.includes(quotedText));
    if (!quotedText || !matched) {
      throw new Error('dsh Agent 引用不是法规正文中的连续原文');
    }
    return {
      recordId: matched.recordId,
      article: bound(item.article.trim() || '法规原文', 60),
      text: bound(item.text.trim(), 1_000),
    };
  });
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

function lawDetailLastVerifiedAt(detail: BaijianLawDetail): string | null {
  const cache = (detail as BaijianLawDetail & { cache?: { lastVerifiedAt?: unknown } }).cache;
  return typeof cache?.lastVerifiedAt === 'string' && cache.lastVerifiedAt.trim()
    ? bound(cache.lastVerifiedAt.trim(), 40)
    : null;
}

function parseStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => bound(item.trim(), maxLength));
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new Error(`dsh Agent AI 搜法报告结构无效：${field} 不能为空`);
  return text;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? bound(text, maxLength) : undefined;
}

function nullableText(value: unknown, maxLength: number): string | null {
  return optionalText(value, maxLength) ?? null;
}

function bound(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
