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
  repaired: boolean;
}

export const AI_LAW_REPORT_OUTPUT_RULE = `最终只输出一个 JSON 对象，不要输出 Markdown 围栏或额外说明。结构必须是：
{"query":"本轮问题","title":"不超过40字的报告标题","scope":"本轮检索范围","summary":"两段以内总结","understanding":{"queryType":"article_location|regulation_location|legal_issue","analysis":"面向用户展示的问题理解，不写内部思维链","retrievalPlan":"面向用户展示的检索与详情读取方案","knownFacts":["当前有效的已知事实"],"legalIssues":["需要处理的法律争点"],"factChanges":{"added":["本轮新增事实"],"corrected":[{"from":"被修正事实","to":"修正后事实"}],"removed":["本轮删除事实"]}},"answer":"供咨询对话直接展示的Markdown答复","sections":[{"title":"分析主题","content":"具体分析","sourceIds":["模型标注的法规ID"]}],"evidenceQuotes":[{"recordId":"模型标注的法规ID","article":"具体条号","text":"法规原文"}],"limitations":["适用边界"]}。
answer 必须包含结论、具体分析、适用边界和来源名称；不得泄露内部推理过程。没有直接引用时 evidenceQuotes 可为空数组；一旦引用，text 必须逐字复制已读取的法规正文连续片段。`;

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
  const evidenceQuotes = parseEvidenceQuotes(value.evidenceQuotes);
  const quotesBySource = new Map<string, Array<{ article: string; text: string }>>();
  for (const quote of evidenceQuotes) {
    const entries = quotesBySource.get(quote.recordId) ?? [];
    entries.push({ article: quote.article, text: quote.text });
    quotesBySource.set(quote.recordId, entries);
  }

  const sections = parseSections(value.sections);
  const hadParsedSections = sections.length > 0;
  const answer = normalizedAnswer(value, parsedOutput.plainText, query, verifiedDetails, sections);
  if (!sections.length) {
    sections.push(...sectionsFromAnswer(
      answer,
      verifiedDetails.slice(0, 3).map((detail) => detail.recordId.toLowerCase()),
    ));
  }
  const sources = verifiedDetails.map((detail) => {
    const quotedArticles = (quotesBySource.get(detail.recordId.toLowerCase()) ?? []).slice(0, 3);
    return {
      recordId: bound(detail.recordId, 64),
      lawName: bound(detail.lawName, 300),
      issuingOrgan: nullableText(detail.issuingOrgan, 200),
      issuingNo: nullableText(detail.issuingNo, 200),
      releaseDate: nullableText(detail.releaseDate, 40),
      implementDate: nullableText(detail.implementDate, 40),
      timeliness: nullableText(detail.timeliness, 40),
      lastVerifiedAt: lawDetailLastVerifiedAt(detail),
      articles: quotedArticles.length ? quotedArticles : selectEvidenceBlocks(detail, query),
    };
  });
  const candidateIds = new Set(toolResults.flatMap((result) => {
    if (!result.result || !('records' in result.result)) return [];
    return result.result.records.map((record) => record.recordId.toLowerCase());
  }));
  const sourceIds = new Set(sources.map((source) => source.recordId.toLowerCase()));
  const citedSourceCount = new Set(evidenceQuotes
    .filter((quote) => sourceIds.has(quote.recordId))
    .map((quote) => quote.recordId)).size;
  const understanding = parseUnderstanding(value.understanding, query, sections, context);
  const presentationRepaired = parsedOutput.repaired
    || !optionalText(value.answer, 20_000)
    || !optionalText(value.title, 100)
    || !optionalText(value.scope, 500)
    || !optionalText(value.summary, 2_000)
    || !hadParsedSections;
  const limitations = parseStringArray(value.limitations, 5, 300);
  if (presentationRepaired && limitations.length < 5) {
    limitations.push('报告展示结构已由系统根据本轮模型输出和检索结果自动补全。');
  }

  return {
    answer,
    report: {
      schemaVersion: 1,
      resultStatus: 'complete',
      query,
      title: optionalText(value.title, 100) ?? defaultReportTitle(query),
      scope: optionalText(value.scope, 500) ?? defaultReportScope(verifiedDetails),
      summary: optionalText(value.summary, 2_000) ?? summaryFromAnswer(answer),
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
    return {
      level: 'candidate_only',
      answer: [
        '## 已找到候选法规，详情正文尚未读取',
        '本轮 AI 结论已被拦截。以下仅是检索召回的候选法规，尚未完成权威正文读取，不得作为法律结论或引用依据。',
        candidateText,
        '请重试以读取详情正文，或缩小问题范围后重新检索。',
      ].join('\n\n'),
      report: {
        schemaVersion: 1,
        resultStatus: 'degraded',
        query: normalizedQuery,
        title: '候选法规已召回，详情正文待读取',
        scope: '本轮法规检索召回结果',
        summary: `${failureNote}系统仅保留候选法规清单，没有输出缺少详情正文读取的法律结论。`,
        understanding: fallbackUnderstanding(normalizedQuery, context, '已完成候选法规召回，权威详情正文尚未读取。'),
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

function parseModelOutput(text: string): ParsedModelOutput {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
    : trimmed;
  const direct = parseJsonRecord(withoutFence);
  if (direct) return { value: direct, repaired: false };

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
    .map((match) => parseJsonRecord(match[1]))
    .find((value): value is ModelReport => Boolean(value));
  if (fenced) return { value: fenced, repaired: true };

  const embedded = extractFirstJsonObject(trimmed);
  const embeddedValue = embedded ? parseJsonRecord(embedded) : undefined;
  if (embeddedValue) return { value: embeddedValue, repaired: true };

  const plainText = withoutFence && !withoutFence.startsWith('{') && !withoutFence.startsWith('[')
    ? bound(withoutFence, 20_000)
    : undefined;
  return { value: {}, ...(plainText ? { plainText } : {}), repaired: true };
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

function parseSections(value: unknown): AiLawResearchSectionV1[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const content = optionalText(item.content, 3_000);
    if (!content) return [];
    const sourceIds = parseStringArray(item.sourceIds, 10, 64).map((id) => id.toLowerCase());
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
  const modelAnswer = optionalText(value.answer, 20_000);
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

function summaryFromAnswer(answer: string): string {
  const plain = answer
    .replace(/^#{1,6}\s*/gmu, '')
    .replace(/^>\s*/gmu, '')
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return bound(plain || '本轮已完成法规检索与权威详情正文读取。', 500);
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

function parseEvidenceQuotes(value: unknown) {
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
      recordId: bound(recordId, 64),
      article: bound(item.article.trim() || '法规原文', 60),
      text: bound(text, 1_000),
    };
  });
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
