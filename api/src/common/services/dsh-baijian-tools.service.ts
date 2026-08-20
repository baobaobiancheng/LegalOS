import { Injectable } from '@nestjs/common';
import { BaijianMcpClientService } from '../baijian/baijian-mcp-client.service';
import {
  DSH_CASE_SEARCH_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DshResearchCapability,
} from './dsh-agent.types';

export const DSH_BAIJIAN_RESULT_META_KIND = 'baijian-result-v1';

/**
 * 将现有百鉴 SDK + normalizer 适配为 dsh 原生工具。
 * 该层不处理 Agent 会话或 prompt，也不暴露百鉴凭证。
 */
@Injectable()
export class DshBaijianToolsService {
  constructor(private readonly baijian: BaijianMcpClientService) {}

  async createDefinition(capability: DshResearchCapability): Promise<any> {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const baijian = this.baijian;
    if (capability === 'law_search') {
      return defineTool({
        name: DSH_LAW_SEARCH_TOOL,
        description: '检索中国国内法规元数据。请自主提炼 1–200 字的简短法规关键词；结果不包含可核验的具体条文正文。',
        parameters: {
          keyword: { type: 'string', required: true, description: '法规关键词，不要包含姓名、手机号等个人信息。' },
          page: { type: 'integer', description: '页码，默认 1。' },
          rows: { type: 'integer', description: '返回数量，默认 5，最多 5。' },
        },
        output: this.outputDefinition(),
        timeoutMs: 60_000,
        async execute(args, exec) {
          return baijian.searchLaws({
            keyword: args.keyword,
            page: clamp(args.page, 1, 10, 1),
            rows: clamp(args.rows, 1, 5, 5),
          }, exec.signal) as Promise<any>;
        },
      });
    }

    return defineTool({
      name: DSH_CASE_SEARCH_TOOL,
      description: '检索中国相似案例。请自主把用户问题改写为不含个人信息的完整法律问题。',
      parameters: {
        query: { type: 'string', required: true, description: '用于语义检索的完整法律问题。' },
        topK: { type: 'integer', description: '返回案例数，默认 5，最多 5。' },
      },
      output: this.outputDefinition(),
      timeoutMs: 60_000,
      async execute(args, exec) {
        return baijian.searchCases({
          query: args.query,
          topK: clamp(args.topK, 1, 5, 5),
        }, exec.signal) as Promise<any>;
      },
    });
  }

  private outputDefinition() {
    return {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: JSON.stringify(value),
      }],
      // dsh 不持久 canonical value；将有界的标准化结果投影到 tool/result.meta，
      // 供服务端在会话回放与最终引用校验时使用。
      presentationMeta: (_args: unknown, value: unknown) => ({
        kind: DSH_BAIJIAN_RESULT_META_KIND,
        result: JSON.parse(JSON.stringify(value)),
      }),
    };
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value!));
}
