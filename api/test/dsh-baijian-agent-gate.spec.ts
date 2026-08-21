import { describe, expect, it } from 'vitest';
import {
  assertAuthoritativeSources,
  parseFinal,
} from '../scripts/verify-dsh-baijian-agent';
import { DshExecutionResult } from '../src/common/services/dsh-agent.types';

const lawCompletion: DshExecutionResult = {
  text: '',
  dshSessionId: 'test-session',
  toolCalls: [],
  toolResults: [{
    callId: 'call-1',
    name: 'search_laws',
    isError: false,
    result: {
      toolName: 'lawstar_data_professional_query',
      status: 'success_hit',
      count: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1,
      records: [{
        source: 'lawstar',
        recordId: 'LAW-1',
        lawName: '中华人民共和国劳动合同法',
        issuingOrgan: null,
        issuingNo: null,
        releaseDate: null,
        implementDate: null,
        timeliness: '现行有效',
      }],
    },
  }],
};

describe('DSH 百鉴 Agent 真实闸门', () => {
  it('保留通过运行时校验的权威来源字面量类型', () => {
    expect(parseFinal(JSON.stringify({
      answer: '已检索',
      sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }],
    }))).toEqual({
      answer: '已检索',
      sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }],
    });
  });

  it('拒绝未知来源类型', () => {
    expect(() => parseFinal(JSON.stringify({
      answer: '已检索',
      sourceUses: [{ source: 'unknown', recordId: 'LAW-1' }],
    }))).toThrow('sourceUses 无效');
  });

  it('只接受本轮工具结果中的真实 ID', () => {
    expect(() => assertAuthoritativeSources(
      lawCompletion,
      { answer: '已检索', sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }] },
      'law_search',
    )).not.toThrow();
    expect(() => assertAuthoritativeSources(
      lawCompletion,
      { answer: '已检索', sourceUses: [{ source: 'lawstar', recordId: 'FAKE' }] },
      'law_search',
    )).toThrow('不存在的 ID');
  });
});
