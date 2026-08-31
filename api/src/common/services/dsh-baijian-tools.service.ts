import { Injectable } from '@nestjs/common';
import { CachedLegalResearchGateway } from '../baijian/cached-legal-research.gateway';
import {
  BaijianLawContentBlock,
  BaijianLawDetail,
  BaijianLawRecord,
  BaijianLawSearchResult,
} from '../baijian/baijian.types';
import {
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
  DSH_CASE_SEARCH_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DshResearchCapability,
  LAW_RESEARCH_COMPLEX_DETAIL_LIMIT,
  LAW_RESEARCH_DEFAULT_DETAIL_LIMIT,
  LAW_RESEARCH_RECALL_CALL_LIMIT,
} from './dsh-agent.types';

export const DSH_BAIJIAN_RESULT_META_KIND = 'baijian-result-v1';

/**
 * 将现有百鉴 SDK + normalizer 适配为 dsh 原生工具。
 * 该层不处理 Agent 会话或 prompt，也不暴露百鉴凭证。
 */
@Injectable()
export class DshBaijianToolsService {
  constructor(private readonly baijian: CachedLegalResearchGateway) {}

  async createDefinition(
    capability: DshResearchCapability,
    options: { lawDetailLimit?: number } = {},
  ): Promise<any> {
    return (await this.createDefinitions(capability, options))[0];
  }

  async createDefinitions(
    capability: DshResearchCapability,
    options: { lawDetailLimit?: number } = {},
  ): Promise<any[]> {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const baijian = this.baijian;
    if (capability === 'law_search') {
      const detailLimit = normalizeLawDetailLimit(options.lawDetailLimit);
      const supplierRequestLimit = LAW_RESEARCH_RECALL_CALL_LIMIT + detailLimit;
      const candidates = new Map<string, BaijianLawRecord>();
      const detailCache = new Map<string, BaijianLawDetail>();
      const attemptedDetailIds = new Set<string>();
      let recallCalls = 0;
      let singleDetailCalls = 0;
      let supplierRequests = 0;
      const reserveSupplierRequests = (count: number) => {
        if (supplierRequests + count > supplierRequestLimit) return false;
        supplierRequests += count;
        return true;
      };
      const runRecall = async (loader: () => Promise<BaijianLawSearchResult>): Promise<any> => {
        if (recallCalls >= LAW_RESEARCH_RECALL_CALL_LIMIT) {
          throw new Error(`法规召回最多允许 ${LAW_RESEARCH_RECALL_CALL_LIMIT} 次`);
        }
        if (!reserveSupplierRequests(1)) {
          throw new Error(`本轮百鉴请求最多允许 ${supplierRequestLimit} 次`);
        }
        recallCalls += 1;
        const result = await loader();
        rememberCandidates(result.records, candidates);
        return result;
      };
      return [defineTool({
        name: DSH_LAW_SEARCH_TOOL,
        description: '用简短关键词召回中国法规候选；适合法规名、主题或文号。本轮各类召回合计最多2次。仅返回元数据，命中后优先用 get_law_details 批量核验正文。',
        parameters: {
          keyword: { type: 'string', required: true, description: '法规关键词，不要包含姓名、手机号等个人信息。' },
          page: { type: 'integer', description: '页码，默认 1。' },
          rows: { type: 'integer', description: '返回数量，默认 10，最多 10。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          return runRecall(() => baijian.searchLaws({
            keyword: args.keyword,
            page: clamp(args.page, 1, 10, 1),
            rows: clamp(args.rows, 1, 10, 10),
          }, exec.signal));
        },
      }), defineTool({
        name: DSH_LAW_ADVANCED_SEARCH_TOOL,
        description: '按关键词、发文机关和时效性组合精准检索法规；适合用户明确要求现行有效或特定机关的任务。本轮各类召回合计最多2次，命中后优先批量读取详情。',
        parameters: {
          keyword: { type: 'string', required: true, description: '1–200 字法规关键词组合。' },
          issuingOrgan: { type: 'string', description: '可选发文机关，例如国务院。' },
          timeliness: { type: 'string', enum: ['0', '1', '2', '3', '4'], description: '0尚未实施、1现行有效、2已失效、3已修改、4草案。' },
          page: { type: 'integer', description: '页码，默认1。' },
          rows: { type: 'integer', description: '返回数量，默认10，最多10。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          return runRecall(() => baijian.searchLawsAdvanced({
            keyword: args.keyword,
            issuingOrgan: args.issuingOrgan,
            timeliness: args.timeliness,
            page: clamp(args.page, 1, 10, 1),
            rows: clamp(args.rows, 1, 10, 10),
          }, exec.signal));
        },
      }), defineTool({
        name: DSH_LAW_SEMANTIC_SEARCH_TOOL,
        description: '用去识别化的自然语言法律问题做法规语义召回；适合法律问题和事实型输入。本轮各类召回合计最多2次。结果含匹配片段但不是完整正文，命中后优先批量读取详情。',
        parameters: {
          query: { type: 'string', required: true, description: '不含姓名、电话等个人信息的完整法律问题。' },
          keyword: { type: 'string', description: '可选法规标题关键词。' },
          issuingOrgan: { type: 'string', description: '可选发文机关。' },
          timeliness: { type: 'string', enum: ['0', '1', '2', '4'], description: '0尚未实施、1现行有效、2已失效、4已修改。' },
          rows: { type: 'integer', description: '返回数量，默认10，最多10。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          return runRecall(() => baijian.searchLawsSemantic({
            query: args.query,
            keyword: args.keyword,
            issuingOrgan: args.issuingOrgan,
            timeliness: args.timeliness,
            rows: clamp(args.rows, 1, 10, 10),
          }, exec.signal));
        },
      }), defineTool({
        name: DSH_LAW_BATCH_DETAIL_TOOL,
        description: `一次批量读取最相关候选法规的权威正文。本轮最多核验${detailLimit}部。lawIds 必须来自本轮搜索结果；传入数量不足时服务端会从已召回候选中优先补齐高位阶、现行有效规范。`,
        parameters: {
          lawIds: { type: 'array', required: true, items: { type: 'string' }, description: `搜索结果返回的法规ID数组，服务端按本轮${detailLimit}部预算去重并补齐。` },
          query: { type: 'string', required: true, description: '需要在各部法规正文中定位的法律问题或制度关键词。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 90_000,
        async execute(args, exec) {
          const requestedLawIds = [...new Set((Array.isArray(args.lawIds) ? args.lawIds : [])
            .map((value: unknown) => String(value ?? '').trim())
            .filter(Boolean)
            .map((lawId) => lawId.toLowerCase()))];
          if (!requestedLawIds.length) throw new Error('批量法规详情至少需要一个候选法规ID');
          const unknown = requestedLawIds.find((lawId) => !candidates.has(lawId));
          if (unknown) throw new Error(`法规详情 ID 必须来自本轮搜索结果：${unknown}`);
          const sharedQuery = boundedText(args.query, 300);
          if (!sharedQuery) throw new Error('批量法规详情必须提供 query 以定位目标正文');

          const cachedRequestedIds = requestedLawIds.filter((lawId) => detailCache.has(lawId));
          const remainingDetailBudget = Math.max(0, detailLimit - attemptedDetailIds.size);
          const requestedUnreadIds = requestedLawIds.filter((lawId) => !attemptedDetailIds.has(lawId));
          if (attemptedDetailIds.size > 0 && requestedUnreadIds.length > remainingDetailBudget) {
            throw new Error(`本轮最多核验 ${detailLimit} 部候选法规`);
          }
          const rankedCandidateIds = rankLawCandidates([...candidates.values()])
            .map((record) => record.recordId.toLowerCase())
            .filter((lawId) => !requestedLawIds.includes(lawId) && !attemptedDetailIds.has(lawId));
          const targetUnreadIds = [...requestedUnreadIds, ...rankedCandidateIds]
            .slice(0, remainingDetailBudget);
          const addedLawIds = targetUnreadIds.filter((lawId) => !requestedLawIds.includes(lawId));
          const skippedLawIds = requestedUnreadIds.filter((lawId) => !targetUnreadIds.includes(lawId));

          if (targetUnreadIds.length && !reserveSupplierRequests(targetUnreadIds.length)) {
            skippedLawIds.push(...targetUnreadIds);
            targetUnreadIds.length = 0;
          }
          for (const lawId of targetUnreadIds) attemptedDetailIds.add(lawId);
          const settled = await mapWithConcurrency(targetUnreadIds, 3, async (lawId) => {
            try {
              const candidate = candidates.get(lawId)!;
              const detail = await baijian.getLawDetail({ lawId }, exec.signal);
              const projected = projectLawDetail(detail, {
                articleHint: candidate.articleNumber || undefined,
                query: candidate.matchedContent || sharedQuery,
              }, { maxBytes: 14 * 1024, maxBlocks: 24, maxRankedBlocks: 4, radius: 1 });
              detailCache.set(lawId, projected);
              return {
                lawId,
                detail: projected,
              };
            } catch (error) {
              return { lawId, error };
            }
          });
          if (exec.signal.aborted) {
            throw exec.signal.reason instanceof Error
              ? exec.signal.reason
              : new Error('批量法规详情读取已取消');
          }
          const details = [
            ...cachedRequestedIds.flatMap((lawId) => detailCache.get(lawId) ? [detailCache.get(lawId)!] : []),
            ...settled.flatMap((item) => item.detail ? [item.detail] : []),
          ];
          const failedLawIds = settled.flatMap((item) => item.error ? [item.lawId] : []);
          if (!details.length) {
            throw new Error(`批量法规详情读取失败，${failedLawIds.length} 部候选法规均未成功读取正文`);
          }
          return {
            toolName: DSH_LAW_BATCH_DETAIL_TOOL,
            details,
            ...(failedLawIds.length ? { failedLawIds } : {}),
            ...detailOrchestration({
              detailLimit,
              reusedLawIds: cachedRequestedIds,
              addedLawIds,
              skippedLawIds,
              supplierBounded: targetUnreadIds.length === 0 && skippedLawIds.length > 0
                && attemptedDetailIds.size < detailLimit,
            }),
          } as any;
        },
      }), defineTool({
        name: DSH_LAW_DETAIL_TOOL,
        description: `仅用于定位单一法规或条文。lawId 必须来自本轮搜索结果，并受本轮${detailLimit}部法规详情总预算限制；重复读取直接复用已核验正文。`,
        parameters: {
          lawId: { type: 'string', required: true, description: '搜索结果返回的32位法规ID。' },
          articleHint: { type: 'string', description: '目标条号，优先传入语义搜索结果的 articleNumber。' },
          query: { type: 'string', description: '需要在正文中定位的法律问题或制度关键词。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          const lawId = String(args.lawId ?? '').trim().toLowerCase();
          const candidate = candidates.get(lawId);
          if (!candidate) {
            throw new Error('法规详情 ID 必须来自本轮搜索结果');
          }
          const articleHint = boundedText(args.articleHint, 40) || candidate.articleNumber || undefined;
          const query = boundedText(args.query, 200) || candidate.matchedContent || undefined;
          if (!articleHint && !query) {
            throw new Error('法规详情必须提供 articleHint 或 query 以定位目标正文');
          }
          const cached = detailCache.get(lawId);
          if (cached) {
            return {
              ...cached,
              orchestration: {
                action: 'reused', reason: 'detail_repeat', limit: detailLimit, reusedLawIds: [lawId],
              },
            } as any;
          }
          if (singleDetailCalls >= 1) {
            throw new Error('单条法规详情本轮最多允许 1 次，请使用 get_law_details 批量核验');
          }
          if (attemptedDetailIds.size >= detailLimit || !reserveSupplierRequests(1)) {
            throw new Error(`本轮最多核验 ${detailLimit} 部候选法规`);
          }
          singleDetailCalls += 1;
          attemptedDetailIds.add(lawId);
          const detail = await baijian.getLawDetail({ lawId }, exec.signal);
          const projected = projectLawDetail(detail, { articleHint, query });
          detailCache.set(lawId, projected);
          return projected as any;
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
  records: BaijianLawRecord[],
  candidates: Map<string, BaijianLawRecord>,
) {
  for (const record of records) {
    candidates.set(record.recordId.toLowerCase(), record);
  }
}

function normalizeLawDetailLimit(value: number | undefined): number {
  return value !== undefined && value >= LAW_RESEARCH_COMPLEX_DETAIL_LIMIT
    ? LAW_RESEARCH_COMPLEX_DETAIL_LIMIT
    : LAW_RESEARCH_DEFAULT_DETAIL_LIMIT;
}

function rankLawCandidates(records: BaijianLawRecord[]): BaijianLawRecord[] {
  return records
    .map((record, index) => ({ record, index, score: authorityScore(record) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ record }) => record);
}

function authorityScore(record: BaijianLawRecord): number {
  const name = String(record.lawName ?? '');
  const organ = String(record.issuingOrgan ?? '');
  const timeliness = String(record.timeliness ?? '');
  let score = Number(record.score ?? 0) * 10;
  if (name.includes('中华人民共和国')) score += 50;
  if (/(全国人民代表大会|全国人大)/u.test(organ)) score += 45;
  else if (/(最高人民法院|最高人民检察院)/u.test(organ)) score += 40;
  else if (organ.includes('国务院')) score += 35;
  else if (/(省|自治区|直辖市).*(人大|常务委员会)/u.test(organ)) score += 18;
  else if (/(部|委员会|总局)$/u.test(organ)) score += 12;
  if (/(现行|有效)/u.test(timeliness)) score += 20;
  if (/(失效|废止)/u.test(timeliness)) score -= 100;
  if (/(典型案例|参考案例|指导性案例)/u.test(name)) score -= 80;
  if (/(办案指南|操作指引|会议纪要)/u.test(name)) score -= 45;
  return score;
}

function detailOrchestration(input: {
  detailLimit: number;
  reusedLawIds: string[];
  addedLawIds: string[];
  skippedLawIds: string[];
  supplierBounded: boolean;
}): { orchestration?: {
  action: 'reused' | 'bounded' | 'expanded';
  reason: 'detail_repeat' | 'detail_default' | 'detail_limit' | 'supplier_budget';
  limit: number;
  reusedLawIds?: string[];
  addedLawIds?: string[];
  skippedLawIds?: string[];
} } {
  if (input.skippedLawIds.length) {
    return { orchestration: {
      action: 'bounded',
      reason: input.supplierBounded ? 'supplier_budget' : 'detail_limit',
      limit: input.detailLimit,
      skippedLawIds: input.skippedLawIds,
      ...(input.reusedLawIds.length ? { reusedLawIds: input.reusedLawIds } : {}),
    } };
  }
  if (input.addedLawIds.length) {
    return { orchestration: {
      action: 'expanded',
      reason: 'detail_default',
      limit: input.detailLimit,
      addedLawIds: input.addedLawIds,
      ...(input.reusedLawIds.length ? { reusedLawIds: input.reusedLawIds } : {}),
    } };
  }
  if (input.reusedLawIds.length) {
    return { orchestration: {
      action: 'reused',
      reason: 'detail_repeat',
      limit: input.detailLimit,
      reusedLawIds: input.reusedLawIds,
    } };
  }
  return {};
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
