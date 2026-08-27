import { describe, expect, it, vi } from 'vitest';
import { DshExecutionHandle } from '../src/common/services/dsh.service';
import { isCaseLikeTitle, LegalResearchService } from '../src/modules/legal-research/legal-research.service';

describe('LegalResearchService', () => {
  it('快捷检索如实传递用户关键词，不用硬编码规则冒充 AI 意图理解', async () => {
    const searchLaws = vi.fn().mockResolvedValue({
      toolName: 'lawstar_data_professional_query', status: 'success_hit', count: 1,
      page: 2, pageSize: 10, totalPages: 3, records: [
        { lawName: '中华人民共和国劳动合同法' },
        { lawName: '陈某诉某公司劳动合同纠纷案' },
      ],
    });
    const service = new LegalResearchService({ searchLaws } as any, {} as any, {} as any);

    const result = await service.searchLaws({ keyword: '劳动合同纠纷', page: 2, rows: 10 });

    expect(searchLaws).toHaveBeenCalledWith(
      { keyword: '劳动合同纠纷', page: 2, rows: 10 },
      undefined,
      { refresh: undefined },
    );
    expect(result).toMatchObject({
      requestedKeyword: '劳动合同纠纷',
      searchedKeyword: '劳动合同纠纷',
      filteredCaseLikeCount: 1,
      records: [{ lawName: '中华人民共和国劳动合同法' }],
    });
  });

  it('只排除明确的案例型标题，不误伤司法解释', () => {
    expect(isCaseLikeTitle('指导性案例180号：孙某诉某公司劳动合同纠纷案')).toBe(true);
    expect(isCaseLikeTitle('最高人民法院关于审理劳动争议案件适用法律问题的解释')).toBe(false);
  });

  it('AI 搜法返回结构化报告并记录开始与成功审计', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const original = '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资。';
    const handle = new DshExecutionHandle();
    const executeStream = vi.fn().mockImplementation(async () => {
      setImmediate(() => handle.emit('done', {
        text: JSON.stringify({
          title: '经济补偿法律检索报告', scope: '劳动合同领域现行法规', summary: '依法计算经济补偿。',
          answer: `结论 ID: ${lawId}`,
          sections: [{ title: '计算标准', content: '按工作年限计算。', sourceIds: [lawId] }],
          evidenceQuotes: [{ recordId: lawId, article: '第四十七条', text: original }],
          limitations: ['具体金额取决于工资基数。'],
        }),
        dshSessionId: 'dsh-report-1',
        toolCalls: [
          { callId: 's1', name: 'search_laws', arguments: { keyword: '经济补偿' } },
          { callId: 'd1', name: 'get_law_details', arguments: { lawIds: [lawId], query: '经济补偿' } },
        ],
        toolResults: [
          { callId: 's1', name: 'search_laws', isError: false, result: { records: [{ recordId: lawId, lawName: '劳动合同法' }] } },
          { callId: 'd1', name: 'get_law_details', isError: false, result: { toolName: 'get_law_details', details: [{ recordId: lawId, lawName: '劳动合同法', issuingOrgan: null, issuingNo: null, releaseDate: null, implementDate: null, timeliness: '现行有效', contentBlocks: [{ text: original }] }] } },
        ],
      }));
      return handle;
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new LegalResearchService({} as any, {
      executeStream,
      getToolCallLimit: () => 5,
    } as any, { record } as any);

    const result = await service.aiSearch(
      { query: '经济补偿如何计算' },
      { id: 'legal-1', role: 'legal_bp' as any },
    );

    expect(executeStream).toHaveBeenCalledWith(expect.stringContaining('最多调用工具 5 次'), expect.objectContaining({
      sessionId: 'legal-research:legal-1', researchCapability: 'law_search', requireResearchTool: true,
    }));
    expect(result.reportId).toBe('dsh-report-1');
    expect(result.report.sources[0]).toMatchObject({ recordId: lawId, lawName: '劳动合同法' });
    expect(result.trace.report?.title).toBe('经济补偿法律检索报告');
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ai.legal_research.succeeded' }));
  });
});
