import { describe, expect, it } from 'vitest';
import {
  assertAuthoritativeSources,
  CODEX_SYSTEM_REQUIREMENTS_PATH,
} from '../scripts/verify-codex-baijian-agent';
import {
  BAIJIAN_LAW_SEARCH_TOOL,
} from '../src/common/baijian/baijian.types';

const lawToolResult = {
  toolName: BAIJIAN_LAW_SEARCH_TOOL,
  isError: false,
  result: {
    content: [{
      type: 'text',
      text: JSON.stringify({
        code: 200,
        data: {
          count: 1,
          pageSize: 1,
          totalPage: 1,
          lawdata: [{ lawId: 'LAW-1', lawName: '中华人民共和国劳动合同法' }],
        },
      }),
    }],
  },
};

describe('Codex 百鉴 Agent 真实闸门', () => {
  it('固定验证 Codex 实际加载的系统受管策略', () => {
    expect(CODEX_SYSTEM_REQUIREMENTS_PATH).toBe('/etc/codex/requirements.toml');
  });

  it('有命中结果时拒绝空的权威来源引用', () => {
    expect(() => assertAuthoritativeSources(
      [lawToolResult],
      { answer: '已检索', sourceUses: [] },
      BAIJIAN_LAW_SEARCH_TOOL,
    )).toThrow('未引用任何权威记录 ID');
  });

  it('只接受本次工具结果中真实返回的 ID', () => {
    expect(() => assertAuthoritativeSources(
      [lawToolResult],
      { answer: '已检索', sourceUses: [{ source: 'lawstar', recordId: 'LAW-1' }] },
      BAIJIAN_LAW_SEARCH_TOOL,
    )).not.toThrow();
    expect(() => assertAuthoritativeSources(
      [lawToolResult],
      { answer: '已检索', sourceUses: [{ source: 'lawstar', recordId: 'FAKE' }] },
      BAIJIAN_LAW_SEARCH_TOOL,
    )).toThrow('不存在的 ID');
  });
});
