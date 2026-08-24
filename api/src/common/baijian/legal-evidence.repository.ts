import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BaijianCaseSearchResult,
  BaijianLawDetail,
  BaijianLawSearchResult,
  BaijianNormalizedResult,
  BaijianNormalizedToolResult,
  LegalResearchCacheStatus,
} from './baijian.types';

export interface CachedSnapshot<T extends BaijianNormalizedResult> {
  value: T;
  fetchedAt: Date;
  lastVerifiedAt: Date;
}

export interface CachedDocument<T extends BaijianLawDetail> {
  value: T;
  fetchedAt: Date;
  lastVerifiedAt: Date;
}

interface UsageInput {
  requestHash: string;
  capability: 'law_search' | 'similar_case' | 'law_detail';
  toolName: string;
  cacheStatus: LegalResearchCacheStatus;
  supplierCalled: boolean;
  recordCount: number;
  durationMs: number;
}

@Injectable()
export class LegalEvidenceRepository {
  private readonly logger = new Logger(LegalEvidenceRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findFreshSearch<T extends BaijianNormalizedResult>(requestHash: string, now: Date): Promise<CachedSnapshot<T> | null> {
    try {
      const snapshot = await this.prisma.legalSearchSnapshot.findUnique({ where: { requestHash } });
      if (!snapshot || snapshot.expiresAt <= now) return null;
      return {
        value: snapshot.payload as unknown as T,
        fetchedAt: snapshot.fetchedAt,
        lastVerifiedAt: snapshot.fetchedAt,
      };
    } catch (error) {
      this.logger.warn(`读取法律检索快照失败，将回源检索：${safeError(error)}`);
      return null;
    }
  }

  async findFreshLawDetail(lawId: string, verifiedAfter: Date): Promise<CachedDocument<BaijianLawDetail> | null> {
    try {
      const document = await this.prisma.legalSourceDocument.findUnique({
        where: { source_externalId: { source: 'lawstar', externalId: lawId } },
      });
      if (!document?.content || !document.contentVerifiedAt || document.contentVerifiedAt < verifiedAfter) return null;
      return {
        value: document.content as unknown as BaijianLawDetail,
        fetchedAt: document.fetchedAt,
        lastVerifiedAt: document.contentVerifiedAt,
      };
    } catch (error) {
      this.logger.warn(`读取法规详情缓存失败，将回源检索：${safeError(error)}`);
      return null;
    }
  }

  async saveSearch(requestHash: string, capability: 'law_search' | 'similar_case', value: BaijianNormalizedResult, fetchedAt: Date, expiresAt: Date): Promise<void> {
    try {
      const snapshotValue = redactSearchRequest(value);
      await this.prisma.$transaction(async (tx) => {
        await tx.legalSearchSnapshot.upsert({
          where: { requestHash },
          create: {
            requestHash,
            capability,
            toolName: value.toolName,
            payload: toJson(snapshotValue),
            fetchedAt,
            expiresAt,
          },
          update: {
            capability,
            toolName: value.toolName,
            payload: toJson(snapshotValue),
            fetchedAt,
            expiresAt,
          },
        });
        if (value.toolName === 'lawstar_data_professional_query') {
          await this.upsertLawRecords(tx, value, fetchedAt);
        } else {
          await this.upsertCaseRecords(tx, value, fetchedAt);
        }
      });
    } catch (error) {
      this.logger.warn(`写入法律检索快照失败，本次仍返回供应商结果：${safeError(error)}`);
    }
  }

  async saveLawDetail(value: BaijianLawDetail, fetchedAt: Date): Promise<void> {
    const metadata = lawDetailMetadata(value);
    try {
      await this.prisma.legalSourceDocument.upsert({
        where: { source_externalId: { source: 'lawstar', externalId: value.recordId } },
        create: {
          source: 'lawstar',
          externalId: value.recordId,
          kind: 'law',
          title: value.lawName,
          metadata: toJson(metadata),
          content: toJson(value),
          contentHash: sha256(JSON.stringify(value)),
          contentVerifiedAt: fetchedAt,
          fetchedAt,
          lastVerifiedAt: fetchedAt,
        },
        update: {
          title: value.lawName,
          metadata: toJson(metadata),
          content: toJson(value),
          contentHash: sha256(JSON.stringify(value)),
          contentVerifiedAt: fetchedAt,
          fetchedAt,
          lastVerifiedAt: fetchedAt,
        },
      });
    } catch (error) {
      this.logger.warn(`写入法规详情缓存失败，本次仍返回供应商结果：${safeError(error)}`);
    }
  }

  async recordUsage(input: UsageInput): Promise<void> {
    try {
      await this.prisma.legalResearchUsage.create({ data: input });
    } catch (error) {
      this.logger.warn(`记录法律检索成本台账失败：${safeError(error)}`);
    }
  }

  private async upsertLawRecords(tx: Prisma.TransactionClient, value: BaijianLawSearchResult, fetchedAt: Date) {
    for (const record of value.records) {
      await tx.legalSourceDocument.upsert({
        where: { source_externalId: { source: record.source, externalId: record.recordId } },
        create: {
          source: record.source,
          externalId: record.recordId,
          kind: 'law',
          title: record.lawName,
          metadata: toJson(record),
          fetchedAt,
          lastVerifiedAt: fetchedAt,
        },
        update: {
          title: record.lawName,
          metadata: toJson(record),
          lastVerifiedAt: fetchedAt,
        },
      });
    }
  }

  private async upsertCaseRecords(tx: Prisma.TransactionClient, value: BaijianCaseSearchResult, fetchedAt: Date) {
    for (const record of value.records) {
      const externalId = sha256(`${record.sourceName}\u0000${record.sourceId}`);
      await tx.legalSourceDocument.upsert({
        where: { source_externalId: { source: record.source, externalId } },
        create: {
          source: record.source,
          externalId,
          kind: 'case',
          title: record.title,
          metadata: toJson(record),
          fetchedAt,
          lastVerifiedAt: fetchedAt,
        },
        update: {
          title: record.title,
          metadata: toJson(record),
          lastVerifiedAt: fetchedAt,
        },
      });
    }
  }
}

function lawDetailMetadata(value: BaijianLawDetail) {
  const { contentBlocks: _contentBlocks, toc: _toc, ...metadata } = value;
  return metadata;
}

function redactSearchRequest(value: BaijianNormalizedResult): BaijianNormalizedResult {
  return value.toolName === 'ldh_search' ? { ...value, query: null } : value;
}

function toJson(value: BaijianNormalizedToolResult | object): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return name.replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80);
}
