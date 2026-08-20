import { describe, expect, it, vi } from 'vitest';
import { DshBaijianToolsService, DSH_BAIJIAN_RESULT_META_KIND } from '../src/common/services/dsh-baijian-tools.service';
import { DSH_CASE_SEARCH_TOOL, DSH_LAW_SEARCH_TOOL } from '../src/common/services/dsh-agent.types';

describe('DshBaijianToolsService', () => {
  it('法规 Agent 工具限制页码/条数并持久标准化结果投影', async () => {
    const normalized = {
      toolName: 'lawstar_data_professional_query', status: 'success_hit', count: 1,
      page: 1, pageSize: 5, totalPages: 1,
      records: [{ source: 'lawstar', recordId: 'law-1', lawName: '劳动合同法' }],
    };
    const baijian = { searchLaws: vi.fn().mockResolvedValue(normalized), searchCases: vi.fn() };
    const definition = await new DshBaijianToolsService(baijian as any).createDefinition('law_search');

    expect(definition.name).toBe(DSH_LAW_SEARCH_TOOL);
    const result = await definition.execute(
      { keyword: '劳动合同', page: 99, rows: 99 },
      { signal: new AbortController().signal } as any,
    );
    expect(baijian.searchLaws).toHaveBeenCalledWith(
      { keyword: '劳动合同', page: 10, rows: 5 },
      expect.any(AbortSignal),
    );
    expect(result).toBe(normalized);
    expect(definition.output.presentationMeta({}, result)).toEqual({
      kind: DSH_BAIJIAN_RESULT_META_KIND,
      result: normalized,
    });
  });

  it('类案 Agent 只注册类案工具并强制 topK 上限', async () => {
    const normalized = {
      toolName: 'ldh_search', status: 'success_empty', count: 0, query: '竞业限制', elapsedMs: 2, records: [],
    };
    const baijian = { searchLaws: vi.fn(), searchCases: vi.fn().mockResolvedValue(normalized) };
    const definition = await new DshBaijianToolsService(baijian as any).createDefinition('similar_case');

    expect(definition.name).toBe(DSH_CASE_SEARCH_TOOL);
    await definition.execute(
      { query: '竞业限制补偿金争议', topK: 100 },
      { signal: new AbortController().signal } as any,
    );
    expect(baijian.searchCases).toHaveBeenCalledWith(
      { query: '竞业限制补偿金争议', topK: 5 },
      expect.any(AbortSignal),
    );
  });
});
