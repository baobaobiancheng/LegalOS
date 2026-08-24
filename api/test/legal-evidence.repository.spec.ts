import { describe, expect, it, vi } from 'vitest';
import { LegalEvidenceRepository } from '../src/common/baijian/legal-evidence.repository';

describe('LegalEvidenceRepository', () => {
  it('案例按真实数据源 + sourceId 去重，避免不同库的本地 ID 冲突', async () => {
    const snapshotUpsert = vi.fn();
    const documentUpsert = vi.fn();
    const prisma = {
      $transaction: (callback: (tx: any) => Promise<void>) => callback({
        legalSearchSnapshot: { upsert: snapshotUpsert },
        legalSourceDocument: { upsert: documentUpsert },
      }),
    };
    const repository = new LegalEvidenceRepository(prisma as any);
    const now = new Date('2026-08-24T00:00:00.000Z');

    await repository.saveSearch('a'.repeat(64), 'similar_case', {
      toolName: 'ldh_search',
      status: 'success_hit',
      count: 1,
      query: '劳动合同',
      elapsedMs: 2,
      records: [{
        source: 'ldh',
        recordId: 'same-id',
        sourceId: 'same-id',
        sourceName: 'CN/Court-A',
        title: '某案',
        court: null,
        date: null,
        country: 'CN',
        caseNumber: null,
        jurisdiction: null,
        snippet: null,
        url: null,
        score: null,
      }],
    }, now, new Date(now.getTime() + 1_000));

    const externalId = documentUpsert.mock.calls[0][0].where.source_externalId.externalId;
    expect(documentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_externalId: { source: 'ldh', externalId } },
    }));
    expect(externalId).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotUpsert.mock.calls[0][0].create.payload.query).toBeNull();
    expect(snapshotUpsert.mock.calls[0][0].update.payload.query).toBeNull();
  });

  it('搜索元数据更新不覆盖已缓存的法规正文', async () => {
    const documentUpsert = vi.fn();
    const prisma = {
      $transaction: (callback: (tx: any) => Promise<void>) => callback({
        legalSearchSnapshot: { upsert: vi.fn() },
        legalSourceDocument: { upsert: documentUpsert },
      }),
    };
    const repository = new LegalEvidenceRepository(prisma as any);
    const now = new Date('2026-08-24T00:00:00.000Z');

    await repository.saveSearch('b'.repeat(64), 'law_search', {
      toolName: 'lawstar_data_professional_query',
      status: 'success_hit',
      count: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      records: [{
        source: 'lawstar',
        recordId: 'law-1',
        lawName: '劳动合同法',
        issuingOrgan: null,
        issuingNo: null,
        releaseDate: null,
        implementDate: null,
        timeliness: '现行有效',
      }],
    }, now, new Date(now.getTime() + 1_000));

    expect(documentUpsert.mock.calls[0][0].update).not.toHaveProperty('content');
    expect(documentUpsert.mock.calls[0][0].update).not.toHaveProperty('contentHash');
    expect(documentUpsert.mock.calls[0][0].update).not.toHaveProperty('contentVerifiedAt');
  });

  it('法规列表的近期校验不能延长旧正文的缓存期限', async () => {
    const contentVerifiedAt = new Date('2026-06-01T00:00:00.000Z');
    const prisma = {
      legalSourceDocument: {
        findUnique: vi.fn().mockResolvedValue({
          content: { toolName: 'lawstar_data_professional_detail' },
          fetchedAt: contentVerifiedAt,
          contentVerifiedAt,
          lastVerifiedAt: new Date('2026-08-24T00:00:00.000Z'),
        }),
      },
    };
    const repository = new LegalEvidenceRepository(prisma as any);

    const cached = await repository.findFreshLawDetail(
      'law-1',
      new Date('2026-07-25T00:00:00.000Z'),
    );

    expect(cached).toBeNull();
  });
});
