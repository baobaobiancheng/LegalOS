import { BaijianNormalizedResult } from '../baijian/baijian.types';

export const DSH_LAW_SEARCH_TOOL = 'search_laws' as const;
export const DSH_CASE_SEARCH_TOOL = 'search_similar_cases' as const;

export type DshResearchCapability = 'law_search' | 'similar_case';
export type DshResearchToolName = typeof DSH_LAW_SEARCH_TOOL | typeof DSH_CASE_SEARCH_TOOL;

export interface DshToolCallEvent {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface DshToolResultEvent {
  callId: string;
  name: string;
  isError: boolean;
  result?: BaijianNormalizedResult;
  error?: { name: string; code: string };
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
  /** 为本次 Agent 仅暴露一个已选法律检索能力。 */
  researchCapability?: DshResearchCapability;
  /** 已选检索能力未产生成功工具结果时 fail-closed。 */
  requireResearchTool?: boolean;
}

export function toolNameForCapability(capability: DshResearchCapability): DshResearchToolName {
  return capability === 'law_search' ? DSH_LAW_SEARCH_TOOL : DSH_CASE_SEARCH_TOOL;
}
