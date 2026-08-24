export const BAIJIAN_LAW_SEARCH_TOOL = 'lawstar_data_professional_query' as const;
export const BAIJIAN_LAW_ADVANCED_SEARCH_TOOL = 'lawstar_data_k_query' as const;
export const BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL = 'lawstar_data_xl_query' as const;
export const BAIJIAN_LAW_DETAIL_TOOL = 'lawstar_data_professional_detail' as const;
export const BAIJIAN_CASE_SEARCH_TOOL = 'ldh_search' as const;
export type BaijianToolName =
  | typeof BAIJIAN_LAW_SEARCH_TOOL
  | typeof BAIJIAN_LAW_ADVANCED_SEARCH_TOOL
  | typeof BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL
  | typeof BAIJIAN_LAW_DETAIL_TOOL
  | typeof BAIJIAN_CASE_SEARCH_TOOL;

export interface BaijianRawToolResult {
  toolName: BaijianToolName;
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

export type BaijianSourceStatus =
  | 'success_hit'
  | 'success_empty';

export interface BaijianLawRecord {
  source: 'lawstar';
  recordId: string;
  lawName: string;
  issuingOrgan: string | null;
  issuingNo: string | null;
  releaseDate: string | null;
  implementDate: string | null;
  timeliness: string | null;
  matchedContent?: string | null;
  articleNumber?: string | null;
  score?: number | null;
}

export interface BaijianCaseRecord {
  source: 'ldh';
  recordId: string;
  sourceId: string;
  sourceName: string;
  title: string;
  court: string | null;
  date: string | null;
  country: string | null;
  caseNumber: string | null;
  jurisdiction: string | null;
  snippet: string | null;
  url: string | null;
  score: number | null;
}

export interface BaijianLawTocItem {
  id: string;
  text: string;
  level: number;
  children: BaijianLawTocItem[];
}

export interface BaijianLawContentBlock {
  id: string | null;
  kind: 'heading' | 'paragraph' | 'signature';
  text: string;
}

export interface BaijianLawDetail {
  toolName: typeof BAIJIAN_LAW_DETAIL_TOOL;
  recordId: string;
  lawName: string;
  issuingOrgan: string | null;
  issuingNo: string | null;
  releaseDate: string | null;
  implementDate: string | null;
  timeliness: string | null;
  hasCompare: boolean;
  historyCount: number;
  enclosureCount: number;
  basisCount: number;
  toc: BaijianLawTocItem[];
  contentBlocks: BaijianLawContentBlock[];
}

export type BaijianNormalizedResult =
  | {
      toolName: typeof BAIJIAN_LAW_SEARCH_TOOL | typeof BAIJIAN_LAW_ADVANCED_SEARCH_TOOL | typeof BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL;
      status: BaijianSourceStatus;
      count: number;
      page: number;
      pageSize: number;
      totalPages: number;
      records: BaijianLawRecord[];
    }
  | {
      toolName: typeof BAIJIAN_CASE_SEARCH_TOOL;
      status: BaijianSourceStatus;
      count: number;
      query: string | null;
      elapsedMs: number | null;
      records: BaijianCaseRecord[];
    };

export type BaijianLawSearchResult = Exclude<BaijianNormalizedResult, { toolName: typeof BAIJIAN_CASE_SEARCH_TOOL }>;
export type BaijianCaseSearchResult = Extract<BaijianNormalizedResult, { toolName: typeof BAIJIAN_CASE_SEARCH_TOOL }>;
export type BaijianNormalizedToolResult = BaijianNormalizedResult | BaijianLawDetail;

export type LegalResearchCacheStatus = 'hit' | 'miss' | 'refresh' | 'shared';

export interface LegalResearchCacheInfo {
  status: LegalResearchCacheStatus;
  fetchedAt: string;
  lastVerifiedAt: string;
}

export type CachedLegalResearchResult<T extends BaijianNormalizedToolResult> = T & {
  cache: LegalResearchCacheInfo;
};

export type BaijianErrorCode =
  | 'BAIJIAN_QUOTA_EXHAUSTED'
  | 'BAIJIAN_TIMEOUT'
  | 'BAIJIAN_AUTH_FAILED'
  | 'BAIJIAN_PROTOCOL_ERROR'
  | 'BAIJIAN_SUPPLIER_ERROR'
  | 'BAIJIAN_INVALID_RESPONSE'
  | 'BAIJIAN_TOOL_NOT_ALLOWED';

export class BaijianError extends Error {
  constructor(
    public readonly code: BaijianErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly supplierCode?: string | number,
  ) {
    super(message);
    this.name = 'BaijianError';
  }
}
