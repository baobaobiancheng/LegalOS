import { BaijianLawDetail, BaijianNormalizedToolResult } from '../baijian/baijian.types';

export const DSH_LAW_SEARCH_TOOL = 'search_laws' as const;
export const DSH_LAW_ADVANCED_SEARCH_TOOL = 'search_laws_advanced' as const;
export const DSH_LAW_SEMANTIC_SEARCH_TOOL = 'search_laws_semantic' as const;
export const DSH_LAW_DETAIL_TOOL = 'get_law_detail' as const;
export const DSH_LAW_BATCH_DETAIL_TOOL = 'get_law_details' as const;
export const DSH_CASE_SEARCH_TOOL = 'search_similar_cases' as const;

export const LAW_RESEARCH_RECALL_CALL_LIMIT = 2;
export const LAW_RESEARCH_DEFAULT_DETAIL_LIMIT = 3;
export const LAW_RESEARCH_COMPLEX_DETAIL_LIMIT = 3;

export interface DshLawResearchOrchestration {
  action: 'reused' | 'bounded' | 'expanded';
  reason: 'recall_limit' | 'detail_repeat' | 'detail_default' | 'detail_limit' | 'supplier_budget';
  limit: number;
  reusedLawIds?: string[];
  addedLawIds?: string[];
  skippedLawIds?: string[];
}

export type DshResearchCapability = 'law_search' | 'similar_case';
export type DshResearchToolName = typeof DSH_LAW_SEARCH_TOOL
  | typeof DSH_LAW_ADVANCED_SEARCH_TOOL
  | typeof DSH_LAW_SEMANTIC_SEARCH_TOOL
  | typeof DSH_LAW_DETAIL_TOOL
  | typeof DSH_LAW_BATCH_DETAIL_TOOL
  | typeof DSH_CASE_SEARCH_TOOL;

export interface DshLawBatchDetailResult {
  toolName: typeof DSH_LAW_BATCH_DETAIL_TOOL;
  details: BaijianLawDetail[];
  /** 批量读取的局部失败；成功详情仍可用于证据闸门。 */
  failedLawIds?: string[];
  orchestration?: DshLawResearchOrchestration;
}

export type DshToolResultValue = (BaijianNormalizedToolResult & {
  orchestration?: DshLawResearchOrchestration;
}) | DshLawBatchDetailResult;

export interface DshToolCallEvent {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface DshToolResultEvent {
  callId: string;
  name: string;
  isError: boolean;
  result?: DshToolResultValue;
  error?: { name: string; code: string; message?: string };
}

export interface DshExecutionResult {
  text: string;
  dshSessionId: string;
  toolCalls: DshToolCallEvent[];
  toolResults: DshToolResultEvent[];
}

export interface DshOptions {
  model?: string;
  /** 单轮任务的整体超时（毫秒）。 */
  timeout?: number;
  /** 队列与业务互斥键；不直接作为 dsh 持久会话 ID。 */
  sessionId?: string;
  queueTimeoutMs?: number;
  signal?: AbortSignal;
  /** 恢复同一项目、同一能力最近一次成功的 dsh 会话。 */
  resumeDshSessionId?: string;
  /** 为本次 Agent 仅暴露一个已选法律检索能力。 */
  researchCapability?: DshResearchCapability;
  /** 已选检索能力未产生成功工具结果时 fail-closed。 */
  requireResearchTool?: boolean;
  /** 法规详情读取预算：单轮最多 3 部。 */
  lawDetailLimit?: number;
}

export function toolNameForCapability(capability: DshResearchCapability): DshResearchToolName {
  return capability === 'law_search' ? DSH_LAW_SEARCH_TOOL : DSH_CASE_SEARCH_TOOL;
}

export function toolNamesForCapability(capability: DshResearchCapability): DshResearchToolName[] {
  return capability === 'law_search'
    ? [
        DSH_LAW_SEARCH_TOOL,
        DSH_LAW_ADVANCED_SEARCH_TOOL,
        DSH_LAW_SEMANTIC_SEARCH_TOOL,
        DSH_LAW_DETAIL_TOOL,
        DSH_LAW_BATCH_DETAIL_TOOL,
      ]
    : [DSH_CASE_SEARCH_TOOL];
}
