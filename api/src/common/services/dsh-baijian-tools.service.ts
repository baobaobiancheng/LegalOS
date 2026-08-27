import { Injectable } from '@nestjs/common';
import { CachedLegalResearchGateway } from '../baijian/cached-legal-research.gateway';
import {
  BaijianLawContentBlock,
  BaijianLawDetail,
  BaijianLawRecord,
} from '../baijian/baijian.types';
import {
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
  DSH_CASE_SEARCH_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DshResearchCapability,
} from './dsh-agent.types';

export const DSH_BAIJIAN_RESULT_META_KIND = 'baijian-result-v1';

/**
 * 将现有百鉴 SDK + normalizer 适配为 dsh 原生工具。
 * 该层不处理 Agent 会话或 prompt，也不暴露百鉴凭证。
 */
@Injectable()
export class DshBaijianToolsService {
  constructor(private readonly baijian: CachedLegalResearchGateway) {}

  async createDefinition(capability: DshResearchCapability): Promise<any> {
    return (await this.createDefinitions(capability))[0];
  }

  async createDefinitions(capability: DshResearchCapability): Promise<any[]> {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const baijian = this.baijian;
    if (capability === 'law_search') {
      const candidates = new Map<string, Pick<BaijianLawRecord, 'articleNumber' | 'matchedContent'>>();
      return [defineTool({
        name: DSH_LAW_SEARCH_TOOL,
        description: '用简短关键词召回中国法规候选；适合法规名、主题或文号。仅返回元数据，命中后必须用 get_law_detail 核验正文。',
        parameters: {
          keyword: { type: 'string', required: true, description: '法规关键词，不要包含姓名、手机号等个人信息。' },
          page: { type: 'integer', description: '页码，默认 1。' },
          rows: { type: 'integer', description: '返回数量，默认 5，最多 5。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          const result = await baijian.searchLaws({
            keyword: args.keyword,
            page: clamp(args.page, 1, 10, 1),
            rows: clamp(args.rows, 1, 5, 5),
          }, exec.signal);
          rememberCandidates(result.records, candidates);
          return result as any;
        },
      }), defineTool({
        name: DSH_LAW_ADVANCED_SEARCH_TOOL,
        description: '按关键词、发文机关和时效性组合精准检索法规；适合用户明确要求现行有效或特定机关的任务。命中后必须读取详情。',
        parameters: {
          keyword: { type: 'string', required: true, description: '1–200 字法规关键词组合。' },
          issuingOrgan: { type: 'string', description: '可选发文机关，例如国务院。' },
          timeliness: { type: 'string', enum: ['0', '1', '2', '3', '4'], description: '0尚未实施、1现行有效、2已失效、3已修改、4草案。' },
          page: { type: 'integer', description: '页码，默认1。' },
          rows: { type: 'integer', description: '返回数量，默认5，最多5。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          const result = await baijian.searchLawsAdvanced({
            keyword: args.keyword,
            issuingOrgan: args.issuingOrgan,
            timeliness: args.timeliness,
            page: clamp(args.page, 1, 10, 1),
            rows: clamp(args.rows, 1, 5, 5),
          }, exec.signal);
          rememberCandidates(result.records, candidates);
          return result as any;
        },
      }), defineTool({
        name: DSH_LAW_SEMANTIC_SEARCH_TOOL,
        description: '用去识别化的自然语言法律问题做法规语义召回；适合法律问题和事实型输入。结果含匹配片段但不是完整正文，命中后必须读取详情。',
        parameters: {
          query: { type: 'string', required: true, description: '不含姓名、电话等个人信息的完整法律问题。' },
          keyword: { type: 'string', description: '可选法规标题关键词。' },
          issuingOrgan: { type: 'string', description: '可选发文机关。' },
          timeliness: { type: 'string', enum: ['0', '1', '2', '4'], description: '0尚未实施、1现行有效、2已失效、4已修改。' },
          rows: { type: 'integer', description: '返回数量，默认5，最多5。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          const result = await baijian.searchLawsSemantic({
            query: args.query,
            keyword: args.keyword,
            issuingOrgan: args.issuingOrgan,
            timeliness: args.timeliness,
            rows: clamp(args.rows, 1, 5, 5),
          }, exec.signal);
          rememberCandidates(result.records, candidates);
          return result as any;
        },
      }), defineTool({
        name: DSH_LAW_BATCH_DETAIL_TOOL,
        description: '批量读取最多10部候选法规的权威正文，并分别定位与本案相关条文。lawIds 必须全部来自本轮搜索结果；一次调用完成批量核验，避免逐部法规反复调用。',
        parameters: {
          lawIds: { type: 'array', required: true, items: { type: 'string' }, description: '搜索结果返回的法规ID数组，去重后最多10个。' },
          query: { type: 'string', required: true, description: '需要在各部法规正文中定位的法律问题或制度关键词。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 90_000,
        async execute(args, exec) {
          const lawIds = [...new Set((Array.isArray(args.lawIds) ? args.lawIds : [])
            .map((value: unknown) => String(value ?? '').trim())
            .filter(Boolean))].slice(0, 10);
          if (!lawIds.length) throw new Error('批量法规详情至少需要一个候选法规ID');
          const unknown = lawIds.find((lawId) => !candidates.has(lawId.toLowerCase()));
          if (unknown) throw new Error(`法规详情 ID 必须来自本轮搜索结果：${unknown}`);
          const sharedQuery = boundedText(args.query, 300);
          if (!sharedQuery) throw new Error('批量法规详情必须提供 query 以定位目标正文');
          const details = await mapWithConcurrency(lawIds, 3, async (lawId) => {
            const candidate = candidates.get(lawId.toLowerCase())!;
            const detail = await baijian.getLawDetail({ lawId }, exec.signal);
            return projectLawDetail(detail, {
              articleHint: candidate.articleNumber || undefined,
              query: candidate.matchedContent || sharedQuery,
            }, { maxBytes: 14 * 1024, maxBlocks: 24, maxRankedBlocks: 4, radius: 1 });
          });
          return { toolName: DSH_LAW_BATCH_DETAIL_TOOL, details } as any;
        },
      }), defineTool({
        name: DSH_LAW_DETAIL_TOOL,
        description: '读取候选法规的权威正文，并从完整法规中定位目标条文。lawId 必须来自本轮搜索结果；传 articleHint（如第八十七条）或 query（如违法解除赔偿金），不要通读无关正文。',
        parameters: {
          lawId: { type: 'string', required: true, description: '搜索结果返回的32位法规ID。' },
          articleHint: { type: 'string', description: '目标条号，优先传入语义搜索结果的 articleNumber。' },
          query: { type: 'string', description: '需要在正文中定位的法律问题或制度关键词。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          const lawId = String(args.lawId ?? '').trim();
          const candidate = candidates.get(lawId.toLowerCase());
          if (!candidate) {
            throw new Error('法规详情 ID 必须来自本轮搜索结果');
          }
          const articleHint = boundedText(args.articleHint, 40) || candidate.articleNumber || undefined;
          const query = boundedText(args.query, 200) || candidate.matchedContent || undefined;
          if (!articleHint && !query) {
            throw new Error('法规详情必须提供 articleHint 或 query 以定位目标正文');
          }
          const detail = await baijian.getLawDetail({ lawId }, exec.signal);
          return projectLawDetail(detail, { articleHint, query }) as any;
        },
      })];
    }

    return [defineTool({
      name: DSH_CASE_SEARCH_TOOL,
      description: '检索中国相似案例。请自主把用户问题改写为不含个人信息的完整法律问题。',
      parameters: {
        query: { type: 'string', required: true, description: '用于语义检索的完整法律问题。' },
        topK: { type: 'integer', description: '返回案例数，默认 5，最多 5。' },
      },
      output: this.outputDefinition(),
      timeoutMs: 60_000,
      async execute(args, exec) {
        return baijian.searchCases({
          query: args.query,
          topK: clamp(args.topK, 1, 5, 5),
        }, exec.signal) as Promise<any>;
      },
    })];
  }

  private outputDefinition() {
    return {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: JSON.stringify(value),
      }],
      // dsh 不持久 canonical value；将有界的标准化结果投影到 tool/result.meta，
      // 供服务端在会话回放与最终引用校验时使用。
      presentationMeta: (_args: unknown, value: unknown) => ({
        kind: DSH_BAIJIAN_RESULT_META_KIND,
        result: JSON.parse(JSON.stringify(value)),
      }),
    };
  }
}

function rememberCandidates(
  records: Array<Pick<BaijianLawRecord, 'recordId' | 'articleNumber' | 'matchedContent'>>,
  candidates: Map<string, Pick<BaijianLawRecord, 'articleNumber' | 'matchedContent'>>,
) {
  for (const record of records) {
    candidates.set(record.recordId.toLowerCase(), {
      articleNumber: record.articleNumber,
      matchedContent: record.matchedContent,
    });
  }
}

export function projectLawDetail(
  detail: BaijianLawDetail,
  target: { articleHint?: string; query?: string },
  budget: { maxBytes?: number; maxBlocks?: number; maxRankedBlocks?: number; radius?: number } = {},
): BaijianLawDetail & { selection: { articleHint: string | null; query: string | null; matched: boolean } } {
  const articleHint = target.articleHint?.trim() || null;
  const query = target.query?.trim() || null;
  const normalizedHint = articleHint ? normalizeForMatch(articleHint) : '';
  const exactIndexes = normalizedHint
    ? detail.contentBlocks.flatMap((block, index) => normalizeForMatch(block.text).includes(normalizedHint) ? [index] : [])
    : [];
  const rankedIndexes = exactIndexes.length
    ? exactIndexes
    : rankRelevantBlocks(detail.contentBlocks, query ?? '');
  const selectedIndexes = expandIndexes(
    rankedIndexes.slice(0, budget.maxRankedBlocks ?? 8),
    detail.contentBlocks.length,
    budget.radius ?? 2,
  );
  const contentBlocks = takeWithinBudget(
    selectedIndexes.map((index) => detail.contentBlocks[index]),
    budget.maxBytes ?? 80 * 1024,
    budget.maxBlocks ?? 120,
  );
  return {
    ...detail,
    toc: [],
    contentBlocks,
    selection: { articleHint, query, matched: exactIndexes.length > 0 || rankedIndexes.length > 0 },
  };
}

function rankRelevantBlocks(blocks: BaijianLawContentBlock[], query: string): number[] {
  const terms = keywordTerms(query);
  if (!terms.length) return [];
  return blocks
    .map((block, index) => ({
      index,
      score: terms.reduce((score, term) => score + (normalizeForMatch(block.text).includes(term) ? term.length : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.index);
}

function keywordTerms(value: string): string[] {
  const normalized = normalizeForMatch(value);
  const chunks = value
    .split(/[\s，。；：、,.!?;:()（）\[\]{}<>《》]+/u)
    .map(normalizeForMatch)
    .filter((term) => term.length >= 2);
  const phrases = normalized.length >= 4
    ? Array.from({ length: Math.min(normalized.length - 3, 40) }, (_, index) => normalized.slice(index, index + 4))
    : [];
  return [...new Set([...chunks, ...phrases])].sort((left, right) => right.length - left.length);
}

function expandIndexes(indexes: number[], length: number, radius: number): number[] {
  const expanded = new Set<number>();
  for (const index of indexes) {
    for (let current = Math.max(0, index - radius); current <= Math.min(length - 1, index + radius); current += 1) {
      expanded.add(current);
    }
  }
  return [...expanded].sort((left, right) => left - right);
}

function takeWithinBudget(blocks: BaijianLawContentBlock[], maxBytes: number, maxBlocks: number): BaijianLawContentBlock[] {
  const selected: BaijianLawContentBlock[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const blockBytes = Buffer.byteLength(JSON.stringify(block), 'utf8');
    if (selected.length >= maxBlocks || bytes + blockBytes > maxBytes) break;
    selected.push(block);
    bytes += blockBytes;
  }
  return selected;
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value!));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}
