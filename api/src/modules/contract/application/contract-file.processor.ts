import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export const CONTRACT_FILE_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md'] as const;
export const DOCX_MAX_ENTRIES = 1_000;
export const DOCX_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const DOCX_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export interface ProcessedContractFile {
  ext: string;
  text: string;
}

interface ContractFileWorkerResponse {
  ok: boolean;
  result?: ProcessedContractFile;
  validationError?: string;
  internalError?: string;
}

/**
 * 合同文件的纯输入处理器：不查权、不落库、不移动文件。
 * 现有单文件上传与 CRM A1 共用同一套文件头校验和正文抽取逻辑。
 */
@Injectable()
export class ContractFileProcessor {
  private readonly workerPath = join(__dirname, 'contract-file.worker.js');
  private readonly maxWorkers = boundedWorkerCount(process.env.CONTRACT_FILE_PARSE_CONCURRENCY);
  private activeWorkers = 0;
  private readonly waiters: Array<() => void> = [];

  async validateAndExtract(filePath: string, originalName: string): Promise<ProcessedContractFile> {
    const ext = extname(originalName).toLowerCase();
    if (!CONTRACT_FILE_EXTENSIONS.includes(ext as (typeof CONTRACT_FILE_EXTENSIONS)[number])) {
      throw fileValidationError('不支持的文件类型，仅支持 .docx/.pdf/.txt/.md');
    }
    // 生产构建会同时生成 worker.js；Vitest/ts-node 源码模式使用同一纯函数回退。
    if (!existsSync(this.workerPath)) return processContractFileInline(filePath, originalName);
    await this.acquireWorkerSlot();
    try {
      return await this.runWorker(filePath, originalName);
    } finally {
      this.releaseWorkerSlot();
    }
  }

  private async acquireWorkerSlot(): Promise<void> {
    if (this.activeWorkers < this.maxWorkers) {
      this.activeWorkers += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activeWorkers += 1;
  }

  private releaseWorkerSlot(): void {
    this.activeWorkers -= 1;
    this.waiters.shift()?.();
  }

  private runWorker(filePath: string, originalName: string): Promise<ProcessedContractFile> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: { filePath, originalName } });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      worker.once('message', (message: ContractFileWorkerResponse) => {
        if (settled) return;
        settled = true;
        if (message.ok && message.result) resolve(message.result);
        else if (message.validationError) reject(fileValidationError(message.validationError));
        else reject(new Error(message.internalError || '合同文件解析 Worker 失败'));
      });
      worker.once('error', () => fail(new Error('合同文件解析 Worker 失败')));
      worker.once('exit', (code) => {
        if (code !== 0) fail(new Error('合同文件解析 Worker 异常退出'));
      });
    });
  }
}

export async function processContractFileInline(
  filePath: string,
  originalName: string,
): Promise<ProcessedContractFile> {
  const ext = extname(originalName).toLowerCase();
  if (!CONTRACT_FILE_EXTENSIONS.includes(ext as (typeof CONTRACT_FILE_EXTENSIONS)[number])) {
    throw fileValidationError('不支持的文件类型，仅支持 .docx/.pdf/.txt/.md');
  }
  await assertFileSignature(filePath, ext);
  if (ext === '.docx') await assertDocxArchiveSafe(filePath);
  return { ext, text: await extractReviewableText(filePath, ext) };
}

/**
 * JSZip 的 nodeStream 按块解压，避免为了检查大小先把整个 entry 放入内存。
 * 同时限制 entry 数、单 entry 与总解压字节，阻断高压缩比 DOCX 消耗进程内存。
 */
async function assertDocxArchiveSafe(filePath: string): Promise<void> {
  // 读取失败属于服务端存储故障，应保留为 5xx；只有 ZIP 结构/加密问题属于 422。
  const archiveBytes = await readFile(filePath);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(archiveBytes, { createFolders: false });
  } catch {
    throw fileValidationError('DOCX 压缩包损坏或已加密');
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > DOCX_MAX_ENTRIES) {
    throw fileValidationError(`DOCX 内部文件数超过 ${DOCX_MAX_ENTRIES} 个限制`);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    let entryBytes = 0;
    const stream = entry.nodeStream('nodebuffer');
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        entryBytes += chunk.length;
        totalBytes += chunk.length;
        if (entryBytes > DOCX_MAX_ENTRY_BYTES || totalBytes > DOCX_MAX_UNCOMPRESSED_BYTES) {
          throw fileValidationError('DOCX 解压后内容超过安全限制');
        }
      }
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw fileValidationError('DOCX 压缩包损坏或无法安全解压');
    }
  }
}

async function assertFileSignature(filePath: string, ext: string): Promise<void> {
  const handle = await open(filePath, 'r');
  const buffer = Buffer.alloc(4096);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
  } finally {
    await handle.close();
  }
  const sample = buffer.subarray(0, bytesRead);
  const isPdf = sample.subarray(0, 5).toString('ascii') === '%PDF-';
  const isZip = sample.length >= 4
    && sample[0] === 0x50
    && sample[1] === 0x4b
    && (sample[2] === 0x03 || sample[2] === 0x05 || sample[2] === 0x07)
    && (sample[3] === 0x04 || sample[3] === 0x06 || sample[3] === 0x08);
  const hasNul = sample.includes(0);

  const valid = ext === '.pdf'
    ? isPdf
    : ext === '.docx'
      ? isZip
      : !hasNul;
  if (!valid) throw fileValidationError('文件内容与扩展名不匹配');
}

async function extractReviewableText(filePath: string, ext: string): Promise<string> {
  try {
    let text: string;
    if (ext === '.docx') {
      text = (await mammoth.extractRawText({ path: filePath })).value;
    } else if (ext === '.pdf') {
      const parser = new PDFParse({ data: new Uint8Array(await readFile(filePath)) });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else {
      // fatal=true 防止非 UTF-8 字节被静默替换成 U+FFFD。
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filePath));
    }
    const normalized = text.replace(/^\uFEFF/, '').trim();
    if (!normalized) {
      throw new Error(ext === '.pdf' ? 'PDF 未提取到可审查文字（可能为扫描件）' : '文件正文为空');
    }
    return normalized;
  } catch (error) {
    if (error instanceof UnprocessableEntityException) throw error;
    throw fileValidationError('文件无法解析为可审查正文');
  }
}

function boundedWorkerCount(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '2', 10);
  return Number.isFinite(parsed) ? Math.min(4, Math.max(1, parsed)) : 2;
}

function fileValidationError(error: string): UnprocessableEntityException {
  return new UnprocessableEntityException({ error, code: 'FILE_VALIDATION_FAILED' });
}
