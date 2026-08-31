import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractFileProcessor } from '../src/modules/contract/application/contract-file.processor';
import {
  buildReviewBundle,
  CreateCrmContractTaskUseCase,
} from '../src/modules/crm-integration/create-crm-contract-task.use-case';
import { CrmA1Headers, CrmMultipartEnvelope, CrmReceivedFile } from '../src/modules/crm-integration/crm-a1.types';
import { CrmContractTaskPayloadDto } from '../src/modules/crm-integration/dto/crm-contract-task.dto';

describe('CreateCrmContractTaskUseCase', () => {
  let root: string;
  let prisma: any;
  let tx: any;
  let audit: any;
  let service: CreateCrmContractTaskUseCase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crm-create-'));
    process.env.CONTRACT_STORAGE_DIR = root;
    tx = {
      project: { create: vi.fn() },
      projectMessage: { create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractFile: { createMany: vi.fn() },
      contractDocument: { create: vi.fn() },
    };
    prisma = {
      project: { findFirst: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'legal-1', role: 'legal_bp', isActive: true }) },
      $transaction: vi.fn(async (callback: (writer: any) => unknown) => callback(tx)),
    };
    audit = { record: vi.fn() };
    service = new CreateCrmContractTaskUseCase(prisma, new ContractFileProcessor(), audit);
  });

  afterEach(() => {
    delete process.env.CONTRACT_STORAGE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('将 CAS 处理人映射为 creator/owner/legalBp，并一次落库原文件与 source 审查包', async () => {
    const input = taskInput([
      stagedFile('files', 0, 'contract.txt', '待审合同'),
      stagedFile('mainContractFile', 0, 'main.md', '# 主合同'),
      stagedFile('attachments', 0, 'notes.txt', '参考说明'),
    ]);

    const result = await service.execute(input);

    expect(result).toMatchObject({ code: 0, data: { duplicated: false, crmTaskId: 'task-10086' } });
    const projectId = result.data.projectId;
    expect(statSync(join(root, projectId)).mode & 0o777).toBe(0o700);
    for (const file of input.envelope.files) {
      expect(statSync(join(root, projectId, file.storedName)).mode & 0o777).toBe(0o600);
    }
    expect(tx.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'contract',
        status: '待复核',
        risk: 'P1',
        route: 'legalbp',
        creatorId: 'legal-1',
        ownerId: 'legal-1',
        legalBpId: 'legal-1',
        requesterName: '张伟',
        crmCustomer: '某某科技有限公司',
        extra: expect.objectContaining({ crm: expect.objectContaining({ mainContractUrl: 'https://crm.example/main' }) }),
      }),
    }));
    expect(tx.contractFile.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: 'source' }),
        expect.objectContaining({ kind: 'main_contract' }),
        expect.objectContaining({ kind: 'attachment' }),
      ]),
    });
    expect(tx.contractDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentType: 'source',
        content: expect.stringMatching(/待审核合同[\s\S]*主合同[\s\S]*参考附件/),
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'external', id: 'crm-legal-01', role: 'crm' },
      action: 'crm.contract_task.ingest',
      outcome: 'success',
    }), tx);
  });

  it('同一任务指纹一致时在抽取和人员查询前直接幂等返回', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'existing-project',
      crmPayloadSha256: 'a'.repeat(64),
      crmFileManifestSha256: 'b'.repeat(64),
    });
    const missingFile = fileDescriptor('files', 0, 'missing.txt', '/does/not/exist', 'c'.repeat(64), 1);

    await expect(service.execute(taskInput([missingFile]))).resolves.toMatchObject({
      data: { projectId: 'existing-project', duplicated: true },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('同一任务指纹不一致返回 IDEMPOTENCY_CONFLICT', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'existing-project',
      crmPayloadSha256: 'f'.repeat(64),
      crmFileManifestSha256: 'b'.repeat(64),
    });
    await expect(service.execute(taskInput([]))).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    });
  });

  it('处理人不存在或非法务角色时拒绝建单', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'business-1', role: 'business', isActive: true });
    await expect(service.execute(taskInput([
      stagedFile('files', 0, 'contract.txt', '合同'),
    ]))).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'ASSIGNEE_INVALID' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('补充协议缺少主合同编号、文件和链接时返回 INCOMPLETE_DATA', async () => {
    const input = taskInput([stagedFile('files', 0, 'supplement.txt', '补充协议')]);
    input.payload.contractType = 'SUPPLEMENT';
    input.payload.mainContractUrl = undefined;
    await expect(service.execute(input)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'INCOMPLETE_DATA' }),
    });
  });

  it('拒绝重复文件指纹和超过十万字符的审查包', async () => {
    const first = stagedFile('files', 0, 'a.txt', 'same');
    const second = stagedFile('attachments', 0, 'b.txt', 'same');
    await expect(service.execute(taskInput([first, second]))).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'FILE_VALIDATION_FAILED' }),
    });

    const tooLong = stagedFile('files', 0, 'long.txt', 'x'.repeat(100_001));
    await expect(service.execute(taskInput([tooLong]))).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'FILE_VALIDATION_FAILED' }),
    });
  });

  it('数据库落库失败时清理已移入正式目录的文件', async () => {
    prisma.$transaction.mockRejectedValue(new Error('db down'));
    const input = taskInput([stagedFile('files', 0, 'contract.txt', '合同')]);
    await expect(service.execute(input)).rejects.toThrow('db down');
    expect(readdirSync(root)).toEqual(['staging']);
  });

  it('合并审查包固定为 files → mainContractFile → attachments', () => {
    const bundle = buildReviewBundle([
      { ...fileDescriptor('attachments', 0, 'a.txt', '', 'a', 1), extractedText: 'A' },
      { ...fileDescriptor('files', 0, 'f.txt', '', 'b', 1), extractedText: 'F' },
      { ...fileDescriptor('mainContractFile', 0, 'm.txt', '', 'c', 1), extractedText: 'M' },
    ] as any);
    expect(bundle.indexOf('待审核合同')).toBeLessThan(bundle.indexOf('主合同'));
    expect(bundle.indexOf('主合同')).toBeLessThan(bundle.indexOf('参考附件'));
  });

  function taskInput(files: CrmReceivedFile[]) {
    const headers: CrmA1Headers = {
      appId: 'crm-legal-01',
      timestamp: 1_725_000_000,
      nonce: 'nonce-12345678',
      idempotencyKey: 'task-10086',
      payloadSha256: 'a'.repeat(64),
      fileManifestSha256: 'b'.repeat(64),
      signature: 'c'.repeat(64),
    };
    const envelope: CrmMultipartEnvelope = {
      payloadText: '{}',
      payloadSha256: headers.payloadSha256,
      fileManifestSha256: headers.fileManifestSha256,
      fileManifest: [],
      files,
      stagingDir: join(root, 'staging'),
    };
    return { headers, payload: payload(), envelope };
  }

  function stagedFile(partName: any, index: number, originalName: string, content: string): CrmReceivedFile {
    const dir = join(root, 'staging');
    mkdirSync(dir, { recursive: true });
    const storedName = `${partName}-${index}-${originalName}`;
    const path = join(dir, storedName);
    writeFileSync(path, content, 'utf8');
    return fileDescriptor(partName, index, originalName, path, sha(content), Buffer.byteLength(content));
  }
});

function payload(): CrmContractTaskPayloadDto {
  return Object.assign(new CrmContractTaskPayloadDto(), {
    crmTaskId: 'task-10086',
    contractNo: 'HT-2026-001',
    contractApplyType: 'NEW',
    contractType: 'NORMAL',
    currentAuditStatus: '法务审核中',
    currentAuditNode: '法务审核',
    currentNodeAssignee: 'Legal.User',
    applicant: '张伟',
    customerName: '某某科技有限公司',
    signSubject: '我司',
    mainContractUrl: 'https://crm.example/main',
  });
}

function fileDescriptor(
  partName: any,
  index: number,
  originalName: string,
  path: string,
  sha256: string,
  size: number,
): CrmReceivedFile {
  return {
    partName,
    index,
    originalName,
    path,
    sha256,
    size,
    mimeType: 'text/plain',
    storedName: `${partName}-${index}-${originalName}`,
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
