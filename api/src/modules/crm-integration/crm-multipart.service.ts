import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Request } from 'express';
import Busboy from 'busboy';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crmA1Error } from './crm-a1.errors';
import {
  CRM_A1_MAX_ATTACHMENTS,
  CRM_A1_MAX_FILE_BYTES,
  CRM_A1_MAX_FILES,
  CRM_A1_MAX_REQUEST_BYTES,
  CrmFileManifestItem,
  CrmFilePartName,
  CrmMultipartEnvelope,
  CrmReceivedFile,
} from './crm-a1.types';

const ALLOWED_FILE_PARTS = new Set<CrmFilePartName>(['files', 'attachments', 'mainContractFile']);
const STORAGE_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EEXIST',
  'EFBIG',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

@Injectable()
export class CrmMultipartService {
  private readonly storageDir = process.env.CONTRACT_STORAGE_DIR
    || join(process.cwd(), 'storage', 'contracts');

  async parse(request: Request): Promise<CrmMultipartEnvelope> {
    const stagingDir = join(this.storageDir, '.staging', `crm-${randomUUID()}`);
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    chmodSync(stagingDir, 0o700);
    try {
      return await this.parseInto(request, stagingDir);
    } catch (error) {
      this.cleanupDirectory(stagingDir);
      throw normalizeMultipartParseError(error);
    }
  }

  cleanup(envelope: Pick<CrmMultipartEnvelope, 'stagingDir'>): void {
    this.cleanupDirectory(envelope.stagingDir);
  }

  private async parseInto(request: Request, stagingDir: string): Promise<CrmMultipartEnvelope> {
    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({
        headers: request.headers,
        defCharset: 'utf8',
        defParamCharset: 'utf8',
        preservePath: false,
        limits: {
          files: CRM_A1_MAX_FILES,
          fileSize: CRM_A1_MAX_FILE_BYTES,
          fields: 1,
          fieldSize: 2 * 1024 * 1024,
          parts: CRM_A1_MAX_FILES + 1,
        },
      });
    } catch {
      throw crmA1Error(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必须是 multipart/form-data');
    }

    let payloadText: string | null = null;
    let parseError: HttpException | null = null;
    const files: CrmReceivedFile[] = [];
    const writes: Promise<void>[] = [];
    const indexes: Record<CrmFilePartName, number> = { files: 0, attachments: 0, mainContractFile: 0 };

    const rememberError = (error: HttpException) => { parseError ??= error; };
    busboy.on('field', (name, value, info) => {
      if (name !== 'payload' || payloadText !== null) {
        rememberError(crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'multipart 必须且只能包含一个 payload 字段'));
        return;
      }
      if (info.valueTruncated) {
        rememberError(crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'payload 超过大小限制'));
        return;
      }
      if (info.mimeType.toLowerCase() !== 'application/json') {
        rememberError(crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'payload part 的 Content-Type 必须是 application/json'));
        return;
      }
      payloadText = value;
    });

    busboy.on('file', (name, stream, info) => {
      if (!ALLOWED_FILE_PARTS.has(name as CrmFilePartName)) {
        rememberError(crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', `不支持的文件 part: ${name}`));
        stream.resume();
        return;
      }
      const partName = name as CrmFilePartName;
      const index = indexes[partName]++;
      const originalName = info.filename;
      if (!originalName || unicodeLength(originalName) > 128 || /[\0\r\n]/.test(originalName)) {
        rememberError(crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', '文件名必须是 1..128 个字符且不得包含控制字符'));
        stream.resume();
        return;
      }
      const storedName = `${randomUUID()}${extname(originalName).toLowerCase()}`;
      const targetPath = join(stagingDir, storedName);
      const hash = createHash('sha256');
      let size = 0;
      let truncated = false;
      stream.on('limit', () => { truncated = true; });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      });
      writes.push(
        pipeline(stream, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 })).then(() => {
          if (truncated) {
            rememberError(crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', '单文件超过 20MB 限制'));
            return;
          }
          files.push({
            partName,
            index,
            originalName,
            mimeType: info.mimeType,
            size,
            sha256: hash.digest('hex'),
            storedName,
            path: targetPath,
          });
        }),
      );
    });

    busboy.on('filesLimit', () => rememberError(
      crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', '总文件数超过 10 个'),
    ));
    busboy.on('fieldsLimit', () => rememberError(
      crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'multipart 只允许一个 payload 字段'),
    ));
    busboy.on('partsLimit', () => rememberError(
      crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'multipart part 数量超过限制'),
    ));

    const counter = createRequestSizeCounter();

    let requestError: unknown;
    try {
      await pipeline(request, counter, busboy);
    } catch (error) {
      requestError = error;
    }
    const writeResults = await Promise.allSettled(writes);
    if (requestError) throw requestError;
    const rejectedWrite = writeResults.find((result) => result.status === 'rejected');
    if (rejectedWrite?.status === 'rejected') throw rejectedWrite.reason;
    if (parseError) throw parseError;
    if (payloadText === null) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', '缺少 payload 字段');
    }
    if (indexes.files < 1) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', '至少上传一个 files 文件');
    }
    if (indexes.attachments > CRM_A1_MAX_ATTACHMENTS) {
      throw crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'attachments 最多 5 个');
    }
    if (indexes.mainContractFile > 1) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'mainContractFile 最多一个');
    }
    if (files.some((file) => file.size === 0)) {
      throw crmA1Error(HttpStatus.UNPROCESSABLE_ENTITY, 'FILE_VALIDATION_FAILED', '不允许上传空文件');
    }

    const fileManifest = buildFileManifest(files);
    const manifestJson = JSON.stringify(fileManifest);
    return {
      payloadText,
      payloadSha256: createHash('sha256').update(Buffer.from(payloadText, 'utf8')).digest('hex'),
      fileManifest,
      fileManifestSha256: createHash('sha256').update(Buffer.from(manifestJson, 'utf8')).digest('hex'),
      files: files.sort(compareFiles),
      stagingDir,
    };
  }

  private cleanupDirectory(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }
}

export function normalizeMultipartParseError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  const code = typeof error === 'object' && error !== null
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
  if (STORAGE_ERROR_CODES.has(code)) {
    return crmA1Error(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      '合同文件暂存失败，请稍后重试',
    );
  }
  return crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', '无法解析 multipart 请求');
}

/** 即使请求使用 chunked encoding 且没有 Content-Length，也按实际流量中止。 */
export function createRequestSizeCounter(maxBytes = CRM_A1_MAX_REQUEST_BYTES): Transform {
  let requestBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      requestBytes += chunk.length;
      if (requestBytes > maxBytes) {
        callback(crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', '请求总大小超过 100MB'));
        return;
      }
      callback(null, chunk);
    },
  });
}

export function buildFileManifest(files: CrmReceivedFile[]): CrmFileManifestItem[] {
  return files
    .slice()
    .sort(compareFiles)
    .map(({ partName, index, originalName, size, sha256 }) => ({
      partName,
      index,
      originalName,
      size,
      sha256,
    }));
}

function compareFiles(a: Pick<CrmReceivedFile, 'partName' | 'index'>, b: Pick<CrmReceivedFile, 'partName' | 'index'>): number {
  if (a.partName === b.partName) return a.index - b.index;
  return a.partName < b.partName ? -1 : 1;
}

function unicodeLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}
