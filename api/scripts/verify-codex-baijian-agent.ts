import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { CodexExecutionQueueService } from '../src/common/services/codex-execution-queue.service';
import { CodexService } from '../src/common/services/codex.service';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';
import {
  BAIJIAN_CASE_SEARCH_TOOL,
  BAIJIAN_LAW_SEARCH_TOOL,
  BaijianRawToolResult,
  BaijianToolName,
} from '../src/common/baijian/baijian.types';
import { validateManagedRequirementsFile } from './preflight-codex-baijian';

export type GateFinal = {
  answer: string;
  sourceUses: Array<{ source: 'lawstar' | 'ldh'; recordId: string }>;
};

export const CODEX_SYSTEM_REQUIREMENTS_PATH = '/etc/codex/requirements.toml';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'sourceUses'],
  properties: {
    answer: { type: 'string', minLength: 1, maxLength: 20_000 },
    sourceUses: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'recordId'],
        properties: {
          source: { type: 'string', enum: ['lawstar', 'ldh'] },
          recordId: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  },
};

async function main() {
  requireEnv('CODEX_API_KEY');
  requireEnv('BAIJIAN_MCP_APP_KEY');
  requireEnv('BAIJIAN_MCP_APP_SECRET');
  process.env.CODEX_HARDENED = 'true';
  process.env.AI_EXECUTION_ENABLED = 'true';

  // This is the real Agent gate, so it must validate the exact system file
  // Codex loads. CODEX_MANAGED_REQUIREMENTS_PATH remains preflight/test-only.
  const requirements = validateManagedRequirementsFile(CODEX_SYSTEM_REQUIREMENTS_PATH);
  if (requirements.failures.length) throw new Error(requirements.failures.join('；'));

  const mode = process.argv[2] ?? 'law';
  const agentModel = optionalEnv('CODEX_AGENT_MODEL');
  const question = process.argv.slice(3).join(' ').trim()
    || (mode === 'case' ? '劳动合同违法解除经济补偿的中国类似案例' : '劳动合同解除经济补偿');
  const enabledTool = mode === 'case' ? BAIJIAN_CASE_SEARCH_TOOL : BAIJIAN_LAW_SEARCH_TOOL;
  const config = new ConfigService(process.env);
  const service = new CodexService(config, new CodexExecutionQueueService(config));
  const prompt = [
    '你正在执行 LegalOS PR0 只读技术闸门。',
    `必须至少调用一次 ${enabledTool}，不得声称调用任何其他工具。`,
    mode === 'case'
      ? '把问题抽象成不含个人信息的完整法律问题，namespace 固定为 case_law，top_k 不超过 5。'
      : '自主生成简短法规关键词，page 从 1 开始，rows 不超过 5。法规结果只有元数据，不得生成或引用具体条文。',
    `用户问题：${question}`,
    '最终严格按 schema 输出 JSON。sourceUses 只能引用本次工具结果真实返回的法规 lawId 或案例 source_id。',
  ].join('\n');

  const handle = await service.executeAgent<GateFinal>(prompt, {
    sessionId: `pr0-gate-${mode}`,
    model: agentModel,
    timeout: 180_000,
    outputSchema: OUTPUT_SCHEMA,
    validateFinal: validateFinal,
    mcp: {
      serverName: 'baijian',
      url: process.env.BAIJIAN_MCP_URL ?? 'https://mcpgateway.100credit.cn/mcp',
      enabledTool,
      required: true,
      startupTimeoutSec: 15,
      toolTimeoutSec: 60,
      envHttpHeaders: {
        'X-App-Key': 'BAIJIAN_MCP_APP_KEY',
        'X-App-Secret': 'BAIJIAN_MCP_APP_SECRET',
      },
      environment: {
        BAIJIAN_MCP_APP_KEY: process.env.BAIJIAN_MCP_APP_KEY!,
        BAIJIAN_MCP_APP_SECRET: process.env.BAIJIAN_MCP_APP_SECRET!,
      },
    },
  });
  const completion = await handle.completion;
  const observedTools = [...new Set(completion.toolResults.map((result) => result.toolName))];
  if (!observedTools.includes(enabledTool)) {
    console.error(JSON.stringify({
      gate: 'codex-baijian-agent-diagnostic',
      eventTypes: [...new Set(completion.events.map((event) => event.type))],
      itemSummaries: summarizeItems(completion.events),
      stderrSummary: completion.stderrSummary,
    }, null, 2));
    throw new Error(`未观察到必需工具结果：${enabledTool}`);
  }
  if (observedTools.some((tool) => tool !== enabledTool)) {
    throw new Error(`观察到白名单外工具：${observedTools.join(', ')}`);
  }
  try {
    assertAuthoritativeSources(completion.toolResults, completion.final, enabledTool);
  } catch (error) {
    console.error(JSON.stringify({
      gate: 'codex-baijian-agent-result-diagnostic',
      error: summarizeError(error),
      toolResults: completion.toolResults.map((result) => ({
        toolName: result.toolName,
        isError: result.isError,
        resultShape: describeShape(result.result),
      })),
    }, null, 2));
    throw error;
  }
  console.log(JSON.stringify({
    gate: 'codex-baijian-agent',
    status: 'passed',
    executionId: handle.executionId,
    model: agentModel ?? 'managed-default',
    enabledTool,
    observedTools,
    eventTypes: [...new Set(completion.events.map((event) => event.type))],
    toolResultCount: completion.toolResults.length,
    sourceUseCount: completion.final.sourceUses.length,
    answerLength: completion.final.answer.length,
  }, null, 2));
}

export function assertAuthoritativeSources(
  toolResults: Array<{ toolName: string; result: unknown; isError: boolean }>,
  final: GateFinal,
  enabledTool: BaijianToolName,
): void {
  const normalizer = new BaijianResultNormalizer();
  const authoritative = new Set<string>();
  for (const toolResult of toolResults.filter((item) => item.toolName === enabledTool)) {
    const normalized = normalizer.normalize(toRawToolResult(toolResult, enabledTool));
    for (const record of normalized.records) {
      authoritative.add(`${record.source}:${record.recordId}`);
    }
  }

  if (authoritative.size > 0 && final.sourceUses.length === 0) {
    throw new Error('工具已返回命中结果，但最终答案未引用任何权威记录 ID');
  }

  const expectedSource = enabledTool === BAIJIAN_LAW_SEARCH_TOOL ? 'lawstar' : 'ldh';
  for (const sourceUse of final.sourceUses) {
    if (sourceUse.source !== expectedSource) {
      throw new Error(`最终答案引用了错误来源类型：${sourceUse.source}`);
    }
    if (!authoritative.has(`${sourceUse.source}:${sourceUse.recordId}`)) {
      throw new Error(`最终答案引用了本次工具结果中不存在的 ID：${sourceUse.recordId}`);
    }
  }
}

function toRawToolResult(
  toolResult: { result: unknown; isError: boolean },
  toolName: BaijianToolName,
): BaijianRawToolResult {
  if (!isRecord(toolResult.result)) {
    return { toolName, content: toolResult.result, isError: toolResult.isError };
  }
  const isError = toolResult.isError || Boolean(toolResult.result.isError ?? toolResult.result.error);
  return {
    toolName,
    content: toolResult.result.content
      ?? (isError ? JSON.stringify(toolResult.result.error ?? toolResult.result) : undefined),
    structuredContent: toolResult.result.structuredContent
      ?? toolResult.result.structured_content,
    isError,
  };
}

export function validateFinal(value: unknown): GateFinal {
  if (!value || typeof value !== 'object') throw new Error('final 必须是对象');
  const final = value as Partial<GateFinal>;
  if (typeof final.answer !== 'string' || !final.answer.trim()) throw new Error('answer 缺失');
  if (!Array.isArray(final.sourceUses)) throw new Error('sourceUses 缺失');
  for (const source of final.sourceUses) {
    if (!source || !['lawstar', 'ldh'].includes(source.source) || !source.recordId) {
      throw new Error('sourceUses 无效');
    }
  }
  return { answer: final.answer, sourceUses: final.sourceUses };
}

function summarizeItems(events: Array<{ raw: Record<string, unknown> }>): Array<Record<string, unknown>> {
  return events.slice(0, 50).map(({ raw }) => {
    const item = isRecord(raw.item) ? raw.item : undefined;
    return {
      eventType: typeof raw.type === 'string' ? raw.type : 'unknown',
      itemType: item && typeof item.type === 'string' ? item.type : undefined,
      server: item && typeof item.server === 'string' ? item.server : undefined,
      tool: item && typeof item.tool === 'string' ? item.tool : undefined,
      hasResult: Boolean(item && Object.prototype.hasOwnProperty.call(item, 'result')),
      hasError: Boolean(item && Object.prototype.hasOwnProperty.call(item, 'error')),
      error: item?.type === 'error' ? summarizeErrorItem(item) : undefined,
    };
  });
}

function summarizeErrorItem(item: Record<string, unknown>): Record<string, unknown> {
  const message = typeof item.message === 'string'
    ? item.message
    : isRecord(item.error) && typeof item.error.message === 'string'
      ? item.error.message
      : undefined;
  const code = typeof item.code === 'string' || typeof item.code === 'number'
    ? item.code
    : isRecord(item.error) && (typeof item.error.code === 'string' || typeof item.error.code === 'number')
      ? item.error.code
      : undefined;
  return {
    code,
    message: message ? redactDiagnosticText(message) : undefined,
    shape: describeShape(item),
  };
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
      ? error.code
      : undefined;
    return { code, message: redactDiagnosticText(error.message) };
  }
  return { message: redactDiagnosticText(String(error)) };
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/(authorization|app[-_ ]?key|app[-_ ]?secret|api[-_ ]?key|token)(\s*[:=]\s*)\S+/gi, '$1$2<redacted>')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '<redacted-long-value>')
    .slice(0, 500);
}

function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      item: value.length && depth < 3 ? describeShape(value[0], depth + 1) : undefined,
    };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).slice(0, 30);
    return {
      type: 'object',
      keys,
      fields: depth < 3
        ? Object.fromEntries(keys.map((key) => [key, describeShape(value[key], depth + 1)]))
        : undefined,
    };
  }
  return typeof value;
}

function requireEnv(name: string): void {
  if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error(`${name} 格式无效`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ code: (error as any).code ?? 'GATE_FAILED', message: (error as Error).message }));
    process.exitCode = 1;
  });
}
