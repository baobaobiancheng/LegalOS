import { describe, expect, it, vi } from 'vitest';
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
    const service = new LegalResearchService({ searchLaws } as any);

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
});
