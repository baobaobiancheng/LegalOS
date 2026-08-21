import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { AiExecutionQueueService } from '../src/common/services/ai-execution-queue.service';
import { DshExecutionHandle, DshService } from '../src/common/services/dsh.service';
import { DshBaijianToolsService } from '../src/common/services/dsh-baijian-tools.service';
import { DshExecutionResult, DshResearchCapability } from '../src/common/services/dsh-agent.types';
import { BaijianMcpClientService } from '../src/common/baijian/baijian-mcp-client.service';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';

export type GateFinal = {
  answer: string;
  sourceUses: Array<{ source: 'lawstar' | 'ldh'; recordId: string }>;
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
  const dsh = new DshService(
    config,
    new AiExecutionQueueService(config),
    new DshBaijianToolsService(baijian),
  );
  const prompt = [
    '你正在执行 LegalOS dsh/百鉴只读技术闸门。',
    capability === 'law_search'
      ? '必须调用 search_laws，自主提炼简短法规关键词。结果只是元数据，不得生成或引用具体条文。'
      : '必须调用 search_similar_cases，自主改写为不含个人信息的完整法律问题。',
    `本轮最多调用检索工具 ${dsh.getToolCallLimit()} 次；获得足以回答的有效结果后必须停止检索并输出最终答案。`,
    `用户问题：${question}`,
    '最终只输出一行 JSON，格式为 {"answer":"...","sourceUses":[{"source":"lawstar|ldh","recordId":"..."}]}。',
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
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error('dsh Agent 最终输出不是合法 JSON');
  }
  if (!isRecord(value) || typeof value.answer !== 'string' || !Array.isArray(value.sourceUses)) {
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
  return { answer: value.answer, sourceUses };
}

export function assertAuthoritativeSources(
  completion: DshExecutionResult,
  final: GateFinal,
  capability: DshResearchCapability,
) {
  const authoritative = new Set<string>();
  for (const toolResult of completion.toolResults) {
    for (const record of toolResult.result?.records ?? []) {
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
