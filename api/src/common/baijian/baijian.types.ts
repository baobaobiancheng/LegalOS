export const BAIJIAN_LAW_SEARCH_TOOL = 'lawstar_data_professional_query' as const;
export const BAIJIAN_CASE_SEARCH_TOOL = 'ldh_search' as const;
export type BaijianToolName =
  | typeof BAIJIAN_LAW_SEARCH_TOOL
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

export type BaijianNormalizedResult =
  | {
      toolName: typeof BAIJIAN_LAW_SEARCH_TOOL;
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
