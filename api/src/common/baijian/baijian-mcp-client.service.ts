import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BaijianResultNormalizer, classifySupplierError } from './baijian-result.normalizer';
import {
  BAIJIAN_CASE_SEARCH_TOOL,
  BAIJIAN_LAW_ADVANCED_SEARCH_TOOL,
  BAIJIAN_LAW_DETAIL_TOOL,
  BAIJIAN_LAW_SEARCH_TOOL,
  BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL,
  BaijianError,
  BaijianCaseSearchResult,
  BaijianLawDetail,
  BaijianLawSearchResult,
  BaijianNormalizedToolResult,
  BaijianToolName,
} from './baijian.types';

export interface BaijianLawSearchInput {
  keyword: string;
  page?: number;
  rows?: number;
}

export interface BaijianCaseSearchInput {
  query: string;
  topK?: number;
}

export interface BaijianLawDetailInput {
  lawId: string;
}

export interface BaijianLawAdvancedSearchInput extends BaijianLawSearchInput {
  issuingOrgan?: string;
  timeliness?: '0' | '1' | '2' | '3' | '4';
}

export interface BaijianLawSemanticSearchInput {
  query: string;
  keyword?: string;
  rows?: number;
  issuingOrgan?: string;
  timeliness?: '0' | '1' | '2' | '4';
}

export interface BaijianMcpHealth {
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  availableTools: string[];
}

@Injectable()
export class BaijianMcpClientService {
  private readonly endpoint: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly normalizer: BaijianResultNormalizer,
  ) {
    this.endpoint = String(config.get('BAIJIAN_MCP_URL', 'https://mcpgateway.100credit.cn/mcp'));
    const legacyAppKey = String(config.get('BAIJIAN_APP_KEY') ?? '');
    const legacyAppSecret = String(config.get('BAIJIAN_APP_SECRET') ?? '');
    this.appKey = String(config.get('BAIJIAN_MCP_APP_KEY') ?? legacyAppKey);
    this.appSecret = String(config.get('BAIJIAN_MCP_APP_SECRET') ?? legacyAppSecret);
    this.timeoutMs = Math.max(1_000, Number(config.get('BAIJIAN_MCP_TIMEOUT_MS', 15_000)));
  }

  searchLaws(input: BaijianLawSearchInput, signal?: AbortSignal): Promise<BaijianLawSearchResult> {
    const keyword = input.keyword.trim();
    if (!keyword || keyword.length > 200) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规关键词长度必须为 1–200', false);
    }
    return this.callAndNormalize(BAIJIAN_LAW_SEARCH_TOOL, {
      keyword,
      page: clampInteger(input.page ?? 1, 1, 10_000),
      rows: clampInteger(input.rows ?? 10, 1, 20),
    }, signal) as Promise<BaijianLawSearchResult>;
  }

  searchLawsAdvanced(input: BaijianLawAdvancedSearchInput, signal?: AbortSignal): Promise<BaijianLawSearchResult> {
    const keyword = input.keyword.trim();
    if (!keyword || keyword.length > 200) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规高级检索关键词长度必须为 1–200', false);
    }
    return this.callAndNormalize(BAIJIAN_LAW_ADVANCED_SEARCH_TOOL, compact({
      page: clampInteger(input.page ?? 1, 1, 10_000),
      rows: clampInteger(input.rows ?? 5, 1, 20),
      keywords: keyword.includes(';') ? keyword : `0;${keyword}`,
      searchtype: 0,
      depName: cleanOptional(input.issuingOrgan, 100),
      timelinessnew: input.timeliness,
    }), signal) as Promise<BaijianLawSearchResult>;
  }

  searchLawsSemantic(input: BaijianLawSemanticSearchInput, signal?: AbortSignal): Promise<BaijianLawSearchResult> {
    const query = input.query.trim();
    const keyword = input.keyword?.trim();
    if (!query || query.length > 1_000 || (keyword?.length ?? 0) > 200) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规语义检索问题长度必须为 1–1000', false);
    }
    return this.callAndNormalize(BAIJIAN_LAW_SEMANTIC_SEARCH_TOOL, compact({
      rows: clampInteger(input.rows ?? 5, 1, 20),
      vector: query,
      keyword,
      fbdwFacet: cleanOptional(input.issuingOrgan, 100),
      lawstatexlsFacet: input.timeliness,
    }), signal) as Promise<BaijianLawSearchResult>;
  }

  searchCases(input: BaijianCaseSearchInput, signal?: AbortSignal): Promise<BaijianCaseSearchResult> {
    const query = input.query.trim();
    if (!query || query.length > 1_000) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '案例法律问题长度必须为 1–1000', false);
    }
    return this.callAndNormalize(BAIJIAN_CASE_SEARCH_TOOL, {
      query,
      namespace: 'case_law',
      top_k: clampInteger(input.topK ?? 5, 1, 5),
      alpha: 0.7,
      country: ['CN'],
    }, signal) as Promise<BaijianCaseSearchResult>;
  }

  getLawDetail(input: BaijianLawDetailInput, signal?: AbortSignal): Promise<BaijianLawDetail> {
    const lawId = input.lawId.trim();
    if (!/^[0-9a-f]{32}$/i.test(lawId)) {
      throw new BaijianError('BAIJIAN_INVALID_RESPONSE', '法规 ID 格式不正确', false);
    }
    return this.callAndNormalize(BAIJIAN_LAW_DETAIL_TOOL, { rjs8: lawId }, signal) as Promise<BaijianLawDetail>;
  }

  async health(signal?: AbortSignal): Promise<BaijianMcpHealth> {
    const { client, transport } = await this.connect(signal);
    try {
      const tools = await client.listTools(undefined, { signal, timeout: this.timeoutMs });
      const server = client.getServerVersion();
      return {
        protocolVersion: transport.protocolVersion ?? null,
        serverName: server?.name ?? null,
        serverVersion: server?.version ?? null,
        availableTools: tools.tools.map((tool) => tool.name).sort(),
      };
    } catch (error) {
      throw classifySupplierError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async callAndNormalize(
    toolName: BaijianToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BaijianNormalizedToolResult> {
    const { client } = await this.connect(signal);
    try {
      const tools = await client.listTools(undefined, { signal, timeout: this.timeoutMs });
      if (!tools.tools.some((tool) => tool.name === toolName)) {
        throw new BaijianError('BAIJIAN_PROTOCOL_ERROR', `百鉴未公开必需工具：${toolName}`, false);
      }
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
      );
      return this.normalizer.normalize({
        toolName,
        isError: Boolean(result.isError),
        content: result.content,
        structuredContent: result.structuredContent,
      });
    } catch (error) {
      throw classifySupplierError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async connect(signal?: AbortSignal): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }> {
    if (!this.appKey || !this.appSecret) {
      throw new BaijianError('BAIJIAN_AUTH_FAILED', '百鉴 MCP 凭证未配置', false);
    }
    const url = new URL(this.endpoint);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new BaijianError('BAIJIAN_PROTOCOL_ERROR', '生产环境百鉴 MCP 必须使用 HTTPS', false);
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          'X-App-Key': this.appKey,
          'X-App-Secret': this.appSecret,
          Accept: 'application/json, text/event-stream',
        },
      },
    });
    const client = new Client({ name: 'legalos-baijian-gate', version: '1.0.0' });
    try {
      await client.connect(transport, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
      return { client, transport };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw classifySupplierError(error);
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function cleanOptional(value: string | undefined, max: number): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}
