import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import {
  createRequestSizeCounter,
  CrmMultipartService,
  normalizeMultipartParseError,
} from '../src/modules/crm-integration/crm-multipart.service';

describe('CRM A1 multipart 流式解析', () => {
  let root: string;
  let service: CrmMultipartService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crm-multipart-'));
    process.env.CONTRACT_STORAGE_DIR = root;
    service = new CrmMultipartService();
  });

  afterEach(() => {
    delete process.env.CONTRACT_STORAGE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('保留 UTF-8 文件名、part 内顺序并生成固定键顺序 manifest', async () => {
    const payload = JSON.stringify({ crmTaskId: 'task-1' });
    const body = multipart('boundary-a', payload, [
      { name: 'files', filename: '合同正文.txt', content: '合同一' },
      { name: 'attachments', filename: '附件.md', content: '# 说明' },
      { name: 'files', filename: '合同二.txt', content: '合同二' },
    ]);
    const result = await service.parse(request(body, 'boundary-a'));

    expect(statSync(result.stagingDir).mode & 0o777).toBe(0o700);
    for (const file of result.files) {
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
    }
    expect(result.payloadText).toBe(payload);
    expect(result.payloadSha256).toBe(sha(payload));
    expect(result.fileManifest).toEqual([
      expect.objectContaining({ partName: 'attachments', index: 0, originalName: '附件.md' }),
      expect.objectContaining({ partName: 'files', index: 0, originalName: '合同正文.txt' }),
      expect.objectContaining({ partName: 'files', index: 1, originalName: '合同二.txt' }),
    ]);
    const canonical = JSON.stringify(result.fileManifest);
    expect(result.fileManifestSha256).toBe(sha(canonical));
    expect(canonical).toContain('{"partName":"attachments","index":0,"originalName":"附件.md","size"');
    service.cleanup(result);
  });

  it('拒绝空文件和超过 5 个 attachments，并清理 staging', async () => {
    const empty = multipart('boundary-b', '{}', [
      { name: 'files', filename: 'empty.txt', content: '' },
    ]);
    await expect(service.parse(request(empty, 'boundary-b'))).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'FILE_VALIDATION_FAILED' }),
    });

    const tooMany = multipart('boundary-c', '{}', [
      { name: 'files', filename: 'main.txt', content: 'main' },
      ...Array.from({ length: 6 }, (_, index) => ({
        name: 'attachments', filename: `a${index}.txt`, content: `a${index}`,
      })),
    ]);
    await expect(service.parse(request(tooMany, 'boundary-c'))).rejects.toMatchObject({
      status: 413,
      response: expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    });
  });

  it('在没有 Content-Length 的 chunked 流超过实际总字节限制时中止', async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await expect(pipeline(
      Readable.from([Buffer.alloc(5), Buffer.alloc(4)]),
      createRequestSizeCounter(8),
      sink,
    )).rejects.toMatchObject({
      status: 413,
      response: expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    });
  });

  it('将 staging 写盘故障保留为可重试 500，不误报为客户端 400', () => {
    const storageError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const malformedRequest = new Error('Unexpected end of form');

    expect(normalizeMultipartParseError(storageError)).toMatchObject({
      status: 500,
      response: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    });
    expect(normalizeMultipartParseError(malformedRequest)).toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'INVALID_PARAM' }),
    });
  });

  it('慢请求中写盘提前失败不产生 unhandledRejection，并清理 staging', async () => {
    const diskError = Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    class FailingCrmMultipartService extends CrmMultipartService {
      protected override openStagingWriteStream(): Writable {
        return new Writable({
          write(_chunk, _encoding, callback) { callback(diskError); },
        });
      }
    }
    service = new FailingCrmMultipartService();
    const body = multipart('boundary-slow', '{}', [
      { name: 'files', filename: 'main.txt', content: 'contract body' },
    ]);
    const splitAt = body.indexOf(Buffer.from('contract body')) + 2;
    const stream = Readable.from((async function* () {
      yield body.subarray(0, splitAt);
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield body.subarray(splitAt);
    })()) as any;
    stream.headers = { 'content-type': 'multipart/form-data; boundary=boundary-slow' };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(service.parse(stream)).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(readdirSync(join(root, '.staging'))).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  function request(body: Buffer, boundary: string): any {
    const stream = Readable.from([body]) as any;
    stream.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    return stream;
  }
});

function multipart(
  boundary: string,
  payload: string,
  files: Array<{ name: string; filename: string; content: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  const push = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="payload"\r\n');
  push('Content-Type: application/json; charset=UTF-8\r\n\r\n');
  push(payload);
  push('\r\n');
  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`);
    push('Content-Type: text/plain\r\n\r\n');
    push(file.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

function sha(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}
