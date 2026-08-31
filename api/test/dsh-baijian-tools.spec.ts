import { describe, expect, it, vi } from 'vitest';
import { DshBaijianToolsService, DSH_BAIJIAN_RESULT_META_KIND } from '../src/common/services/dsh-baijian-tools.service';
import {
  DSH_CASE_SEARCH_TOOL,
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
} from '../src/common/services/dsh-agent.types';
import { validateResearchEvidence } from '../src/common/services/dsh.service';

describe('DshBaijianToolsService', () => {
  it('法规 Agent 工具限制页码/条数并持久标准化结果投影', async () => {
    const normalized = {
      toolName: 'lawstar_data_professional_query', status: 'success_hit', count: 1,
      page: 1, pageSize: 10, totalPages: 1,
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
      { keyword: '劳动合同', page: 10, rows: 10 },
      expect.any(AbortSignal),
    );
    expect(result).toBe(normalized);
    expect(definition.output.presentationMeta({}, result)).toEqual({
      kind: DSH_BAIJIAN_RESULT_META_KIND,
      result: normalized,
    });
  });

  it('法规 Agent 同时获得三类召回工具和有界详情工具', async () => {
    const contentBlocks = Array.from({ length: 300 }, (_, index) => ({
      id: null,
      kind: 'paragraph',
      text: index === 287 ? '第八十七条 用人单位违法解除劳动合同的，应当依照经济补偿标准的二倍支付赔偿金。' : `第${index}条 ${'法'.repeat(500)}`,
    }));
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({ records: [{ recordId: lawId }] }),
      searchLawsAdvanced: vi.fn(), searchLawsSemantic: vi.fn(),
      getLawDetail: vi.fn().mockResolvedValue({
        toolName: 'lawstar_data_professional_detail', recordId: lawId,
        lawName: '劳动合同法', toc: [], contentBlocks,
      }),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');

    expect(definitions.map((item) => item.name)).toEqual([
      DSH_LAW_SEARCH_TOOL,
      DSH_LAW_ADVANCED_SEARCH_TOOL,
      DSH_LAW_SEMANTIC_SEARCH_TOOL,
      DSH_LAW_BATCH_DETAIL_TOOL,
      DSH_LAW_DETAIL_TOOL,
    ]);
    const quick = definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL);
    await quick.execute({ keyword: '劳动合同' }, { signal: new AbortController().signal } as any);
    const detail = definitions.find((item) => item.name === DSH_LAW_DETAIL_TOOL);
    const result = await detail.execute(
      { lawId, articleHint: '第八十七条' },
      { signal: new AbortController().signal } as any,
    );
    expect(Buffer.byteLength(JSON.stringify(result.contentBlocks), 'utf8')).toBeLessThan(90 * 1024);
    expect(result.contentBlocks.length).toBeLessThan(contentBlocks.length);
    expect(result.contentBlocks.some((block: any) => block.text.includes('第八十七条'))).toBe(true);
    expect(result.contentBlocks.some((block: any) => block.text.includes('第1条'))).toBe(false);
  });

  it('批量详情一次核验最多3部本轮候选法规，并限制并发与正文体积', async () => {
    const lawIds = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(32, '0').toUpperCase());
    let active = 0;
    let maxActive = 0;
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({
        records: lawIds.map((recordId) => ({ recordId, matchedContent: '经济补偿' })),
      }),
      searchLawsAdvanced: vi.fn(),
      searchLawsSemantic: vi.fn(),
      getLawDetail: vi.fn().mockImplementation(async ({ lawId }: { lawId: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          toolName: 'lawstar_data_professional_detail',
          recordId: lawId,
          lawName: `法规-${lawId}`,
          toc: [],
          contentBlocks: Array.from({ length: 80 }, (_, index) => ({
            id: null,
            kind: 'paragraph',
            text: index === 40 ? '第四十七条 经济补偿按劳动者工作年限计算。' : `第${index}条 ${'法'.repeat(300)}`,
          })),
        };
      }),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const signal = new AbortController().signal;
    await definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL)
      .execute({ keyword: '经济补偿' }, { signal } as any);
    const batch = definitions.find((item) => item.name === DSH_LAW_BATCH_DETAIL_TOOL);
    const result = await batch.execute({ lawIds, query: '经济补偿' }, { signal } as any);

    expect(result.details).toHaveLength(3);
    expect(baijian.getLawDetail).toHaveBeenCalledTimes(3);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(result.details.every((detail: any) => Buffer.byteLength(JSON.stringify(detail.contentBlocks), 'utf8') < 15 * 1024)).toBe(true);
  });

  it('批量详情局部失败时保留已读取正文，仍满足证据闸门', async () => {
    const lawIds = Array.from({ length: 3 }, (_, index) => index.toString(16).padStart(32, '0').toUpperCase());
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({
        records: lawIds.map((recordId) => ({ recordId, matchedContent: '经济补偿' })),
      }),
      searchLawsAdvanced: vi.fn(),
      searchLawsSemantic: vi.fn(),
      getLawDetail: vi.fn().mockImplementation(async ({ lawId }: { lawId: string }) => {
        if (lawId === lawIds[1]) throw new Error('供应商单条详情失败');
        return {
          toolName: 'lawstar_data_professional_detail',
          recordId: lawId,
          lawName: `法规-${lawId}`,
          toc: [],
          contentBlocks: [{ id: null, kind: 'paragraph', text: '第四十七条 经济补偿按工作年限计算。' }],
        };
      }),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const signal = new AbortController().signal;
    const search = definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL);
    const searchResult = await search.execute({ keyword: '经济补偿' }, { signal } as any);
    const batch = definitions.find((item) => item.name === DSH_LAW_BATCH_DETAIL_TOOL);
    const detailResult = await batch.execute({ lawIds, query: '经济补偿' }, { signal } as any);

    expect(detailResult.details.map((detail: any) => detail.recordId)).toEqual([lawIds[0], lawIds[2]]);
    expect(detailResult.failedLawIds).toEqual([lawIds[1].toLowerCase()]);
    expect(() => validateResearchEvidence('law_search', '', [], [
      { callId: 's1', name: DSH_LAW_SEARCH_TOOL, isError: false, result: searchResult },
      { callId: 'd1', name: DSH_LAW_BATCH_DETAIL_TOOL, isError: false, result: detailResult },
    ])).not.toThrow();
  });

  it('批量详情全部失败时才将整个工具调用判为失败', async () => {
    const lawIds = Array.from({ length: 2 }, (_, index) => index.toString(16).padStart(32, '0').toUpperCase());
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({ records: lawIds.map((recordId) => ({ recordId })) }),
      searchLawsAdvanced: vi.fn(),
      searchLawsSemantic: vi.fn(),
      getLawDetail: vi.fn().mockRejectedValue(new Error('供应商详情失败')),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const signal = new AbortController().signal;
    await definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL)
      .execute({ keyword: '经济补偿' }, { signal } as any);

    await expect(definitions.find((item) => item.name === DSH_LAW_BATCH_DETAIL_TOOL)
      .execute({ lawIds, query: '经济补偿' }, { signal } as any))
      .rejects.toThrow('候选法规均未成功读取正文');
  });

  it('各类法规召回合计最多2次，第3次在供应商调用前拒绝', async () => {
    const empty = { records: [] };
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue(empty),
      searchLawsAdvanced: vi.fn().mockResolvedValue(empty),
      searchLawsSemantic: vi.fn().mockResolvedValue(empty),
      getLawDetail: vi.fn(),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const signal = new AbortController().signal;

    await definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL)
      .execute({ keyword: '劳动合同' }, { signal } as any);
    await definitions.find((item) => item.name === DSH_LAW_SEMANTIC_SEARCH_TOOL)
      .execute({ query: '员工解除劳动合同如何补偿' }, { signal } as any);
    await expect(definitions.find((item) => item.name === DSH_LAW_ADVANCED_SEARCH_TOOL)
      .execute({ keyword: '经济补偿' }, { signal } as any))
      .rejects.toThrow('法规召回最多允许 2 次');
    expect(baijian.searchLaws).toHaveBeenCalledOnce();
    expect(baijian.searchLawsSemantic).toHaveBeenCalledOnce();
    expect(baijian.searchLawsAdvanced).not.toHaveBeenCalled();
  });

  it('单条详情最多调用1次，且全部详情合计不超过3部', async () => {
    const lawIds = Array.from({ length: 4 }, (_, index) => index.toString(16).padStart(32, '0').toUpperCase());
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({ records: lawIds.map((recordId) => ({ recordId, matchedContent: '经济补偿' })) }),
      searchLawsAdvanced: vi.fn(), searchLawsSemantic: vi.fn(),
      getLawDetail: vi.fn().mockImplementation(async ({ lawId }: { lawId: string }) => ({
        toolName: 'lawstar_data_professional_detail', recordId: lawId, lawName: `法规-${lawId}`,
        toc: [], contentBlocks: [{ id: null, kind: 'paragraph', text: '第一条 经济补偿。' }],
      })),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const signal = new AbortController().signal;
    await definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL)
      .execute({ keyword: '经济补偿' }, { signal } as any);
    const single = definitions.find((item) => item.name === DSH_LAW_DETAIL_TOOL);
    await single.execute({ lawId: lawIds[0], query: '经济补偿' }, { signal } as any);
    await expect(single.execute({ lawId: lawIds[1], query: '经济补偿' }, { signal } as any))
      .rejects.toThrow('单条法规详情本轮最多允许 1 次');
    const batch = definitions.find((item) => item.name === DSH_LAW_BATCH_DETAIL_TOOL);
    await expect(batch.execute({ lawIds: lawIds.slice(1), query: '经济补偿' }, { signal } as any))
      .rejects.toThrow('本轮最多核验 3 部候选法规');
    expect(baijian.getLawDetail).toHaveBeenCalledOnce();
  });

  it('详情工具在未提供定位信息时拒绝通读整部法规', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const baijian = {
      searchLaws: vi.fn().mockResolvedValue({ records: [{ recordId: lawId }] }),
      searchLawsAdvanced: vi.fn(), searchLawsSemantic: vi.fn(), getLawDetail: vi.fn(),
    };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    await definitions.find((item) => item.name === DSH_LAW_SEARCH_TOOL)
      .execute({ keyword: '劳动合同' }, { signal: new AbortController().signal } as any);

    await expect(definitions.find((item) => item.name === DSH_LAW_DETAIL_TOOL).execute(
      { lawId },
      { signal: new AbortController().signal } as any,
    )).rejects.toThrow('必须提供 articleHint 或 query');
    expect(baijian.getLawDetail).not.toHaveBeenCalled();
  });

  it('详情工具在供应商调用前拒绝非本轮候选 ID', async () => {
    const baijian = { searchLaws: vi.fn(), searchLawsAdvanced: vi.fn(), searchLawsSemantic: vi.fn(), getLawDetail: vi.fn() };
    const definitions = await new DshBaijianToolsService(baijian as any).createDefinitions('law_search');
    const detail = definitions.find((item) => item.name === DSH_LAW_DETAIL_TOOL);
    await expect(detail.execute(
      { lawId: 'E4A4956751D374FD35D0CEA47C041313' },
      { signal: new AbortController().signal } as any,
    )).rejects.toThrow('必须来自本轮搜索结果');
    expect(baijian.getLawDetail).not.toHaveBeenCalled();
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
