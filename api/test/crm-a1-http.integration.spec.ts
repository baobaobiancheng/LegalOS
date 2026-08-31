import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { CrmA1AuthService, buildCrmA1SignatureMessage } from '../src/modules/crm-integration/crm-a1-auth.service';
import { CrmContractTaskController } from '../src/modules/crm-integration/crm-contract-task.controller';
import { CrmMultipartService } from '../src/modules/crm-integration/crm-multipart.service';
import { CreateCrmContractTaskUseCase } from '../src/modules/crm-integration/create-crm-contract-task.use-case';
import { CrmA1Headers } from '../src/modules/crm-integration/crm-a1.types';

describe('CRM A1 HTTP 契约', () => {
  let app: INestApplication;
  let baseUrl: string;
  let storage: string;
  const createTask = { execute: vi.fn() };
  const nonce = { deleteMany: vi.fn(), create: vi.fn() };
  const secret = 'http-integration-secret-at-least-32-bytes';

  beforeEach(async () => {
    storage = mkdtempSync(join(tmpdir(), 'crm-http-'));
    process.env.CONTRACT_STORAGE_DIR = storage;
    createTask.execute.mockReset();
    nonce.deleteMany.mockReset();
    nonce.create.mockReset();
    const module = await Test.createTestingModule({
      controllers: [CrmContractTaskController],
      providers: [
        CrmA1AuthService,
        CrmMultipartService,
        { provide: CreateCrmContractTaskUseCase, useValue: createTask },
        { provide: PrismaService, useValue: { crmInboundNonce: nonce } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) => ({
              CRM_A1_ENABLED: 'true',
              CRM_A1_APP_ID: 'crm-legal-01',
              CRM_A1_SECRET: secret,
              CRM_A1_ALLOWED_IPS: '127.0.0.1',
            } as Record<string, string>)[key] ?? fallback,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.CONTRACT_STORAGE_DIR;
    rmSync(storage, { recursive: true, force: true });
  });

  it('完整验签、占用 nonce、校验 DTO 并返回统一成功回执', async () => {
    const payload = JSON.stringify(validPayload());
    const file = Buffer.from('合同正文', 'utf8');
    const request = signedRequest(payload, file);
    const expected = {
      code: 0,
      message: 'ok',
      data: {
        projectId: 'project-1',
        sourceAppId: 'crm-legal-01',
        crmTaskId: 'task-10086',
        contractNo: 'HT-2026-001',
        idempotencyKey: 'task-10086',
        duplicated: false,
      },
    };
    createTask.execute.mockResolvedValue(expected);

    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expected);
    expect(nonce.create).toHaveBeenCalledTimes(1);
    expect(createTask.execute).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ crmTaskId: 'task-10086', contractType: 'NORMAL' }),
      envelope: expect.objectContaining({ files: [expect.objectContaining({ originalName: '合同.txt' })] }),
    }));
  });

  it('签名不匹配时返回 401，不占用 nonce、不调用建单用例', async () => {
    const payload = JSON.stringify(validPayload());
    const request = signedRequest(payload, Buffer.from('合同正文', 'utf8'));
    request.headers['X-Signature'] = '0'.repeat(64);

    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    const body = await response.json() as any;

    expect(response.status).toBe(401);
    expect(body.code).toBe('INVALID_SIGNATURE');
    expect(nonce.create).not.toHaveBeenCalled();
    expect(createTask.execute).not.toHaveBeenCalled();
    expect(readdirSync(storage)).toEqual([]);
  });

  it('非 multipart 请求返回 415', async () => {
    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('总文件数超过 10 个返回 413，有效头部签名已占用 nonce', async () => {
    const payload = JSON.stringify(validPayload());
    const request = signedMultipartRequest(payload, Array.from({ length: 11 }, (_, index) => ({
      name: 'files',
      filename: `contract-${index}.txt`,
      content: Buffer.from(`contract-${index}`, 'utf8'),
      mimeType: 'text/plain',
    })));

    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(nonce.create).toHaveBeenCalledTimes(1);
  });

  it('空合同文件返回 422，有效头部签名已占用 nonce', async () => {
    const request = signedMultipartRequest(JSON.stringify(validPayload()), [{
      name: 'files',
      filename: 'empty.txt',
      content: Buffer.alloc(0),
      mimeType: 'text/plain',
    }]);

    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'FILE_VALIDATION_FAILED' });
    expect(nonce.create).toHaveBeenCalledTimes(1);
  });

  it('签名通过但 payload 含未知字段时返回 400，并已占用 nonce', async () => {
    const request = signedRequest(
      JSON.stringify({ ...validPayload(), unknownField: 'not-allowed' }),
      Buffer.from('合同正文', 'utf8'),
    );

    const response = await fetch(`${baseUrl}/api/crm/v1/contract-tasks`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_PARAM' });
    expect(nonce.create).toHaveBeenCalledTimes(1);
    expect(createTask.execute).not.toHaveBeenCalled();
  });

  function signedRequest(payload: string, file: Buffer) {
    return signedMultipartRequest(payload, [{
      name: 'files',
      filename: '合同.txt',
      content: file,
      mimeType: 'text/plain',
    }]);
  }

  function signedMultipartRequest(
    payload: string,
    files: Array<{ name: string; filename: string; content: Buffer; mimeType: string }>,
  ) {
    const boundary = 'crm-http-boundary';
    const indexes = new Map<string, number>();
    const manifest = files.map((file) => {
      const index = indexes.get(file.name) ?? 0;
      indexes.set(file.name, index + 1);
      return {
        partName: file.name,
        index,
        originalName: file.filename,
        size: file.content.length,
        sha256: sha(file.content),
      };
    }).sort((a, b) => a.partName.localeCompare(b.partName) || a.index - b.index);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: CrmA1Headers = {
      appId: 'crm-legal-01',
      timestamp,
      nonce: `nonce-${timestamp}`,
      idempotencyKey: 'task-10086',
      payloadSha256: sha(Buffer.from(payload, 'utf8')),
      fileManifestSha256: sha(Buffer.from(JSON.stringify(manifest), 'utf8')),
      signature: '',
    };
    headers.signature = createHmac('sha256', secret)
      .update(buildCrmA1SignatureMessage(headers))
      .digest('hex');
    return {
      body: multipart(boundary, payload, files),
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-App-Id': headers.appId,
        'X-Timestamp': String(headers.timestamp),
        'X-Nonce': headers.nonce,
        'X-Idempotency-Key': headers.idempotencyKey,
        'X-Payload-SHA256': headers.payloadSha256,
        'X-File-Manifest-SHA256': headers.fileManifestSha256,
        'X-Signature': headers.signature,
      } as Record<string, string>,
    };
  }
});

function validPayload() {
  return {
    crmTaskId: 'task-10086',
    contractNo: 'HT-2026-001',
    contractApplyType: 'NEW',
    contractType: 'NORMAL',
    currentAuditStatus: '法务审核中',
    currentAuditNode: '法务审核',
    currentNodeAssignee: 'legal.user',
    applicant: '张伟',
    customerName: '某某科技有限公司',
    signSubject: '我司',
  };
}

function multipart(
  boundary: string,
  payload: string,
  files: Array<{ name: string; filename: string; content: Buffer; mimeType: string }>,
): Buffer {
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${payload}\r\n`, 'utf8'),
  ];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
