import { StringDecoder } from 'string_decoder';
import {
  AgentExecutionError,
  AgentExecutionEvent,
  AgentOutputLimits,
  AgentToolResult,
} from './codex-agent.types';

type EventListener = (event: AgentExecutionEvent) => void;

export class CodexAgentJsonlParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly seenEventKeys = new Set<string>();
  private buffer = '';
  private stdoutBytes = 0;
  private closed = false;

  readonly events: AgentExecutionEvent[] = [];
  readonly toolResults: AgentToolResult[] = [];

  constructor(
    private readonly limits: AgentOutputLimits,
    private readonly onEvent: EventListener,
  ) {}

  push(chunk: Buffer): void {
    if (this.closed) return;
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > this.limits.stdoutBytes) {
      throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex JSONL 累计输出超过上限');
    }

    this.buffer += this.decoder.write(chunk);
    this.drainLines(false);
    if (Buffer.byteLength(this.buffer, 'utf8') > this.limits.jsonlLineBytes) {
      throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex JSONL 单行超过上限');
    }
  }

  finish(): void {
    if (this.closed) return;
    this.buffer += this.decoder.end();
    this.drainLines(true);
    this.closed = true;
  }

  private drainLines(flush: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
    }
    if (flush && this.buffer.trim()) {
      this.parseLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
  }

  private parseLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, 'utf8') > this.limits.jsonlLineBytes) {
      throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex JSONL 单行超过上限');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new AgentExecutionError('AGENT_BAD_JSONL', 'Codex 返回了无法解析的 JSONL 行');
    }
    if (!isRecord(raw)) {
      throw new AgentExecutionError('AGENT_BAD_JSONL', 'Codex JSONL 事件不是对象');
    }

    const nestedItem = isRecord(raw.item) ? raw.item : undefined;
    const type = stringAt(raw, ['type']) ?? stringAt(raw, ['event']) ?? 'unknown';
    const id = stringAt(raw, ['id'])
      ?? stringAt(raw, ['event_id'])
      ?? stringAt(raw, ['eventId'])
      ?? (nestedItem ? stringAt(nestedItem, ['id']) : undefined);
    // Codex uses the same item.id for item.started and item.completed. Only
    // suppress an exact lifecycle event duplicate; otherwise the completed MCP
    // result would be discarded after observing its started event.
    const eventKey = id ? `${type}\u0000${id}` : undefined;
    if (eventKey && this.seenEventKeys.has(eventKey)) return;
    if (eventKey) this.seenEventKeys.add(eventKey);

    if (this.events.length >= this.limits.eventCount) {
      throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex JSONL 事件数量超过上限');
    }

    const event: AgentExecutionEvent = {
      id,
      type,
      raw,
    };
    this.events.push(event);

    const toolResult = extractToolResult(event);
    if (toolResult) {
      if (this.toolResults.length >= this.limits.toolResultCount) {
        throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex 工具结果数量超过上限');
      }
      this.toolResults.push(toolResult);
    }
    this.onEvent(event);
  }
}

function extractToolResult(event: AgentExecutionEvent): AgentToolResult | null {
  const raw = event.raw;
  const item = isRecord(raw.item) ? raw.item : undefined;
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const candidate = item ?? payload ?? raw;
  const candidateType = stringAt(candidate, ['type']) ?? event.type;
  const looksLikeToolResult =
    /tool.*(result|output|completed)/i.test(event.type)
    || /mcp.*(result|output|completed)/i.test(event.type)
    || /tool.*(result|output|completed)/i.test(candidateType)
    || candidateType === 'mcp_tool_call';
  if (!looksLikeToolResult) return null;

  const toolName =
    stringAt(candidate, ['tool_name'])
    ?? stringAt(candidate, ['toolName'])
    ?? stringAt(candidate, ['tool'])
    ?? stringAt(candidate, ['name'])
    ?? stringAt(raw, ['tool_name'])
    ?? stringAt(raw, ['toolName']);
  if (!toolName) return null;

  const result = candidate.result ?? candidate.output ?? raw.result ?? raw.output;
  if (result === undefined) return null;

  return {
    eventId: event.id,
    toolName,
    callId:
      stringAt(candidate, ['call_id'])
      ?? stringAt(candidate, ['callId'])
      ?? stringAt(candidate, ['id']),
    result,
    isError: Boolean(
      candidate.is_error
      ?? candidate.isError
      ?? candidate.error
      ?? raw.is_error
      ?? raw.isError
      ?? raw.error,
    ),
  };
}

function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
