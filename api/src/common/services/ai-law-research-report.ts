import { DshToolResultEvent, DSH_LAW_BATCH_DETAIL_TOOL, DSH_LAW_DETAIL_TOOL } from './dsh-agent.types';
import { BaijianLawDetail } from '../baijian/baijian.types';

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
  articles: Array<{ article: string; text: string }>;
}

export interface AiLawResearchReportV1 {
  schemaVersion: 1;
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
answer 必须包含结论、具体分析、适用边界和来源名称；不得泄露内部推理过程。evidenceQuotes 只能逐字复制已读取详情正文。`;

export function buildStandaloneAiLawResearchPrompt(query: string, toolCallLimit: number): string {
  return `你是企业法律检索 Agent。围绕用户问题完成一份可审计的 AI 搜法报告。
先用 search_laws_semantic、search_laws 或 search_laws_advanced 召回候选；为覆盖不同规范层级，最多使用两次召回。候选命中后优先只调用一次 get_law_details，批量核验最多10部最相关法规；仅在单条精确定位时才使用 get_law_detail。只有详情正文才算已核验。
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
  const evidenceQuotes = parseEvidenceQuotes(value.evidenceQuotes, verifiedIds);
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
    const sourceIds = parseStringArray(item.sourceIds, 10, 64).map((id) => id.toLowerCase());
    const unsupported = sourceIds.find((id) => !verifiedIds.has(id));
    if (unsupported) throw new Error(`dsh Agent AI 搜法报告结构无效：section 引用了未核验法规 ${unsupported}`);
    return {
      id: `analysis-${index + 1}`,
      title: requiredText(item.title, 'section.title', 80),
      content: requiredText(item.content, 'section.content', 3_000),
      sourceIds,
    };
  });
}

function parseEvidenceQuotes(value: unknown, verifiedIds: Set<string>) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => {
    if (!isRecord(item)) throw new Error('dsh Agent AI 搜法报告结构无效：evidenceQuote 不是对象');
    const recordId = requiredText(item.recordId, 'evidenceQuote.recordId', 64).toLowerCase();
    if (!verifiedIds.has(recordId)) {
      throw new Error(`dsh Agent AI 搜法报告结构无效：引用未核验法规 ${recordId}`);
    }
    return {
      recordId,
      article: requiredText(item.article, 'evidenceQuote.article', 60),
      text: requiredText(item.text, 'evidenceQuote.text', 1_000),
    };
  });
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
