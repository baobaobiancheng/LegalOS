import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { AiExecutionQueueService } from '../src/common/services/ai-execution-queue.service';
import { DshExecutionHandle, DshService } from '../src/common/services/dsh.service';
import { DshBaijianToolsService } from '../src/common/services/dsh-baijian-tools.service';
import {
  DshExecutionResult,
  DshResearchCapability,
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
  LAW_RESEARCH_RECALL_CALL_LIMIT,
} from '../src/common/services/dsh-agent.types';
import { BaijianMcpClientService } from '../src/common/baijian/baijian-mcp-client.service';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';
import { CachedLegalResearchGateway } from '../src/common/baijian/cached-legal-research.gateway';
import { LegalEvidenceRepository } from '../src/common/baijian/legal-evidence.repository';
import { PrismaService } from '../src/prisma/prisma.service';

export type GateFinal = {
  answer: string;
  sourceUses: Array<{ source: 'lawstar' | 'ldh'; recordId: string }>;
  evidenceQuotes?: Array<{ recordId: string; article: string; text: string }>;
};

async function main() {
  requireEnv('LLM_BASE_URL');
  requireEnv('BAIJIAN_MCP_APP_KEY');
  requireEnv('BAIJIAN_MCP_APP_SECRET');
  if (!process.env.LLM_API_KEY && !process.env.CODEX_API_KEY) {
    throw new Error('缺少 LLM_API_KEY 或 CODEX_API_KEY');
  }
  process.env.AI_EXECUTION_ENABLED = 'true';

  const mode = process.argv[2] ?? 'law';
  const capability: DshResearchCapability = mode === 'case' ? 'similar_case' : 'law_search';
  const question = process.argv.slice(3).join(' ').trim()
    || (mode === 'case' ? '劳动合同违法解除经济补偿的中国类似案例' : '劳动合同解除经济补偿');

  const config = new ConfigService(process.env);
  const normalizer = new BaijianResultNormalizer();
  const baijian = new BaijianMcpClientService(config, normalizer);
  const prisma = new PrismaService();
  await prisma.$connect();
  const cachedBaijian = new CachedLegalResearchGateway(config, baijian, new LegalEvidenceRepository(prisma));
  const dsh = new DshService(
    config,
    new AiExecutionQueueService(config),
    new DshBaijianToolsService(cachedBaijian),
  );
  const prompt = [
    '你正在执行 LegalOS dsh/百鉴只读技术闸门。',
    capability === 'law_search'
      ? '使用关键词、高级或语义搜索召回法规；命中后必须读取权威正文，优先一次调用 get_law_details 批量核验最多3部法规。evidenceQuotes 必须至少有一项，text 必须是 contentBlocks 返回的连续逐字原文，不得改写、省略或拼接。answer、sourceUses 和 evidenceQuotes 必须引用同一个已读取详情的32位法规ID。'
      : '必须调用 search_similar_cases，自主改写为不含个人信息的完整法律问题。',
    `本轮最多调用检索工具 ${dsh.getToolCallLimit()} 次；获得足以回答的有效结果后必须停止检索并输出最终答案。`,
    `用户问题：${question}`,
    capability === 'law_search'
      ? '最终只输出一行 JSON，格式为 {"answer":"...","sourceUses":[{"source":"lawstar","recordId":"32位真实ID"}],"evidenceQuotes":[{"recordId":"同一个32位真实ID","article":"第八十七条","text":"contentBlocks中的连续逐字原文"}]}。'
      : '最终只输出一行 JSON，格式为 {"answer":"...","sourceUses":[{"source":"ldh","recordId":"真实ID"}]}。',
    'sourceUses 只能引用本轮工具结果真实返回的 ID；命中时至少引用一条。',
  ].join('\n');

  try {
    const handle = await dsh.executeStream(prompt, {
      sessionId: `pr0-dsh-${mode}`,
      timeout: 180_000,
      researchCapability: capability,
      requireResearchTool: true,
    });
    const completion = await waitForCompletion(handle);
    assertNoToolErrors(completion);
    assertEfficientToolPlan(completion, capability);
    const final = parseFinal(completion.text);
    assertAuthoritativeSources(completion, final, capability);
    console.log(JSON.stringify({
      gate: 'dsh-baijian-agent',
      status: 'passed',
      capability,
      dshSessionId: completion.dshSessionId,
      toolCalls: completion.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
      toolResultCount: completion.toolResults.length,
      sourceUseCount: final.sourceUses.length,
      answerLength: final.answer.length,
    }, null, 2));
  } finally {
    await dsh.close();
    await prisma.$disconnect();
  }
}

function waitForCompletion(handle: DshExecutionHandle): Promise<DshExecutionResult> {
  return new Promise((resolve, reject) => {
    handle.once('done', resolve);
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('dsh Agent 已取消')));
  });
}

export function parseFinal(text: string): GateFinal {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('dsh Agent 最终输出为空');

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const candidates = extractJsonObjects(trimmed).flatMap((candidate) => {
      try {
        return [JSON.parse(candidate) as unknown];
      } catch {
        return [];
      }
    });
    if (!candidates.length) throw new Error('dsh Agent 最终输出不是合法 JSON');
    if (candidates.length > 1) throw new Error('dsh Agent 最终输出包含多个 JSON 结果');
    [value] = candidates;
  }
  if (!isRecord(value)
    || typeof value.answer !== 'string'
    || !value.answer.trim()
    || !Array.isArray(value.sourceUses)) {
    throw new Error('dsh Agent 最终输出结构无效');
  }
  const sourceUses: GateFinal['sourceUses'] = value.sourceUses.map((item) => {
    if (!isRecord(item)) {
      throw new Error('dsh Agent sourceUses 无效');
    }
    const source = item.source;
    const recordId = item.recordId;
    if ((source !== 'lawstar' && source !== 'ldh')
      || typeof recordId !== 'string'
      || !recordId) {
      throw new Error('dsh Agent sourceUses 无效');
    }
    return { source, recordId };
  });
  const evidenceQuotes = value.evidenceQuotes === undefined
    ? undefined
    : parseEvidenceQuotes(value.evidenceQuotes);
  return { answer: value.answer, sourceUses, ...(evidenceQuotes ? { evidenceQuotes } : {}) };
}

function parseEvidenceQuotes(value: unknown): NonNullable<GateFinal['evidenceQuotes']> {
  if (!Array.isArray(value)) throw new Error('dsh Agent evidenceQuotes 无效');
  return value.map((item) => {
    if (!isRecord(item)
      || typeof item.recordId !== 'string'
      || typeof item.article !== 'string'
      || typeof item.text !== 'string'
      || !item.recordId
      || !item.article
      || !item.text) throw new Error('dsh Agent evidenceQuotes 无效');
    return { recordId: item.recordId, article: item.article, text: item.text };
  });
}

/**
 * dsh 的 assistant/message 是普通文本通道，模型偶尔会给 JSON 加 markdown
 * 围栏或一句说明。这里按 JSON 字符串转义规则提取完整顶层对象；不使用贪婪正则，
 * 也不在多个候选中猜测，以免把两个互相矛盾的最终结果静默合并。
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      objects.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return objects;
}

export function assertAuthoritativeSources(
  completion: DshExecutionResult,
  final: GateFinal,
  capability: DshResearchCapability,
) {
  const authoritative = new Set<string>();
  for (const toolResult of completion.toolResults) {
    const records = toolResult.result && 'records' in toolResult.result ? toolResult.result.records : [];
    for (const record of records) {
      authoritative.add(`${record.source}:${record.recordId}`);
    }
  }
  if (authoritative.size && !final.sourceUses.length) throw new Error('命中结果未引用权威 ID');
  const expectedSource = capability === 'law_search' ? 'lawstar' : 'ldh';
  for (const sourceUse of final.sourceUses) {
    if (sourceUse.source !== expectedSource
      || !authoritative.has(`${sourceUse.source}:${sourceUse.recordId}`)) {
      throw new Error(`引用了本轮工具结果中不存在的 ID：${sourceUse.recordId}`);
    }
  }
}

export function assertNoToolErrors(completion: DshExecutionResult): void {
  const failed = completion.toolResults.filter((result) => result.isError);
  if (!failed.length) return;
  const labels = failed.map((result) => `${result.name}:${result.error?.code ?? 'TOOL_EXECUTION_FAILED'}`);
  throw new Error(`dsh Agent 存在 ${failed.length} 次失败工具调用：${labels.join('、')}`);
}

export function assertEfficientToolPlan(
  completion: DshExecutionResult,
  capability: DshResearchCapability,
): void {
  if (capability !== 'law_search') return;
  const recallTools = new Set<string>([
    DSH_LAW_SEARCH_TOOL,
    DSH_LAW_ADVANCED_SEARCH_TOOL,
    DSH_LAW_SEMANTIC_SEARCH_TOOL,
  ]);
  const detailTools = new Set<string>([DSH_LAW_BATCH_DETAIL_TOOL, DSH_LAW_DETAIL_TOOL]);
  const recallCalls = completion.toolCalls.filter((call) => recallTools.has(call.name));
  const detailCalls = completion.toolCalls.filter((call) => detailTools.has(call.name));
  if (recallCalls.length > LAW_RESEARCH_RECALL_CALL_LIMIT || detailCalls.length > 1) {
    throw new Error(`dsh Agent 工具规划存在重复调用：召回 ${recallCalls.length} 次，详情 ${detailCalls.length} 次`);
  }
}

function requireEnv(name: string) {
  if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      code: 'DSH_BAIJIAN_GATE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
