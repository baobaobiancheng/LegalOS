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

export interface AiLawResearchUnderstandingV1 {
  queryType: 'article_location' | 'regulation_location' | 'legal_issue';
  analysis: string;
  retrievalPlan: string;
  knownFacts: string[];
  legalIssues: string[];
  factChanges: {
    added: string[];
    corrected: Array<{ from: string; to: string }>;
    removed: string[];
  };
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
  /** 与流式 answer_delta 同源的完整用户正文；旧报告可能没有该字段。 */
  answer?: string;
  understanding: AiLawResearchUnderstandingV1;
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
  understanding?: unknown;
  answer?: unknown;
  sections?: unknown;
  evidenceQuotes?: unknown;
  limitations?: unknown;
}

interface ParsedModelOutput {
  value: ModelReport;
  plainText?: string;
}

interface ParsedEvidenceQuote {
  recordId: string;
  article: string;
  text: string;
}

export const AI_LAW_REPORT_OUTPUT_RULE = `最终只输出一个 JSON 对象，不要输出 Markdown 围栏或额外说明。结构必须是：
{"query":"本轮问题","title":"不超过40字的报告标题","scope":"本轮检索范围","summary":"两段以内总结","understanding":{"queryType":"article_location|regulation_location|legal_issue","analysis":"面向用户展示的问题理解，不写内部思维链","retrievalPlan":"面向用户展示的检索与详情读取方案","knownFacts":["当前有效的已知事实"],"legalIssues":["需要处理的法律争点"],"factChanges":{"added":["本轮新增事实"],"corrected":[{"from":"被修正事实","to":"修正后事实"}],"removed":["本轮删除事实"]}},"answer":"供咨询对话直接展示的Markdown答复","sections":[{"title":"分析主题","content":"具体分析","sourceIds":["模型标注的法规ID"]}],"evidenceQuotes":[{"recordId":"模型标注的法规ID","article":"具体条号","text":"法规原文"}],"limitations":["适用边界"]}。
summary 必须使用客观、正式的书面法律语言，直接概括结论与主要依据，不得出现“我已经”“现在”“下面输出”等过程性表述。answer 必须包含结论、具体分析、适用边界和来源名称；不得泄露内部推理过程。JSON 字符串内部需要使用引号时优先使用中文引号“”，如使用英文双引号必须正确转义。没有直接引用时 evidenceQuotes 可为空数组；一旦引用，text 必须逐字复制已读取的法规正文连续片段。`;

export interface AiLawResearchTurnContext {
  operation?: 'new' | 'continue' | 'correct' | 'new_issue';
  knownFacts?: string[];
  legalIssues?: string[];
}

export function buildStandaloneAiLawResearchPrompt(
  query: string,
  toolCallLimit: number,
  context: AiLawResearchTurnContext = {},
): string {
  const contextBlock = context.operation && context.operation !== 'new'
    ? `\n【服务端会话状态】\n本轮操作：${context.operation}\n已确认事实：${(context.knownFacts ?? []).join('；') || '暂无'}\n既有争点：${(context.legalIssues ?? []).join('；') || '暂无'}\n用户后续明确更正优先于旧事实；knownFacts 必须输出修正后的完整事实快照，factChanges 只记录本轮变化。`
    : '';
  return `你是企业法律检索 Agent。围绕用户问题完成一份可审计的 AI 搜法报告。
默认只用 search_laws_semantic、search_laws 或 search_laws_advanced 中的一种召回候选；仅在首次零结果或明显缺少规范层级时补充第二次召回，本轮最多两次。如需直接引用法规原文，优先只调用一次 get_law_details 批量读取最多3部最相关法规；仅在单条精确定位时使用 get_law_detail，且本轮不得连续调用多个单条详情。
本轮最多调用工具 ${toolCallLimit} 次；获得足以回答的证据后立即停止。若全部召回为零结果，answer、summary 必须以“未检索到可核验来源”开头，sources 与 evidenceQuotes 为空，不得生成确定性法规结论。
${AI_LAW_REPORT_OUTPUT_RULE}${contextBlock}

【用户问题】
${query}`;
}

export function parseAiLawResearchReport(
  text: string,
  toolResults: DshToolResultEvent[],
  requestedQuery = '',
  context: AiLawResearchTurnContext = {},
): ParsedAiLawResearchReport {
  const parsedOutput = parseModelOutput(text);
  const value = parsedOutput.value;
  const query = bound(requestedQuery.trim() || optionalText(value.query, 1_000) || '', 1_000);
  const verifiedDetails = verifiedLawDetails(toolResults).slice(0, 10);
  const verifiedDetailsById = new Map(
    verifiedDetails.map((detail) => [detail.recordId.toLowerCase(), detail]),
  );
  const verifiedSourceIds = new Set(verifiedDetailsById.keys());
  const evidenceQuotes = validateEvidenceQuotes(
    parseEvidenceQuotes(value.evidenceQuotes),
    verifiedDetailsById,
  );
  const candidateIds = new Set(toolResults.flatMap((result) => {
    if (!result.result || !('records' in result.result)) return [];
    return result.result.records.map((record) => record.recordId.toLowerCase());
  }));

  const sections = parseSections(value.sections, verifiedSourceIds);
  const hasModelBody = Boolean(
    optionalText(value.answer, 60_000)
      || parsedOutput.plainText
      || optionalText(value.summary, 2_000)
      || sections.length,
  );
  const answer = normalizedAnswer(value, parsedOutput.plainText, query, verifiedDetails, sections);
  if (!sections.length) {
    sections.push(...sectionsFromAnswer(
      answer,
      verifiedDetails.slice(0, 3).map((detail) => detail.recordId.toLowerCase()),
    ));
  }
  const sources = verifiedDetails.map((detail) => {
    return {
      recordId: bound(detail.recordId, 64),
      lawName: bound(detail.lawName, 300),
      issuingOrgan: nullableText(detail.issuingOrgan, 200),
      issuingNo: nullableText(detail.issuingNo, 200),
      releaseDate: nullableText(detail.releaseDate, 40),
      implementDate: nullableText(detail.implementDate, 40),
      timeliness: nullableText(detail.timeliness, 40),
      lastVerifiedAt: lawDetailLastVerifiedAt(detail),
      // 展示正文始终来自已读取的权威详情，不把模型 evidenceQuotes 冒充原文。
      articles: selectEvidenceBlocks(detail, query),
    };
  });
  const citedSourceCount = new Set(evidenceQuotes
    .map((quote) => quote.recordId)).size;
  const understanding = parseUnderstanding(value.understanding, query, sections, context);
  const limitations = parseStringArray(value.limitations, 5, 300);
  const summary = normalizedSummary(value.summary, answer, query, verifiedDetails);
  assertAiLawResearchReportComplete({
    answer,
    summary,
    rawAnswer: value.answer,
    hasModelBody,
    candidateCount: candidateIds.size,
    verifiedDetails,
  });
  validateDisplayedDirectQuotes([
    answer,
    summary,
    ...sections.map((section) => section.content),
    understanding.analysis,
    understanding.retrievalPlan,
    ...limitations,
  ], verifiedDetails);

  return {
    answer,
    report: {
      schemaVersion: 1,
      resultStatus: 'complete',
      query,
      title: optionalText(value.title, 100) ?? defaultReportTitle(query),
      scope: optionalText(value.scope, 500) ?? defaultReportScope(verifiedDetails),
      summary,
      answer,
      understanding,
      sections,
      sources,
      limitations,
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
 * 检索运行条件或报告解析失败时的安全降级。此函数刻意不读取 result.text：
 * 只从工具的结构化结果生成内容，避免展示未完成的模型报告。
 */
export function buildAiLawResearchFallback(
  query: string,
  result: DshExecutionResult,
  reasonCode: string,
  context: AiLawResearchTurnContext = {},
): AiLawResearchFallback | undefined {
  if (reasonCode === 'RESEARCH_TOOL_NOT_ALLOWED') return undefined;
  const candidates = uniqueLawCandidates(result.toolResults).slice(0, 10);
  const details = verifiedLawDetails(result.toolResults).slice(0, 5);
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
  const failureNote = `AI 生成内容未满足运行条件（${bound(reasonCode, 80)}），系统未展示该结论。`;

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
      '## AI 报告未能完整生成',
      '下面仅展示已从权威法规详情中读取的原文片段，不作延伸解释。',
      quotedText || sourceSummary,
      '### 处理建议',
      '可重试生成完整分析；上述片段本身不等同于针对具体案件的结论。',
    ].filter(Boolean).join('\n\n');
    return {
      level: 'verified_text',
      answer,
      report: {
        schemaVersion: 1,
        resultStatus: 'degraded',
        query: normalizedQuery,
        title: '已读取的权威法规详情',
        scope: '本轮已成功读取的法规详情正文',
        summary: `${failureNote}以下内容仅为系统已读取的权威法规原文，不包含未完成的 AI 报告。`,
        answer,
        understanding: fallbackUnderstanding(normalizedQuery, context, '已读取候选法规详情正文，但模型报告解析未完成。'),
        sections: [{
          id: 'verified-evidence',
          title: '已读取法规范围',
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
    const answer = [
      '## 已找到候选法规，详情正文尚未读取',
      '本轮 AI 结论已被拦截。以下仅是检索召回的候选法规，尚未完成权威正文读取，不得作为法律结论或引用依据。',
      candidateText,
      '请重试以读取详情正文，或缩小问题范围后重新检索。',
    ].join('\n\n');
    return {
      level: 'candidate_only',
      answer,
      report: {
        schemaVersion: 1,
        resultStatus: 'degraded',
        query: normalizedQuery,
        title: '候选法规已召回，详情正文待读取',
        scope: '本轮法规检索召回结果',
        summary: `${failureNote}系统仅保留候选法规清单，没有输出缺少详情正文读取的法律结论。`,
        answer,
        understanding: fallbackUnderstanding(normalizedQuery, context, '已完成候选法规召回，权威详情正文尚未读取。'),
        sections: [{ id: 'candidate-laws', title: '候选法规', content: candidateText, sourceIds: [] }],
        sources: [],
        limitations: [failureNote, '候选法规尚未读取详情正文，不得用于正式引用。'],
        generatedAt,
        metrics: { candidateCount: candidates.length, verifiedSourceCount: 0, citedSourceCount: 0 },
      },
    };
  }

  const answer = '## 未检索到可核验来源\n\n本轮法规检索已完成，但未召回候选法规。系统未生成确定性法律结论，请更换关键词或缩小问题范围后重试。';
  return {
    level: 'empty',
    answer,
    report: {
      schemaVersion: 1,
      resultStatus: 'degraded',
      query: normalizedQuery,
      title: '未检索到可核验法规',
      scope: '本轮法规检索',
      summary: '本轮未召回候选法规，系统未输出确定性法律结论。',
      answer,
      understanding: fallbackUnderstanding(normalizedQuery, context, '本轮检索未召回可核验法规。'),
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

/**
 * 对模型的顶层 JSON 做增量扫描，只解码 `answer` 字符串。
 * 它不要求 answer 之前的其他字符串内容完全合法，因此也可用于终态容错恢复。
 */
export class JsonAnswerFieldStream {
  private readonly containers: Array<'object' | 'array'> = [];
  private stringKind: 'key' | 'answer' | 'other' | undefined;
  private keyBuffer = '';
  private pendingKey = '';
  private rootToken = '';
  private escaped = false;
  private unicodeDigits = '';
  private completed = false;

  push(chunk: string): string {
    if (!chunk || this.completed) return '';
    const answer: string[] = [];
    for (const char of chunk) {
      if (this.completed) break;
      if (this.stringKind) this.consumeStringCharacter(char, answer);
      else this.consumeStructuralCharacter(char);
    }
    return answer.join('');
  }

  private consumeStructuralCharacter(char: string): void {
    if (/\s/u.test(char)) return;
    const atRootObject = this.containers.length === 1 && this.containers[0] === 'object';
    if (char === '"') {
      this.escaped = false;
      this.unicodeDigits = '';
      this.keyBuffer = '';
      this.stringKind = atRootObject && (this.rootToken === '{' || this.rootToken === ',')
        ? 'key'
        : atRootObject && this.rootToken === ':' && this.pendingKey === 'answer'
          ? 'answer'
          : 'other';
      return;
    }
    if (char === '{') {
      this.containers.push('object');
      if (this.containers.length === 1) {
        this.rootToken = '{';
        this.pendingKey = '';
      }
      return;
    }
    if (char === '[') {
      this.containers.push('array');
      return;
    }
    if (char === '}' || char === ']') {
      if (this.containers.length) this.containers.pop();
      if (this.containers.length === 1 && this.containers[0] === 'object') {
        this.rootToken = 'value';
      } else if (!this.containers.length) {
        this.rootToken = '';
        this.pendingKey = '';
      }
      return;
    }
    if (!atRootObject) return;
    if (char === ':') {
      this.rootToken = ':';
      return;
    }
    if (char === ',') {
      this.rootToken = ',';
      this.pendingKey = '';
      return;
    }
    if (this.rootToken === ':') this.rootToken = 'value';
  }

  private consumeStringCharacter(char: string, answer: string[]): void {
    if (this.unicodeDigits) {
      if (/^[0-9a-f]$/iu.test(char)) {
        this.unicodeDigits += char;
        if (this.unicodeDigits.length === 5) {
          this.appendDecoded(String.fromCharCode(Number.parseInt(this.unicodeDigits.slice(1), 16)), answer);
          this.unicodeDigits = '';
        }
      } else {
        this.appendDecoded(`\\${this.unicodeDigits}${char}`, answer);
        this.unicodeDigits = '';
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (char === 'u') {
        this.unicodeDigits = 'u';
        return;
      }
      const decoded: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      this.appendDecoded(decoded[char] ?? char, answer);
      return;
    }
    if (char === '\\') {
      this.escaped = true;
      return;
    }
    if (char !== '"') {
      this.appendDecoded(char, answer);
      return;
    }

    if (this.stringKind === 'key') {
      this.pendingKey = this.keyBuffer;
      this.rootToken = 'key';
    } else if (this.stringKind === 'answer') {
      this.completed = true;
      this.rootToken = 'value';
    } else if (this.containers.length === 1 && this.containers[0] === 'object') {
      this.rootToken = 'value';
    }
    this.stringKind = undefined;
  }

  private appendDecoded(value: string, answer: string[]): void {
    if (this.stringKind === 'key') this.keyBuffer += value;
    else if (this.stringKind === 'answer') answer.push(value);
  }
}

function parseModelOutput(text: string): ParsedModelOutput {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
    : trimmed;
  const direct = parseJsonRecord(withoutFence);
  if (direct) return { value: direct };

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
    .map((match) => parseJsonRecord(match[1]))
    .find((value): value is ModelReport => Boolean(value));
  if (fenced) return { value: fenced };

  const embedded = extractFirstJsonObject(trimmed);
  const embeddedValue = embedded ? parseJsonRecord(embedded) : undefined;
  if (embeddedValue) return { value: embeddedValue };

  // 结构化输出即使因未转义引号等问题损坏，也只能恢复明确的 answer 字段；
  // 绝不能把 JSON 外壳、系统字段和模型过程性说明作为用户正文展示。
  if (looksLikeStructuredModelOutput(trimmed)) {
    const recoveredAnswer = new JsonAnswerFieldStream().push(trimmed).trim();
    return {
      value: recoveredAnswer ? { answer: bound(recoveredAnswer, 60_000) } : {},
    };
  }

  const plainText = withoutFence && !withoutFence.startsWith('{') && !withoutFence.startsWith('[')
    ? bound(withoutFence, 60_000)
    : undefined;
  return { value: {}, ...(plainText ? { plainText } : {}) };
}

function looksLikeStructuredModelOutput(value: string): boolean {
  const sample = value.slice(0, 12_000);
  return /```(?:json)?/iu.test(sample)
    || /(?:^|[{,])\s*"(?:query|title|scope|summary|understanding|answer|sections|evidenceQuotes|limitations)"\s*:/u.test(sample);
}

function parseJsonRecord(value: string): ModelReport | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(value: string): string | undefined {
  const start = value.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseSections(value: unknown, verifiedSourceIds: ReadonlySet<string>): AiLawResearchSectionV1[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const content = optionalText(item.content, 3_000);
    if (!content) return [];
    const sourceIds = parseStringArray(item.sourceIds, 10, 64)
      .map((id) => id.toLowerCase())
      .filter((id) => verifiedSourceIds.has(id));
    return [{
      id: `analysis-${index + 1}`,
      title: optionalText(item.title, 80) ?? `分析 ${index + 1}`,
      content,
      sourceIds,
    }];
  });
}

function normalizedAnswer(
  value: ModelReport,
  plainText: string | undefined,
  query: string,
  details: BaijianLawDetail[],
  sections: AiLawResearchSectionV1[],
): string {
  const modelAnswer = optionalText(value.answer, 60_000);
  if (modelAnswer) return modelAnswer;
  if (plainText) return plainText;

  const summary = optionalText(value.summary, 2_000);
  if (summary || sections.length) {
    return [
      summary ? `## 总结\n\n${summary}` : '',
      ...sections.map((section) => `## ${section.title}\n\n${section.content}`),
    ].filter(Boolean).join('\n\n');
  }

  const lawNames = details.slice(0, 5).map((detail) => `《${detail.lawName}》`).join('、');
  return [
    '## 检索结果',
    `已围绕“${bound(query || '本轮问题', 160)}”完成法规检索${lawNames ? `，并读取${lawNames}的权威详情正文` : ''}。`,
    '模型未返回完整的展示字段，系统已保留本轮检索结果和权威来源，供进一步核对。',
  ].join('\n\n');
}

function defaultReportTitle(query: string): string {
  const compact = query.replace(/\s+/gu, ' ').trim();
  return compact ? `${bound(compact, 32)}法律检索报告` : 'AI 法律检索报告';
}

function defaultReportScope(details: BaijianLawDetail[]): string {
  const names = [...new Set(details.map((detail) => detail.lawName).filter(Boolean))].slice(0, 5);
  return names.length ? `本轮已读取：${names.join('、')}` : '本轮法规检索及权威详情读取范围';
}

function normalizedSummary(
  value: unknown,
  answer: string,
  query: string,
  details: BaijianLawDetail[],
): string {
  const modelSummary = optionalText(value, 2_000);
  if (modelSummary && isUserFacingSummary(modelSummary)) return modelSummary;
  return summaryFromAnswer(answer, query, details);
}

function isUserFacingSummary(value: string): boolean {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return false;
  if (looksLikeStructuredModelOutput(compact)) return false;
  return !/^(?:我已经|现在(?:我|将|开始)?|下面(?:将|输出|给出)|以下为(?:本轮|结构化|完整))/u.test(compact);
}

function summaryFromAnswer(answer: string, query: string, details: BaijianLawDetail[]): string {
  const paragraphs = answer
    .replace(/```[\s\S]*?```/gu, ' ')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph
      .replace(/^#{1,6}\s+.*$/gmu, '')
      .replace(/^>\s*/gmu, '')
      .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/gmu, '')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1')
      .replace(/[*_`]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter((paragraph) => paragraph && isUserFacingSummary(paragraph));
  const substantive = paragraphs.slice(0, 2).join(' ');
  if (substantive) return bound(substantive, 500);

  const lawNames = [...new Set(details.map((detail) => detail.lawName).filter(Boolean))].slice(0, 3);
  const scope = lawNames.length ? `，并读取${lawNames.map((name) => `《${name}》`).join('、')}的权威详情正文` : '';
  return bound(`已围绕“${bound(query || '本轮法律问题', 120)}”完成法规检索${scope}。本报告仅依据本轮已取得的法规资料整理，具体适用仍需结合案件事实判断。`, 500);
}

function sectionsFromAnswer(answer: string, sourceIds: string[]): AiLawResearchSectionV1[] {
  const blocks: Array<{ title: string; content: string }> = [];
  let currentTitle = '具体分析';
  let currentLines: string[] = [];
  const flush = () => {
    const content = currentLines.join('\n').trim();
    if (content) blocks.push({ title: currentTitle, content });
    currentLines = [];
  };
  for (const line of answer.split(/\r?\n/u)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (heading) {
      flush();
      currentTitle = bound(heading[1], 80);
    } else {
      currentLines.push(line);
    }
  }
  flush();
  if (!blocks.length && answer.trim()) blocks.push({ title: '具体分析', content: answer.trim() });

  const sections: AiLawResearchSectionV1[] = [];
  for (const block of blocks) {
    const chunks = splitBoundedText(block.content, 3_000);
    for (let index = 0; index < chunks.length; index += 1) {
      if (sections.length >= 12) break;
      sections.push({
        id: `analysis-${sections.length + 1}`,
        title: index ? bound(`${block.title}（续 ${index + 1}）`, 80) : block.title,
        content: chunks[index],
        sourceIds,
      });
    }
    if (sections.length >= 12) break;
  }
  return sections.length ? sections : [{
    id: 'analysis-1',
    title: '具体分析',
    content: '本轮已完成法规检索与详情正文读取。',
    sourceIds,
  }];
}

function splitBoundedText(value: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const pushCurrent = () => {
    const text = current.trim();
    if (text) chunks.push(text);
    current = '';
  };
  for (const paragraph of value.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean)) {
    if (paragraph.length > maxLength) {
      pushCurrent();
      for (let start = 0; start < paragraph.length; start += maxLength) {
        chunks.push(paragraph.slice(start, start + maxLength));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength) pushCurrent();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  pushCurrent();
  return chunks;
}

function parseEvidenceQuotes(value: unknown): ParsedEvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item) => {
    if (!isRecord(item)
      || typeof item.recordId !== 'string'
      || typeof item.article !== 'string'
      || typeof item.text !== 'string') return [];
    const recordId = item.recordId.trim().toLowerCase();
    const text = item.text.trim();
    if (!recordId || !text) return [];
    return {
      recordId,
      article: bound(item.article.trim() || '法规原文', 60),
      text,
    };
  });
}

function validateEvidenceQuotes(
  quotes: ParsedEvidenceQuote[],
  verifiedDetailsById: ReadonlyMap<string, BaijianLawDetail>,
): ParsedEvidenceQuote[] {
  return quotes.map((quote) => {
    if (quote.recordId.length > 64 || quote.text.length > 1_000) {
      invalidAiLawReport('模型引文超出长度限制');
    }
    const detail = verifiedDetailsById.get(quote.recordId);
    if (!detail) invalidAiLawReport(`引文来源未经正文核验：${bound(quote.recordId, 64)}`);
    if (!detail.contentBlocks.some((block) => evidenceTextContains(block.text, quote.text))) {
      invalidAiLawReport(`引文与已读取的权威正文不一致：${bound(quote.recordId, 64)}`);
    }
    return {
      recordId: bound(quote.recordId, 64),
      article: quote.article,
      text: bound(quote.text, 1_000),
    };
  });
}

function validateDisplayedDirectQuotes(texts: string[], details: BaijianLawDetail[]): void {
  const quotes = texts.flatMap((text) => [
    ...markdownBlockquotes(text),
    ...attributedDirectQuotes(text),
  ]);
  if (!quotes.length) return;
  const bodyBlocks = details.flatMap((detail) => detail.contentBlocks.map((block) => block.text));
  for (const quote of quotes) {
    if (!bodyBlocks.some((body) => evidenceTextContains(body, quote))) {
      invalidAiLawReport('展示内容中的法规直接引文与已读取的权威正文不一致');
    }
  }
}

/**
 * 识别普通段落里以法规名称/条号 + “规定：”引出的直接引文。
 * 普通的业务术语引号不在此列，避免把“红筹架构”等用户措辞误判为法条原文。
 */
function attributedDirectQuotes(value: string): string[] {
  const quotes: string[] = [];
  const attribution = /(?:《[^》\r\n]{1,100}》|(?:第[0-9零〇一二三四五六七八九十百千万亿两]+条(?:之[0-9零〇一二三四五六七八九十百千万亿两]+)?))[^。！？\r\n]{0,120}(?:明确)?(?:规定|指出|载明|要求|原文)(?:如下|为)?\s*[：:]\s*(?:\r?\n\s*)?(?:[“"]([^”"\r\n]{4,1000})[”"]|([^\r\n]{8,1000}))/gu;
  for (const match of value.matchAll(attribution)) {
    const quote = (match[1] ?? match[2] ?? '')
      .replace(/^[>*_`\s-]+/gu, '')
      .replace(/[*_`\s]+$/gu, '')
      .trim();
    if (quote && !/^#{1,6}\s/u.test(quote)) quotes.push(quote);
  }
  return quotes;
}

function markdownBlockquotes(answer: string): string[] {
  const quotes: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const quote = current.join(' ')
      .replace(/[*_`]/gu, '')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1')
      .replace(/\s+/gu, ' ')
      .trim();
    if (quote) quotes.push(quote);
    current = [];
  };
  for (const line of answer.split(/\r?\n/u)) {
    const match = line.match(/^\s*>+\s?(.*)$/u);
    if (match) current.push(match[1]);
    else flush();
  }
  flush();
  return quotes;
}

function evidenceTextContains(body: string, quote: string): boolean {
  const normalizedBody = normalizeEvidenceText(body);
  const normalizedQuote = normalizeEvidenceText(quote);
  return Boolean(normalizedQuote) && normalizedBody.includes(normalizedQuote);
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

function assertAiLawResearchReportComplete(input: {
  answer: string;
  summary: string;
  rawAnswer: unknown;
  hasModelBody: boolean;
  candidateCount: number;
  verifiedDetails: BaijianLawDetail[];
}): void {
  if (!input.hasModelBody) invalidAiLawReport('模型未返回可展示的报告正文');
  if (typeof input.rawAnswer === 'string' && input.rawAnswer.trim().length > 60_000) {
    invalidAiLawReport('模型报告正文超出长度限制');
  }
  if (isIncompleteReportBody(input.answer)) invalidAiLawReport('模型报告正文疑似截断');

  const hasVerifiedEvidence = input.verifiedDetails.length > 0;
  const isEmptyResult = input.candidateCount === 0 && !hasVerifiedEvidence;
  const answerDeclaresEmpty = startsWithNoVerifiedSource(input.answer);
  const summaryDeclaresEmpty = startsWithNoVerifiedSource(input.summary);
  if (isEmptyResult && (!answerDeclaresEmpty || !summaryDeclaresEmpty)) {
    invalidAiLawReport('零结果时未明确声明“未检索到可核验来源”');
  }
  if (!isEmptyResult && answerDeclaresEmpty) {
    invalidAiLawReport('已有候选或权威正文时仍声明零结果');
  }
  if (input.candidateCount > 0 && !hasVerifiedEvidence) {
    invalidAiLawReport('已召回候选法规但报告没有已核验正文');
  }
}

function isIncompleteReportBody(answer: string): boolean {
  const fenceCount = answer.match(/```/gu)?.length ?? 0;
  if (fenceCount % 2 !== 0) return true;
  const lines = answer.split(/\r?\n/u).map((line) => line.trim());
  while (lines.length && (!lines[lines.length - 1] || /^[-*_]{3,}$/u.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  const lastLine = lines.at(-1) ?? '';
  if (!lastLine) return true;
  if (/^#{1,6}\s+\S.*$/u.test(lastLine)) return true;
  if (/^(?:[-*+]|\d+[.)、])\s*$/u.test(lastLine)) return true;
  const terminal = lastLine.replace(/[\s*_`#]+$/gu, '');
  return /[:：,，、;；…(（[{【《-]$/u.test(terminal)
    || /(?:如下|具体为|分别为|主要包括|具体包括|明确规定|载明如下)$/u.test(terminal);
}

function startsWithNoVerifiedSource(value: string): boolean {
  const firstLine = value.split(/\r?\n/u)
    .map((line) => line.trim()
      .replace(/^#{1,6}\s*/u, '')
      .replace(/^[>*_`\s]+/u, '')
      .trim())
    .find(Boolean) ?? '';
  return firstLine.startsWith('未检索到可核验来源');
}

function invalidAiLawReport(reason: string): never {
  throw new Error(`dsh Agent AI 搜法报告结构无效：${reason}`);
}

function parseUnderstanding(
  value: unknown,
  query: string,
  sections: AiLawResearchSectionV1[],
  context: AiLawResearchTurnContext,
): AiLawResearchUnderstandingV1 {
  const record = isRecord(value) ? value : {};
  const queryType = record.queryType === 'article_location'
    || record.queryType === 'regulation_location'
    || record.queryType === 'legal_issue'
    ? record.queryType
    : 'legal_issue';
  const factChanges = isRecord(record.factChanges) ? record.factChanges : {};
  const modelCorrected = Array.isArray(factChanges.corrected)
    ? factChanges.corrected.flatMap((item) => {
      if (!isRecord(item)) return [];
      const from = optionalText(item.from, 300);
      const to = optionalText(item.to, 300);
      return from && to ? [{ from, to }] : [];
    }).slice(0, 10)
    : [];
  const deterministicCorrection = context.operation === 'correct' ? inferFactCorrection(query) : undefined;
  const corrected = deterministicCorrection
    && !modelCorrected.some((item) => item.from === deterministicCorrection.from && item.to === deterministicCorrection.to)
    ? [...modelCorrected, deterministicCorrection].slice(0, 10)
    : modelCorrected;
  const modelFacts = parseStringArray(record.knownFacts, 20, 300);
  const proposedFacts = modelFacts.length ? modelFacts : (context.knownFacts ?? []);
  const knownFacts = context.operation === 'correct'
    ? fallbackFacts(proposedFacts, query, 'correct')
    : modelFacts.length ? modelFacts : fallbackFacts(proposedFacts, query, context.operation ?? 'new');
  const legalIssues = parseStringArray(record.legalIssues, 12, 160);
  const issues = legalIssues.length ? legalIssues : sections.map((section) => section.title).slice(0, 12);
  return {
    queryType,
    analysis: optionalText(record.analysis, 1_000)
      ?? `已围绕“${bound(query, 120)}”梳理已知事实、法律关系和需要核验的争点。`,
    retrievalPlan: optionalText(record.retrievalPlan, 1_000)
      ?? `围绕${issues.join('、') || '本轮法律问题'}召回候选法规，并读取最相关法规的权威正文。`,
    knownFacts,
    legalIssues: issues,
    factChanges: {
      added: parseStringArray(factChanges.added, 10, 300),
      corrected,
      removed: parseStringArray(factChanges.removed, 10, 300),
    },
  };
}

function fallbackFacts(
  previous: string[],
  query: string,
  operation: AiLawResearchTurnContext['operation'],
): string[] {
  const bounded = previous.slice(0, 20).map((item) => bound(item, 300));
  if (operation !== 'correct') return bounded;
  const direct = inferFactCorrection(query);
  if (!direct) return [...bounded, `用户更正：${bound(query, 260)}`].slice(-20);
  return [...new Set([...bounded.filter((item) => !item.includes(direct.from)), direct.to])].slice(-20);
}

function inferFactCorrection(query: string): { from: string; to: string } | undefined {
  const direct = query.match(/不是(.{1,120}?)(?:[，,；;]\s*)?(?:而?是|实际是|应为)(.{1,160})/u);
  if (!direct) return undefined;
  const from = direct[1].trim();
  const to = direct[2].trim();
  return from && to ? { from, to } : undefined;
}

function fallbackUnderstanding(
  query: string,
  context: AiLawResearchTurnContext,
  retrievalPlan: string,
): AiLawResearchUnderstandingV1 {
  return {
    queryType: 'legal_issue',
    analysis: `已围绕“${bound(query, 120)}”分析本轮检索需求。`,
    retrievalPlan,
    knownFacts: fallbackFacts(context.knownFacts ?? [], query, context.operation ?? 'new'),
    legalIssues: context.legalIssues?.slice(0, 12).map((item) => bound(item, 160)) ?? [],
    factChanges: { added: [], corrected: [], removed: [] },
  };
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
