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
          cache: { status: 'hit', fetchedAt: '2026-08-30T08:00:00.000Z', lastVerifiedAt: '2026-08-30T08:00:00.000Z' },
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
    expect(parsed.report.resultStatus).toBe('complete');
    expect(parsed.report.sources).toEqual([expect.objectContaining({
      recordId: LAW_ID,
      lawName: '中华人民共和国民法典',
      lastVerifiedAt: '2026-08-30T08:00:00.000Z',
      articles: [{ article: '第一千零六十二条', text: `第一千零六十二条 ${ORIGINAL}` }],
    })]);
    expect(parsed.report.metrics).toEqual({ candidateCount: 1, verifiedSourceCount: 1, citedSourceCount: 1 });
  });

  it('来源卡片只展示已读取详情正文，不展示模型生成的引文文字', () => {
    const unknown = 'E4A4956751D374FD35D0CEA47C041313';
    const fabricated = '正文中不存在的模型引文';
    const parsed = parseAiLawResearchReport(JSON.stringify({
      title: '报告', scope: '范围', summary: '总结', answer: `ID: ${LAW_ID}`,
      sections: [{ title: '分析', content: '内容', sourceIds: [unknown] }],
      evidenceQuotes: [
        { recordId: unknown, article: '第一条', text: fabricated },
        { recordId: LAW_ID, article: '第二条', text: fabricated },
      ],
      limitations: [],
    }), toolResults(), '问题');

    expect(parsed.report.sections[0].sourceIds).toEqual([unknown.toLowerCase()]);
    expect(parsed.report.sources[0].articles[0].text).toContain(ORIGINAL);
    expect(parsed.report.sources[0].articles[0].text).not.toContain(fabricated);
    expect(parsed.report.metrics.citedSourceCount).toBe(1);
  });

  it('模型返回 Markdown 时保留正文并由服务端补全报告展示结构', () => {
    const parsed = parseAiLawResearchReport([
      '## 结论',
      '婚姻关系存续期间取得的工资、奖金通常属于夫妻共同财产。',
      '## 适用边界',
      '仍需结合财产取得时间、来源及双方约定判断。',
    ].join('\n\n'), toolResults(), '离婚财产如何分割？');

    expect(parsed.answer).toContain('婚姻关系存续期间');
    expect(parsed.report).toMatchObject({
      resultStatus: 'complete',
      query: '离婚财产如何分割？',
      metrics: { candidateCount: 1, verifiedSourceCount: 1 },
    });
    expect(parsed.report.title).toContain('离婚财产如何分割');
    expect(parsed.report.sections.map((section) => section.title)).toEqual(['结论', '适用边界']);
    expect(parsed.report.sources[0].articles[0].text).toContain(ORIGINAL);
    expect(parsed.report.answer).toBe(parsed.answer);
    expect(parsed.report.limitations).toEqual([]);
  });

  it('从说明文字中提取 JSON，并容忍缺少非核心展示字段', () => {
    const parsed = parseAiLawResearchReport(`以下为结构化结果：\n${JSON.stringify({
      summary: '已完成共同财产范围检索。',
      sections: [{ content: '工资、奖金通常属于共同财产。', sourceIds: [LAW_ID] }],
    })}\n请查收。`, toolResults(), '共同财产范围');

    expect(parsed.report.resultStatus).toBe('complete');
    expect(parsed.report.summary).toBe('已完成共同财产范围检索。');
    expect(parsed.report.sections[0]).toMatchObject({ title: '分析 1', content: '工资、奖金通常属于共同财产。' });
    expect(parsed.answer).toContain('已完成共同财产范围检索');
  });

  it('畸形结构化输出只恢复 answer，不把 JSON 外壳和过程性说明作为正文', () => {
    const malformed = [
      '现在我已经收集到足够的法律依据，下面输出完整的搜法报告。',
      'json {',
      '  "query": "离婚财产如何分割？",',
      '  "summary": "离婚财产分割以"先协议、后判决"为基本路径。",',
      '  "answer": "## 结论\\n离婚时夫妻共同财产原则上先由双方协议处理；协议不成的，由人民法院依法判决。",',
      '  "sections": []',
      '}',
    ].join('\n');

    const parsed = parseAiLawResearchReport(malformed, toolResults(), '离婚财产如何分割？');

    expect(parsed.answer).toContain('离婚时夫妻共同财产原则上先由双方协议处理');
    expect(parsed.answer).not.toContain('"summary"');
    expect(parsed.report.answer).toBe(parsed.answer);
    expect(parsed.report.summary).not.toContain('现在我已经');
    expect(parsed.report.summary).not.toContain('"query"');
    expect(parsed.report.sections.map((section) => section.content).join('\n')).not.toContain('"sections"');
  });

  it('非 JSON 长正文会分段完整进入报告，不在 3000 字处丢失', () => {
    const longAnalysis = `共同财产分析：${'甲'.repeat(3_400)}。末尾结论应保留。`;
    const parsed = parseAiLawResearchReport([
      '## 具体分析',
      longAnalysis,
      '## 适用边界',
      '还需核对财产取得时间与双方约定。',
    ].join('\n\n'), toolResults(), '离婚财产如何分割？');

    const visibleBody = parsed.report.sections.map((section) => section.content).join('\n');
    expect(parsed.report.sections.length).toBeGreaterThan(2);
    expect(parsed.report.sections.every((section) => section.content.length <= 3_000)).toBe(true);
    expect(visibleBody).toContain('末尾结论应保留');
    expect(visibleBody).toContain('还需核对财产取得时间');
    expect(parsed.report.summary.length).toBeLessThanOrEqual(500);
  });

  it('提示词明确最多3部批量读取与5次工具调用上限', () => {
    const prompt = buildStandaloneAiLawResearchPrompt('经济补偿如何计算', 5);
    expect(prompt).toContain('get_law_details');
    expect(prompt).toContain('批量读取最多3部');
    expect(prompt).toContain('本轮最多两次');
    expect(prompt).toContain('最多调用工具 5 次');
    expect(prompt).toContain('客观、正式的书面法律语言');
    expect(prompt).toContain('英文双引号必须正确转义');
  });

  it('事实修正由服务端确定性覆盖旧事实，不依赖模型主动删除', () => {
    const parsed = parseAiLawResearchReport(JSON.stringify({
      title: '报告', scope: '范围', summary: '总结', answer: `ID: ${LAW_ID}`,
      understanding: {
        queryType: 'legal_issue', analysis: '分析', retrievalPlan: '检索',
        knownFacts: ['合同于2024年签订', '双方均为公司'],
        legalIssues: ['违约责任'],
        factChanges: { added: [], corrected: [], removed: [] },
      },
      sections: [{ title: '分析', content: '内容', sourceIds: [LAW_ID] }],
      evidenceQuotes: [{ recordId: LAW_ID, article: '第一千零六十二条', text: ORIGINAL }],
      limitations: [],
    }), toolResults(), '不是2024年签订，是2023年签订', {
      operation: 'correct',
      knownFacts: ['合同于2024年签订', '双方均为公司'],
      legalIssues: ['违约责任'],
    });

    expect(parsed.report.understanding.knownFacts).toEqual(['双方均为公司', '2023年签订']);
    expect(parsed.report.understanding.factChanges.corrected).toContainEqual({
      from: '2024年签订', to: '2023年签订',
    });
  });
});
