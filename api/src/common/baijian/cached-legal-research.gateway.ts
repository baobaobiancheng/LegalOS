import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  BaijianLawDetailInput,
  BaijianLawAdvancedSearchInput,
  BaijianLawSearchInput,
  BaijianLawSemanticSearchInput,
  BaijianCaseSearchInput,
  BaijianMcpClientService,
} from './baijian-mcp-client.service';
import {
  BAIJIAN_CASE_SEARCH_TOOL,
  BAIJIAN_LAW_ADVANCED_SEARCH_TOOL,
  BAIJIAN_LAW_DETAIL_TOOL,
  BAIJIAN_LAW_SEARCH_TOOL,
  BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL,
  BaijianLawDetail,
  BaijianLawSearchResult,
  BaijianNormalizedResult,
  CachedLegalResearchResult,
  LegalResearchCacheStatus,
} from './baijian.types';
import { CachedDocument, CachedSnapshot, LegalEvidenceRepository } from './legal-evidence.repository';

export interface LegalResearchRequestOptions {
  refresh?: boolean;
}

interface SupplierValue<T> {
  value: T;
  fetchedAt: Date;
  lastVerifiedAt: Date;
}

const CACHE_CONTRACT_VERSION = 'baijian-cache-v1';

@Injectable()
export class CachedLegalResearchGateway {
  private readonly searchTtlMs: number;
  private readonly lawDetailTtlMs: number;
  private readonly inflight = new Map<string, Promise<SupplierValue<BaijianNormalizedResult | BaijianLawDetail>>>();

  constructor(
    config: ConfigService,
    private readonly supplier: BaijianMcpClientService,
    private readonly repository: LegalEvidenceRepository,
  ) {
    this.searchTtlMs = positiveInteger(config.get('LEGAL_RESEARCH_SEARCH_CACHE_TTL_MS'), 24 * 60 * 60 * 1_000);
    this.lawDetailTtlMs = positiveInteger(config.get('LEGAL_RESEARCH_LAW_DETAIL_CACHE_TTL_MS'), 30 * 24 * 60 * 60 * 1_000);
  }

  async searchLaws(
    input: BaijianLawSearchInput,
    signal?: AbortSignal,
    options: LegalResearchRequestOptions = {},
  ) {
    const normalized = {
      keyword: input.keyword.trim().replace(/\s+/g, ' '),
      page: input.page ?? 1,
      rows: input.rows ?? 10,
    };
    const requestHash = hashRequest(BAIJIAN_LAW_SEARCH_TOOL, normalized);
    return this.resolveSearch(
      requestHash,
      'law_search',
      BAIJIAN_LAW_SEARCH_TOOL,
      options,
      signal,
      (now) => this.repository.findFreshSearch(requestHash, now),
      () => this.supplier.searchLaws(normalized),
    );
  }

  async searchCases(
    input: BaijianCaseSearchInput,
    signal?: AbortSignal,
    options: LegalResearchRequestOptions = {},
  ) {
    const normalized = {
      query: input.query.trim().replace(/\s+/g, ' '),
      topK: input.topK ?? 5,
    };
    const requestHash = hashRequest(BAIJIAN_CASE_SEARCH_TOOL, normalized);
    return this.resolveSearch(
      requestHash,
      'similar_case',
      BAIJIAN_CASE_SEARCH_TOOL,
      options,
      signal,
      (now) => this.repository.findFreshSearch(requestHash, now),
      () => this.supplier.searchCases(normalized),
    );
  }

  async searchLawsAdvanced(
    input: BaijianLawAdvancedSearchInput,
    signal?: AbortSignal,
    options: LegalResearchRequestOptions = {},
  ) {
    const normalized = {
      keyword: normalizeText(input.keyword).replace(/^0\s*;/, ''),
      page: input.page ?? 1,
      rows: input.rows ?? 5,
      ...(input.issuingOrgan ? { issuingOrgan: normalizeText(input.issuingOrgan) } : {}),
      ...(input.timeliness ? { timeliness: input.timeliness } : {}),
    };
    const requestHash = hashRequest(BAIJIAN_LAW_ADVANCED_SEARCH_TOOL, normalized);
    return this.resolveSearch(
      requestHash, 'law_search', BAIJIAN_LAW_ADVANCED_SEARCH_TOOL, options, signal,
      (now) => this.repository.findFreshSearch(requestHash, now),
      () => this.supplier.searchLawsAdvanced(normalized),
    );
  }

  async searchLawsSemantic(
    input: BaijianLawSemanticSearchInput,
    signal?: AbortSignal,
    options: LegalResearchRequestOptions = {},
  ) {
    const normalized = {
      query: normalizeText(input.query),
      rows: input.rows ?? 5,
      ...(input.keyword ? { keyword: normalizeText(input.keyword) } : {}),
      ...(input.issuingOrgan ? { issuingOrgan: normalizeText(input.issuingOrgan) } : {}),
      ...(input.timeliness ? { timeliness: input.timeliness } : {}),
    };
    const requestHash = hashRequest(BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL, normalized);
    return this.resolveSearch(
      requestHash, 'law_search', BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL, options, signal,
      (now) => this.repository.findFreshSearch(requestHash, now),
      () => this.supplier.searchLawsSemantic(normalized),
    );
  }

  async getLawDetail(
    input: BaijianLawDetailInput,
    signal?: AbortSignal,
    options: LegalResearchRequestOptions = {},
  ): Promise<CachedLegalResearchResult<BaijianLawDetail>> {
    const lawId = input.lawId.trim();
    const requestHash = hashRequest(BAIJIAN_LAW_DETAIL_TOOL, { lawId });
    const startedAt = Date.now();
    const now = new Date();
    if (!options.refresh) {
      const cached = await this.repository.findFreshLawDetail(lawId, new Date(now.getTime() - this.lawDetailTtlMs));
      if (cached && isLawDetail(cached.value)) {
        await this.usage(requestHash, 'law_detail', BAIJIAN_LAW_DETAIL_TOOL, 'hit', false, 1, startedAt);
        return withCache(cached.value, 'hit', cached);
      }
    }

    const existing = this.inflight.get(requestHash) as Promise<SupplierValue<BaijianLawDetail>> | undefined;
    if (existing) {
      const shared = await waitFor(existing, signal);
      await this.usage(requestHash, 'law_detail', BAIJIAN_LAW_DETAIL_TOOL, 'shared', false, 1, startedAt);
      return withCache(shared.value, 'shared', shared);
    }

    const status: LegalResearchCacheStatus = options.refresh ? 'refresh' : 'miss';
    const supplierCall = this.fetchLawDetail(requestHash, lawId);
    this.inflight.set(requestHash, supplierCall);
    this.removeInflightWhenSettled(requestHash, supplierCall);
    try {
      const fresh = await waitFor(supplierCall, signal);
      await this.usage(requestHash, 'law_detail', BAIJIAN_LAW_DETAIL_TOOL, status, true, 1, startedAt);
      return withCache(fresh.value, status, fresh);
    } catch (error) {
      await this.usage(requestHash, 'law_detail', BAIJIAN_LAW_DETAIL_TOOL, status, true, 0, startedAt);
      throw error;
    }
  }

  private async resolveSearch<T extends BaijianNormalizedResult>(
    requestHash: string,
    capability: 'law_search' | 'similar_case',
    toolName: typeof BAIJIAN_LAW_SEARCH_TOOL | typeof BAIJIAN_LAW_ADVANCED_SEARCH_TOOL | typeof BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL | typeof BAIJIAN_CASE_SEARCH_TOOL,
    options: LegalResearchRequestOptions,
    signal: AbortSignal | undefined,
    findCached: (now: Date) => Promise<CachedSnapshot<T> | null>,
    callSupplier: () => Promise<T>,
  ): Promise<CachedLegalResearchResult<T>> {
    const startedAt = Date.now();
    if (!options.refresh) {
      const cached = await findCached(new Date());
      if (cached && isSearchResult(cached.value, toolName)) {
        await this.usage(requestHash, capability, toolName, 'hit', false, cached.value.records.length, startedAt);
        return withCache(cached.value, 'hit', cached);
      }
    }

    const existing = this.inflight.get(requestHash) as Promise<SupplierValue<T>> | undefined;
    if (existing) {
      const shared = await waitFor(existing, signal);
      await this.usage(requestHash, capability, toolName, 'shared', false, shared.value.records.length, startedAt);
      return withCache(shared.value, 'shared', shared);
    }

    const status: LegalResearchCacheStatus = options.refresh ? 'refresh' : 'miss';
    const supplierCall = this.fetchSearch(requestHash, capability, callSupplier);
    this.inflight.set(requestHash, supplierCall);
    this.removeInflightWhenSettled(requestHash, supplierCall);
    try {
      const fresh = await waitFor(supplierCall, signal);
      await this.usage(requestHash, capability, toolName, status, true, fresh.value.records.length, startedAt);
      return withCache(fresh.value, status, fresh);
    } catch (error) {
      await this.usage(requestHash, capability, toolName, status, true, 0, startedAt);
      throw error;
    }
  }

  private async fetchSearch<T extends BaijianNormalizedResult>(
    requestHash: string,
    capability: 'law_search' | 'similar_case',
    callSupplier: () => Promise<T>,
  ): Promise<SupplierValue<T>> {
    const value = await callSupplier();
    const fetchedAt = new Date();
    await this.repository.saveSearch(
      requestHash,
      capability,
      value,
      fetchedAt,
      new Date(fetchedAt.getTime() + this.searchTtlMs),
    );
    return { value, fetchedAt, lastVerifiedAt: fetchedAt };
  }

  private async fetchLawDetail(requestHash: string, lawId: string): Promise<SupplierValue<BaijianLawDetail>> {
    const value = await this.supplier.getLawDetail({ lawId });
    const fetchedAt = new Date();
    await this.repository.saveLawDetail(value, fetchedAt);
    return { value, fetchedAt, lastVerifiedAt: fetchedAt };
  }

  private usage(
    requestHash: string,
    capability: 'law_search' | 'similar_case' | 'law_detail',
    toolName: string,
    cacheStatus: LegalResearchCacheStatus,
    supplierCalled: boolean,
    recordCount: number,
    startedAt: number,
  ) {
    return this.repository.recordUsage({
      requestHash,
      capability,
      toolName,
      cacheStatus,
      supplierCalled,
      recordCount,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }

  private removeInflightWhenSettled(
    requestHash: string,
    promise: Promise<SupplierValue<BaijianNormalizedResult | BaijianLawDetail>>,
  ) {
    void promise.finally(() => {
      if (this.inflight.get(requestHash) === promise) this.inflight.delete(requestHash);
    }).catch(() => undefined);
  }
}

function hashRequest(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: CACHE_CONTRACT_VERSION, toolName, input }))
    .digest('hex');
}

function withCache<T extends BaijianNormalizedResult | BaijianLawDetail>(
  value: T,
  status: LegalResearchCacheStatus,
  cached: Pick<CachedSnapshot<any> | CachedDocument<any>, 'fetchedAt' | 'lastVerifiedAt'>,
): CachedLegalResearchResult<T> {
  return {
    ...value,
    cache: {
      status,
      fetchedAt: cached.fetchedAt.toISOString(),
      lastVerifiedAt: cached.lastVerifiedAt.toISOString(),
    },
  };
}

function isSearchResult(value: BaijianNormalizedResult, toolName: string): boolean {
  if (value?.toolName !== toolName || !Number.isInteger(value.count) || !Array.isArray(value.records)) return false;
  if (toolName !== BAIJIAN_CASE_SEARCH_TOOL) {
    const law = value as BaijianLawSearchResult;
    return Number.isInteger(law.page)
      && Number.isInteger(law.pageSize)
      && Number.isInteger(law.totalPages);
  }
  return true;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isLawDetail(value: BaijianLawDetail): boolean {
  return value?.toolName === BAIJIAN_LAW_DETAIL_TOOL
    && typeof value.recordId === 'string'
    && typeof value.lawName === 'string'
    && Array.isArray(value.toc)
    && Array.isArray(value.contentBlocks);
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function abortError(): Error {
  const error = new Error('法律检索已取消');
  error.name = 'AbortError';
  return error;
}
