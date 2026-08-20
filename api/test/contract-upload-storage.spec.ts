import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContractFileService } from '../src/modules/contract/contract-file.service';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

describe('ContractFileService.uploadFile staging 与文件签名', () => {
  let root: string;
  let prisma: any;
  let service: ContractFileService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legalos-upload-'));
    process.env.CONTRACT_STORAGE_DIR = root;
    prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({
        id: 'project-1', creatorId: 'business-1', ownerId: 'bp-1', legalBpId: 'bp-1', status: '待复核',
      }) },
      contractFile: { create: vi.fn().mockResolvedValue({ id: 'file-1' }) },
      projectMessage: { create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractDocument: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    };
    service = new ContractFileService(
      prisma as any,
      new ProjectAccessPolicy() as any,
    );
  });

  afterEach(() => {
    delete process.env.CONTRACT_STORAGE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('拒绝伪装成 PDF 的内容，并清理 staging 文件', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'fake.pdf');
    mkdirForTest(staging);
    writeFileSync(path, '这不是 PDF');

    await expect(service.uploadFile(
      'project-1',
      file(path, 'fake.pdf', '.pdf'),
      'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toThrow('文件内容与扩展名不匹配');

    expect(readExists(path)).toBe(false);
    expect(prisma.contractFile.create).not.toHaveBeenCalled();
  });

  it('签名通过后才从 staging 移入项目正式目录并写元数据', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'notes.txt');
    mkdirForTest(staging);
    writeFileSync(path, '合同备注');

    await service.uploadFile(
      'project-1',
      file(path, 'notes.txt', '.txt'),
      'final',
      { id: 'business-1', role: 'business' },
    );

    expect(readExists(path)).toBe(false);
    expect(readFileSync(join(root, 'project-1', 'notes.txt'), 'utf8')).toBe('合同备注');
    expect(prisma.contractFile.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: 'project-1', storedName: 'notes.txt' }),
    }));
  });
});

function mkdirForTest(path: string) {
  mkdirSync(path, { recursive: true });
}

function readExists(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function file(path: string, originalname: string, ext: string): Express.Multer.File {
  return {
    path,
    filename: originalname,
    originalname,
    mimetype: ext === '.txt' ? 'text/plain' : 'application/octet-stream',
    size: 16,
    destination: join(path, '..'),
    fieldname: 'file',
    encoding: '7bit',
    stream: undefined as any,
    buffer: undefined as any,
  };
}
