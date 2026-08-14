import { ChildProcess } from 'child_process';

export interface AgentOutputLimits {
  stdoutBytes: number;
  stderrBytes: number;
  jsonlLineBytes: number;
  eventCount: number;
  toolResultCount: number;
  resultFileBytes: number;
}

export type AgentExecutionEvent = {
  id?: string;
  type: string;
  raw: Record<string, unknown>;
};

export interface AgentToolResult {
  eventId?: string;
  toolName: string;
  callId?: string;
  result: unknown;
  isError: boolean;
}

export interface AgentCompletion<T = unknown> {
  exitCode: number;
  final: T;
  events: AgentExecutionEvent[];
  toolResults: AgentToolResult[];
  stderrSummary: string;
  truncated: {
    stderr: boolean;
  };
}

export interface AgentExecutionHandle<T = unknown> {
  executionId: string;
  process: ChildProcess;
  events: AsyncIterable<AgentExecutionEvent>;
  completion: Promise<AgentCompletion<T>>;
  cancel: () => void;
}

export interface AgentMcpOptions {
  serverName: 'baijian';
  url: string;
  enabledTool: string;
  required?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  envHttpHeaders: Record<string, string>;
  environment: Record<string, string>;
}

export interface CodexAgentOptions<T = unknown> {
  model?: string;
  timeout?: number;
  sessionId?: string;
  queueTimeoutMs?: number;
  signal?: AbortSignal;
  outputSchema: Record<string, unknown>;
  validateFinal?: (value: unknown) => T;
  mcp: AgentMcpOptions;
  limits?: Partial<AgentOutputLimits>;
}

export class AgentExecutionError extends Error {
  constructor(
    public readonly code:
      | 'AGENT_CANCELLED'
      | 'AGENT_TIMEOUT'
      | 'AGENT_PROCESS_FAILED'
      | 'AGENT_BAD_JSONL'
      | 'AGENT_OUTPUT_LIMIT'
      | 'AGENT_RESULT_MISSING'
      | 'AGENT_RESULT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export const DEFAULT_AGENT_OUTPUT_LIMITS: AgentOutputLimits = {
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  jsonlLineBytes: 512 * 1024,
  eventCount: 2_000,
  toolResultCount: 50,
  resultFileBytes: 1024 * 1024,
};
