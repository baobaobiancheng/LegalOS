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

  it('接受模型常见的 markdown JSON 围栏但仍执行结构校验', () => {
    expect(parseFinal(`\`\`\`json
{"answer":"已检索","sourceUses":[{"source":"lawstar","recordId":"LAW-1"}]}
\`\`\``)).toEqual({
      answer: '已检索',
      sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }],
    });
  });

  it('接受 JSON 前后的简短模型说明但拒绝多个候选结果', () => {
    expect(parseFinal('检索完成：\n{"answer":"已检索","sourceUses":[{"source":"lawstar","recordId":"LAW-1"}]}')).toEqual({
      answer: '已检索',
      sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }],
    });
    expect(() => parseFinal([
      '{"answer":"第一次","sourceUses":[]}',
      '{"answer":"第二次","sourceUses":[]}',
    ].join('\n'))).toThrow('包含多个 JSON 结果');
  });

  it('能正确处理答案字符串中的花括号', () => {
    expect(parseFinal('结果：{"answer":"适用条件为 {A}，并非代码块","sourceUses":[]}')).toEqual({
      answer: '适用条件为 {A}，并非代码块',
      sourceUses: [],
    });
  });

  it('拒绝未知来源类型', () => {
    expect(() => parseFinal(JSON.stringify({
      answer: '已检索',
      sourceUses: [{ source: 'unknown', recordId: 'LAW-1' }],
    }))).toThrow('sourceUses 无效');
  });

  it('拒绝空答案和完全非 JSON 的输出', () => {
    expect(() => parseFinal('{"answer":"  ","sourceUses":[]}')).toThrow('结构无效');
    expect(() => parseFinal('只返回了一段普通说明')).toThrow('不是合法 JSON');
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
