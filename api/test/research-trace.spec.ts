import { describe, expect, it } from 'vitest';
import { buildResearchTrace } from '../src/modules/project/application/research-trace';

describe('ResearchTraceV1', () => {
  it('只保存有界的权威来源与脱敏查询', () => {
    const trace = buildResearchTrace('law_search', {
      text: 'answer',
      dshSessionId: 'session-1',
      toolCalls: [{ callId: 'c1', name: 'search_laws', arguments: { keyword: '劳'.repeat(300) } }],
      toolResults: [{
        callId: 'c1',
        name: 'search_laws',
        isError: false,
        result: {
          toolName: 'lawstar_data_professional_query',
          status: 'success_hit',
          count: 8,
          page: 1,
          pageSize: 8,
          totalPages: 1,
          records: Array.from({ length: 8 }, (_, index) => ({
            source: 'lawstar' as const,
            recordId: `law-${index}`,
            lawName: '劳动合同法',
            issuingOrgan: null,
            issuingNo: null,
            releaseDate: null,
            implementDate: null,
            timeliness: '现行有效',
          })),
        },
      }],
    });

    expect(trace.schemaVersion).toBe(1);
    expect(trace.calls[0].query).toHaveLength(200);
    expect(trace.calls[0].records).toHaveLength(5);
    expect(trace.calls[0].recordIds).toEqual(['law-0', 'law-1', 'law-2', 'law-3', 'law-4']);
    expect(trace.limitations[0]).toContain('未检索到可核验法规正文');
  });

  it('与 Agent 的 8 次工具预算保持一致', () => {
    const trace = buildResearchTrace('law_search', {
      text: 'answer',
      dshSessionId: 'session-8-calls',
      toolCalls: Array.from({ length: 10 }, (_, index) => ({
        callId: `c${index}`,
        name: 'search_laws',
        arguments: { keyword: `劳动合同-${index}` },
      })),
      toolResults: Array.from({ length: 10 }, (_, index) => ({
        callId: `c${index}`,
        name: 'search_laws',
        isError: false,
        result: {
          toolName: 'lawstar_data_professional_query' as const,
          status: 'success_empty' as const,
          count: 0,
          page: 1,
          pageSize: 5,
          totalPages: 0,
          records: [],
        },
      })),
    });

    expect(trace.calls).toHaveLength(8);
    expect(trace.calls.at(-1)?.query).toBe('劳动合同-7');
  });

  it('自然语言语义查询在业务 trace 中只保存哈希', () => {
    const trace = buildResearchTrace('law_search', {
      text: '未检索到可核验来源',
      dshSessionId: 'session-semantic',
      toolCalls: [{ callId: 'c1', name: 'search_laws_semantic', arguments: { query: '张三手机号13800138000被违法解除' } }],
      toolResults: [{ callId: 'c1', name: 'search_laws_semantic', isError: false, result: {
        toolName: 'lawstar_data_xl_query', status: 'success_empty', count: 0,
        page: 1, pageSize: 0, totalPages: 0, records: [],
      } }],
    });
    expect(trace.calls[0].query).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trace.calls[0].query).not.toContain('张三');
  });
});
