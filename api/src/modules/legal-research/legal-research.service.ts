import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BaijianMcpClientService } from '../../common/baijian/baijian-mcp-client.service';
import { BaijianError } from '../../common/baijian/baijian.types';
import { SearchCasesDto, SearchLawsDto } from './dto/legal-research.dto';

@Injectable()
export class LegalResearchService {
  constructor(private readonly baijian: BaijianMcpClientService) {}

  async searchLaws(dto: SearchLawsDto, signal?: AbortSignal) {
    try {
      const requestedKeyword = dto.keyword.trim();
      const searchedKeyword = requestedKeyword;
      const result = await this.baijian.searchLaws({ ...dto, keyword: searchedKeyword }, signal);
      const records = result.records.filter((record) => !isCaseLikeTitle(record.lawName));
      return {
        ...result,
        records,
        requestedKeyword,
        searchedKeyword,
        filteredCaseLikeCount: result.records.length - records.length,
      };
    } catch (error) {
      throw presentResearchError(error);
    }
  }

  async getLawDetail(lawId: string, signal?: AbortSignal) {
    try {
      return await this.baijian.getLawDetail({ lawId }, signal);
    } catch (error) {
      throw presentResearchError(error);
    }
  }

  async searchCases(dto: SearchCasesDto, signal?: AbortSignal) {
    try {
      return await this.baijian.searchCases(dto, signal);
    } catch (error) {
      throw presentResearchError(error);
    }
  }
}

export function isCaseLikeTitle(title: string): boolean {
  const value = title.replace(/\s+/g, '');
  return /(?:^|[\s——：:])(?:指导性|典型|参考)?案例\d*[：:]?/u.test(title)
    || /纠纷案(?:$|[（(])/u.test(value)
    || /^[^\s]{1,40}诉[^\s]{1,80}案$/u.test(value)
    || /案例$/.test(value);
}

function presentResearchError(error: unknown): ServiceUnavailableException {
  const supplier = error instanceof BaijianError ? error : undefined;
  const code = supplier?.code ?? 'BAIJIAN_SUPPLIER_ERROR';
  const message = code === 'BAIJIAN_QUOTA_EXHAUSTED'
    ? '案例库额度暂不可用，请稍后重试'
    : code === 'BAIJIAN_TIMEOUT'
      ? '检索超时，请重试'
      : '法律数据源暂不可用，请稍后重试';
  return new ServiceUnavailableException(
    {
      code,
      message,
      actions: supplier?.retryable === false ? [] : ['retry'],
      retryable: supplier?.retryable ?? true,
    },
    { cause: error },
  );
}
