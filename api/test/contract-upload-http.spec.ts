import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { ContractService } from '../src/modules/contract/contract.service';
import { ContractFileService } from '../src/modules/contract/contract-file.service';
import { ContractTemplateService } from '../src/modules/contract/contract-template.service';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

describe('合同上传 HTTP：对象授权必须先于 multipart 落盘', () => {
  const projectId = '28b516b9-5006-4364-9987-5d9f71ed0401';
  let app: INestApplication;
  let storage: string;
  let baseUrl: string;
  let previousStorage: string | undefined;
  const findUnique = vi.fn();
  const uploadFile = vi.fn();

  beforeAll(async () => {
    previousStorage = process.env.CONTRACT_STORAGE_DIR;
    storage = mkdtempSync(join(tmpdir(), 'contract-http-'));
    process.env.CONTRACT_STORAGE_DIR = storage;
    const { ContractController } = await import('../src/modules/contract/contract.controller');
    // Vitest 不生成构造器元数据；模拟 tsc 的 DI 元数据，使用真实控制器/拦截器。
    Reflect.defineMetadata('design:paramtypes', [ContractService, ContractFileService, ContractTemplateService], ContractController);
    const module = await Test.createTestingModule({
      controllers: [ContractController],
      providers: [
        { provide: ContractService, useValue: {} },
        { provide: ContractFileService, useValue: { uploadFile } },
        { provide: ContractTemplateService, useValue: {} },
        { provide: PrismaService, useValue: { project: { findUnique } } },
        ProjectAccessPolicy,
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'biz-1', role: 'business' };
      next();
    });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ id: projectId, creatorId: 'biz-1', legalBpId: 'bp-1', ownerId: 'bp-1' });
    uploadFile.mockReset().mockImplementation(async (_id: string, file: Express.Multer.File) => {
      unlinkSync(file.path);
      return { fileId: 'file-1' };
    });
    for (const entry of readdirSync(storage)) rmSync(join(storage, entry), { recursive: true, force: true });
  });

  afterAll(async () => {
    await app?.close();
    if (previousStorage === undefined) delete process.env.CONTRACT_STORAGE_DIR;
    else process.env.CONTRACT_STORAGE_DIR = previousStorage;
    rmSync(storage, { recursive: true, force: true });
  });

  async function upload(id = projectId) {
    const body = new FormData();
    body.set('kind', 'final');
    body.set('file', new Blob(['合同原文']), 'contract.txt');
    return fetch(`${baseUrl}/projects/${id}/files`, { method: 'POST', body });
  }

  it.each([
    ['非法 ID', 'not-a-uuid', undefined, 400],
    ['不存在', projectId, null, 404],
    ['无权', projectId, { id: projectId, creatorId: 'biz-2', legalBpId: 'bp-1', ownerId: 'bp-1' }, 403],
  ])('%s 请求不会创建 staging', async (_label, id, project, status) => {
    findUnique.mockResolvedValue(project);
    const response = await upload(id);
    expect(response.status).toBe(status);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(readdirSync(storage)).toEqual([]);
    if (status === 400) expect(findUnique).not.toHaveBeenCalled();
  });

  it('有权用户正常上传', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledWith({ where: { id: projectId } });
  });
});
