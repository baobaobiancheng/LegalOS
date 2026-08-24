import { describe, expect, it, vi } from 'vitest';
import { CachedLegalResearchGateway } from '../src/common/baijian/cached-legal-research.gateway';

const lawResult = {
  toolName: 'lawstar_data_professional_query' as const,
  status: 'success_hit' as const,
  count: 1,
  page: 1,
  pageSize: 10,
  totalPages: 1,
  records: [{
    source: 'lawstar' as const,
    recordId: 'law-1',
    lawName: '劳动合同法',
    issuingOrgan: null,
    issuingNo: null,
    releaseDate: null,
    implementDate: null,
    timeliness: '现行有效',
  }],
};

const lawDetail = {
  toolName: 'lawstar_data_professional_detail' as const,
  recordId: 'D6592443DA000EF8D692CE667E947A69',
  lawName: '中华人民共和国劳动合同法',
  issuingOrgan: '全国人大常委会',
  issuingNo: null,
  releaseDate: null,
  implementDate: null,
  timeliness: '现行有效',
  hasCompare: false,
  historyCount: 0,
  enclosureCount: 0,
  basisCount: 0,
  toc: [],
  contentBlocks: [{ id: null, kind: 'paragraph' as const, text: '第一条　立法目的。' }],
};

function createHarness() {
  let snapshot: any = null;
  let detail: any = null;
  const usage: any[] = [];
  const supplier = {
    searchLaws: vi.fn().mockResolvedValue(lawResult),
    searchCases: vi.fn(),
    getLawDetail: vi.fn().mockResolvedValue(lawDetail),
  };
  const repository = {
    findFreshSearch: vi.fn(async () => snapshot),
    saveSearch: vi.fn(async (_hash, _capability, value, fetchedAt) => {
      snapshot = { value, fetchedAt, lastVerifiedAt: fetchedAt };
    }),
    findFreshLawDetail: vi.fn(async () => detail),
    saveLawDetail: vi.fn(async (value, fetchedAt) => {
      detail = { value, fetchedAt, lastVerifiedAt: fetchedAt };
    }),
    recordUsage: vi.fn(async (entry) => { usage.push(entry); }),
  };
  const config = { get: (_key: string, fallback: unknown) => fallback };
  const gateway = new CachedLegalResearchGateway(config as any, supplier as any, repository as any);
  return { gateway, repository, supplier, usage, setSnapshot: (value: any) => { snapshot = value; } };
}

describe('CachedLegalResearchGateway', () => {
  it('同一精确请求在 TTL 内复用快照，不再调用供应商', async () => {
    const { gateway, supplier, usage } = createHarness();

    const first = await gateway.searchLaws({ keyword: '  劳动   合同  ', page: 1, rows: 10 });
    const second = await gateway.searchLaws({ keyword: '劳动 合同', page: 1, rows: 10 });

    expect(supplier.searchLaws).toHaveBeenCalledTimes(1);
    expect(first.cache.status).toBe('miss');
    expect(second.cache.status).toBe('hit');
    expect(usage.map((entry) => [entry.cacheStatus, entry.supplierCalled])).toEqual([
      ['miss', true],
      ['hit', false],
    ]);
  });

  it('刷新权威数据显式绕过有效快照', async () => {
    const { gateway, setSnapshot, supplier } = createHarness();
    const fetchedAt = new Date('2026-08-24T00:00:00.000Z');
    setSnapshot({ value: lawResult, fetchedAt, lastVerifiedAt: fetchedAt });

    const result = await gateway.searchLaws(
      { keyword: '劳动合同', page: 1, rows: 10 },
      undefined,
      { refresh: true },
    );

    expect(supplier.searchLaws).toHaveBeenCalledTimes(1);
    expect(result.cache.status).toBe('refresh');
  });

  it('损坏的搜索快照不会伪装成命中，而是回源获取标准结果', async () => {
    const { gateway, setSnapshot, supplier } = createHarness();
    const fetchedAt = new Date('2026-08-24T00:00:00.000Z');
    setSnapshot({ value: { toolName: lawResult.toolName, records: [] }, fetchedAt, lastVerifiedAt: fetchedAt });

    const result = await gateway.searchLaws({ keyword: '劳动合同' });

    expect(supplier.searchLaws).toHaveBeenCalledTimes(1);
    expect(result.cache.status).toBe('miss');
  });

  it('法规正文按权威 lawId 交叉复用', async () => {
    const { gateway, supplier } = createHarness();
    const input = { lawId: lawDetail.recordId };

    const first = await gateway.getLawDetail(input);
    const second = await gateway.getLawDetail(input);

    expect(supplier.getLawDetail).toHaveBeenCalledTimes(1);
    expect(first.cache.status).toBe('miss');
    expect(second.cache.status).toBe('hit');
    expect(second.contentBlocks[0].text).toContain('立法目的');
  });

  it('请求取消不会提前删除正在执行的 single-flight', async () => {
    const { gateway, supplier } = createHarness();
    let resolveSupplier!: (value: typeof lawResult) => void;
    supplier.searchLaws.mockReturnValue(new Promise((resolve) => { resolveSupplier = resolve; }));
    const controller = new AbortController();

    const cancelled = gateway.searchLaws({ keyword: '竞业限制' }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const shared = gateway.searchLaws({ keyword: '竞业限制' });
    resolveSupplier(lawResult);
    const result = await shared;

    expect(supplier.searchLaws).toHaveBeenCalledTimes(1);
    expect(result.cache.status).toBe('shared');
  });
});
