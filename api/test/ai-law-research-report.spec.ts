import { describe, expect, it } from 'vitest';
import {
  buildStandaloneAiLawResearchPrompt,
  parseAiLawResearchReport,
} from '../src/common/services/ai-law-research-report';

const LAW_ID = 'D6592443DA000EF8D692CE667E947A69';
const ORIGINAL = '夫妻在婚姻关系存续期间所得的工资、奖金、劳务报酬，为夫妻的共同财产。';

function toolResults() {
  return [
    {
      callId: 'search-1', name: 'search_laws_semantic', isError: false,
      result: {
        toolName: 'lawstar_data_xl_query', status: 'success_hit', count: 1,
        page: 1, pageSize: 1, totalPages: 1,
        records: [{ source: 'lawstar', recordId: LAW_ID, lawName: '中华人民共和国民法典' }],
      },
    },
    {
      callId: 'details-1', name: 'get_law_details', isError: false,
      result: {
        toolName: 'get_law_details',
        details: [{
          toolName: 'lawstar_data_professional_detail', recordId: LAW_ID,
          lawName: '中华人民共和国民法典', issuingOrgan: '全国人民代表大会',
          issuingNo: null, releaseDate: '2020-05-28', implementDate: '2021-01-01',
          timeliness: '现行有效', toc: [],
          contentBlocks: [{ id: null, kind: 'paragraph', text: `第一千零六十二条 ${ORIGINAL}` }],
        }],
      },
    },
  ] as any;
}

describe('AI 搜法结构化报告', () => {
  it('只用服务端已核验详情构造来源，并保留可审计指标', () => {
    const parsed = parseAiLawResearchReport(JSON.stringify({
      query: '模型改写的问题',
      title: '离婚财产分割法律检索报告',
      scope: '婚姻家庭领域现行有效法规',
      summary: '婚姻存续期间的工资等通常属于共同财产。',
      answer: `结论。ID: ${LAW_ID}`,
      sections: [{ title: '共同财产范围', content: '工资、奖金等通常纳入共同财产。', sourceIds: [LAW_ID] }],
      evidenceQuotes: [{ recordId: LAW_ID, article: '第一千零六十二条', text: ORIGINAL }],
      limitations: ['具体分割仍取决于财产来源与证据。'],
    }), toolResults(), '我想离婚，进行财产分割');

    expect(parsed.report.query).toBe('我想离婚，进行财产分割');
    expect(parsed.report.sources).toEqual([expect.objectContaining({
      recordId: LAW_ID,
      lawName: '中华人民共和国民法典',
      articles: [{ article: '第一千零六十二条', text: ORIGINAL }],
    })]);
    expect(parsed.report.metrics).toEqual({ candidateCount: 1, verifiedSourceCount: 1, citedSourceCount: 1 });
  });

  it('过滤章节中的未知 ID，并按连续原文将引用归一到已读取法规', () => {
    const unknown = 'E4A4956751D374FD35D0CEA47C041313';
    const parsed = parseAiLawResearchReport(JSON.stringify({
      title: '报告', scope: '范围', summary: '总结', answer: `ID: ${LAW_ID}`,
      sections: [{ title: '分析', content: '内容', sourceIds: [unknown] }],
      evidenceQuotes: [{ recordId: unknown, article: '第一千零六十二条', text: ORIGINAL }],
      limitations: [],
    }), toolResults(), '问题');
    expect(parsed.report.sections[0].sourceIds).toEqual([]);
    expect(parsed.report.sources[0].articles).toEqual([{ article: '第一千零六十二条', text: ORIGINAL }]);
  });

  it('提示词明确批量读取与5次工具调用上限', () => {
    const prompt = buildStandaloneAiLawResearchPrompt('经济补偿如何计算', 5);
    expect(prompt).toContain('get_law_details');
    expect(prompt).toContain('批量读取最多10部');
    expect(prompt).toContain('最多调用工具 5 次');
  });
});
