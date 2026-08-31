import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ContractFileKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AuditService } from '../../common/audit/audit.service';
import { AuditRequestContext } from '../../common/audit/audit.types';
import { formatEventTime } from '../../common/utils/event-time';
import { ContractFileProcessor } from '../contract/application/contract-file.processor';
import { crmTaskIdempotencyKey } from '../project/application/create-project.use-case';
import { PrismaService } from '../../prisma/prisma.service';
import { crmA1Error } from './crm-a1.errors';
import {
  CRM_A1_MAX_REVIEW_CHARS,
  CrmA1Headers,
  CrmFilePartName,
  CrmMultipartEnvelope,
  CrmReceivedFile,
} from './crm-a1.types';
import { CrmContractTaskPayloadDto } from './dto/crm-contract-task.dto';

interface PreparedCrmFile extends CrmReceivedFile {
  extractedText: string;
}

interface ExecuteCrmTaskInput {
  headers: CrmA1Headers;
  payload: CrmContractTaskPayloadDto;
  envelope: CrmMultipartEnvelope;
  request?: AuditRequestContext;
}

@Injectable()
export class CreateCrmContractTaskUseCase {
  private readonly storageDir = process.env.CONTRACT_STORAGE_DIR
    || join(process.cwd(), 'storage', 'contracts');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContractFileProcessor) private readonly fileProcessor: ContractFileProcessor,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async execute(input: ExecuteCrmTaskInput) {
    const { headers, payload, envelope } = input;
    if (payload.crmTaskId !== headers.idempotencyKey) {
      throw crmA1Error(
        HttpStatus.BAD_REQUEST,
        'INVALID_PARAM',
        'X-Idempotency-Key 必须与 payload.crmTaskId 一致',
      );
    }

    const existing = await this.findExisting(headers.appId, payload.crmTaskId);
    if (existing) {
      this.assertReplayConsistency(existing, headers);
      return this.success(existing.id, headers, payload.contractNo, true);
    }

    const mainContractFiles = envelope.files.filter((file) => file.partName === 'mainContractFile');
    if (payload.contractType === 'SUPPLEMENT'
      && !payload.mainContractNo
      && !payload.mainContractUrl
      && mainContractFiles.length === 0) {
      throw crmA1Error(
        HttpStatus.CONFLICT,
        'INCOMPLETE_DATA',
        '补充协议必须提供 mainContractNo、mainContractFile 或 mainContractUrl 之一',
      );
    }
    this.assertNoDuplicateFiles(envelope.files);

    const assignee = await this.prisma.user.findUnique({
      where: { casUsername: payload.currentNodeAssignee.trim().toLowerCase() },
      select: { id: true, role: true, isActive: true },
    });
    if (!assignee?.isActive || !['legal_bp', 'legal_lead', 'admin'].includes(assignee.role)) {
      throw crmA1Error(
        HttpStatus.CONFLICT,
        'ASSIGNEE_INVALID',
        'currentNodeAssignee 未在 LegalOS 开通或不是可指派的法务角色',
      );
    }

    const preparedFiles = await this.prepareFiles(envelope.files);
    const extractedChars = preparedFiles.reduce(
      (sum, file) => sum + unicodeLength(file.extractedText),
      0,
    );
    if (extractedChars > CRM_A1_MAX_REVIEW_CHARS) {
      throw crmA1Error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'FILE_VALIDATION_FAILED',
        '合并审查包抽取正文超过 100,000 个 Unicode 字符',
      );
    }
    const reviewBundle = buildReviewBundle(preparedFiles);

    const projectId = randomUUID();
    const projectDir = join(this.storageDir, projectId);
    try {
      mkdirSync(projectDir, { recursive: false, mode: 0o700 });
      chmodSync(projectDir, 0o700);
      for (const file of preparedFiles) {
        const finalPath = join(projectDir, file.storedName);
        renameSync(file.path, finalPath);
        chmodSync(finalPath, 0o600);
      }
    } catch {
      this.cleanupProjectDirectory(projectDir);
      throw crmA1Error(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', '合同文件保存失败');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.project.create({
          data: {
            id: projectId,
            idempotencyKey: crmTaskIdempotencyKey(headers.appId, payload.crmTaskId),
            kind: 'contract',
            title: `合同审核·${payload.contractNo}`,
            status: '待复核',
            risk: 'P1',
            route: 'legalbp',
            creatorId: assignee.id,
            ownerId: assignee.id,
            legalBpId: assignee.id,
            requesterName: payload.applicant,
            sourceAppId: headers.appId,
            crmTaskId: payload.crmTaskId,
            contractNo: payload.contractNo,
            crmPayloadSha256: headers.payloadSha256,
            crmFileManifestSha256: headers.fileManifestSha256,
            crmReference: payload.contractNo,
            crmCustomer: payload.customerName,
            extra: crmExtra(payload),
          },
        });
        await tx.projectMessage.create({
          data: {
            projectId,
            role: 'user',
            label: 'CRM 建单信息',
            text: buildProjectSummary(payload, preparedFiles.length),
          },
        });
        await tx.projectEvent.create({
          data: {
            projectId,
            text: formatEventTime() + ' · CRM 合同审核任务已验签建单',
          },
        });
        await tx.contractFile.createMany({
          data: preparedFiles.map((file) => ({
            projectId,
            kind: contractFileKind(file.partName),
            originalName: file.originalName,
            storedName: file.storedName,
            mimeType: file.mimeType || null,
            size: file.size,
            uploadedBy: assignee.id,
          })),
        });
        await tx.contractDocument.create({
          data: {
            projectId,
            documentType: 'source',
            version: 1,
            content: reviewBundle,
            sourceFileId: null,
            createdBy: assignee.id,
          },
        });
        await this.audit.record({
          actor: { type: 'external', id: headers.appId, role: 'crm' },
          action: 'crm.contract_task.ingest',
          resourceType: 'project',
          resourceId: projectId,
          projectId,
          source: 'api',
          outcome: 'success',
          correlationId: payload.crmTaskId,
          request: input.request,
          metadata: {
            sourceAppId: headers.appId,
            crmTaskId: payload.crmTaskId,
            contractNo: payload.contractNo,
            fileCount: preparedFiles.length,
            payloadSha256: headers.payloadSha256,
            fileManifestSha256: headers.fileManifestSha256,
          },
          retentionClass: 'business',
        }, tx);
      });
      return this.success(projectId, headers, payload.contractNo, false);
    } catch (error: any) {
      this.cleanupProjectDirectory(projectDir);
      if (error?.code === 'P2002') {
        const concurrent = await this.findExisting(headers.appId, payload.crmTaskId);
        if (concurrent) {
          this.assertReplayConsistency(concurrent, headers);
          return this.success(concurrent.id, headers, payload.contractNo, true);
        }
      }
      throw error;
    }
  }

  private async prepareFiles(files: CrmReceivedFile[]): Promise<PreparedCrmFile[]> {
    const prepared: PreparedCrmFile[] = [];
    for (const file of files.slice().sort(semanticFileOrder)) {
      const processed = await this.fileProcessor.validateAndExtract(file.path, file.originalName);
      prepared.push({ ...file, extractedText: processed.text });
    }
    return prepared;
  }

  private async findExisting(sourceAppId: string, crmTaskId: string): Promise<any | null> {
    return this.prisma.project.findFirst({ where: { sourceAppId, crmTaskId } });
  }

  private assertReplayConsistency(project: any, headers: CrmA1Headers): void {
    if (project.crmPayloadSha256 !== headers.payloadSha256
      || project.crmFileManifestSha256 !== headers.fileManifestSha256) {
      throw crmA1Error(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_CONFLICT',
        '同一 CRM 审核任务的请求内容与首次建单不一致',
      );
    }
  }

  private assertNoDuplicateFiles(files: CrmReceivedFile[]): void {
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.sha256)) {
        throw crmA1Error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'FILE_VALIDATION_FAILED',
          '同一请求不允许重复上传内容完全相同的文件',
        );
      }
      seen.add(file.sha256);
    }
  }

  private cleanupProjectDirectory(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  private success(
    projectId: string,
    headers: CrmA1Headers,
    contractNo: string,
    duplicated: boolean,
  ) {
    return {
      code: 0,
      message: 'ok',
      data: {
        projectId,
        sourceAppId: headers.appId,
        crmTaskId: headers.idempotencyKey,
        contractNo,
        idempotencyKey: headers.idempotencyKey,
        duplicated,
      },
    };
  }
}

function contractFileKind(partName: CrmFilePartName): ContractFileKind {
  if (partName === 'files') return ContractFileKind.source;
  if (partName === 'attachments') return ContractFileKind.attachment;
  return ContractFileKind.main_contract;
}

function semanticFileOrder(a: CrmReceivedFile, b: CrmReceivedFile): number {
  const order: Record<CrmFilePartName, number> = { files: 0, mainContractFile: 1, attachments: 2 };
  return order[a.partName] - order[b.partName] || a.index - b.index;
}

export function buildReviewBundle(files: PreparedCrmFile[]): string {
  const labels: Record<CrmFilePartName, string> = {
    files: '待审核合同',
    mainContractFile: '主合同',
    attachments: '参考附件',
  };
  return files
    .slice()
    .sort(semanticFileOrder)
    .map((file) => [
      `===== ${labels[file.partName]} ${file.index + 1}：${file.originalName} =====`,
      file.extractedText,
    ].join('\n'))
    .join('\n\n');
}

function crmExtra(payload: CrmContractTaskPayloadDto): Prisma.InputJsonValue {
  return {
    crm: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
  };
}

function buildProjectSummary(payload: CrmContractTaskPayloadDto, fileCount: number): string {
  return [
    `CRM 审核任务：${payload.crmTaskId}`,
    `合同编号：${payload.contractNo}`,
    `客户主体：${payload.customerName}`,
    `签约主体：${payload.signSubject}`,
    `申请人：${payload.applicant}`,
    `待审文件：${fileCount} 个`,
  ].join('\n');
}

function unicodeLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}
