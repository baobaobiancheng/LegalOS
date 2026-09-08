import { Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
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

type ContractFileWorkerResponse =
  | { ok: true; result: ProcessedContractFile }
  | { ok: false; errorType: 'validation'; message: string }
  | { ok: false; errorType: 'internal' };

interface WorkerWaiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/**
 * 合同文件的纯输入处理器：不查权、不落库、不移动文件。
 * 现有单文件上传与 CRM A1 共用同一套文件头校验和正文抽取逻辑。
 */
@Injectable()
export class ContractFileProcessor {
  private readonly workerPath = join(__dirname, 'contract-file.worker.js');
  private readonly maxWorkers = boundedWorkerCount(process.env.CONTRACT_FILE_PARSE_CONCURRENCY);
  private readonly maxQueueSize = boundedPositiveInt(process.env.CONTRACT_FILE_PARSE_QUEUE_MAX_SIZE, 32, 1, 500);
  private readonly queueTimeoutMs = boundedPositiveInt(process.env.CONTRACT_FILE_PARSE_QUEUE_TIMEOUT_MS, 15_000, 100, 120_000);
  private readonly workerTimeoutMs = boundedPositiveInt(process.env.CONTRACT_FILE_PARSE_TIMEOUT_MS, 20_000, 1_000, 120_000);
  private activeWorkers = 0;
  private readonly waiters: WorkerWaiter[] = [];

  async validateAndExtract(filePath: string, originalName: string): Promise<ProcessedContractFile> {
    const ext = extname(originalName).toLowerCase();
    if (!CONTRACT_FILE_EXTENSIONS.includes(ext as (typeof CONTRACT_FILE_EXTENSIONS)[number])) {
      throw fileValidationError('不支持的文件类型，仅支持 .docx/.pdf/.txt/.md');
    }
    // 生产构建会同时生成 worker.js；Vitest/ts-node 源码模式使用同一纯函数回退。
    if (!this.shouldUseWorker()) return processContractFileInline(filePath, originalName);
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
    if (this.waiters.length >= this.maxQueueSize) {
      throw new ServiceUnavailableException('合同文件解析队列已满，请稍后重试');
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: WorkerWaiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ServiceUnavailableException('合同文件解析排队超时'));
        }, this.queueTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private releaseWorkerSlot(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      // slot 直接交接给队首等待者；activeWorkers 保持不变，避免新请求插队造成超并发。
      waiter.resolve();
      return;
    }
    this.activeWorkers -= 1;
  }

  private runWorker(filePath: string, originalName: string): Promise<ProcessedContractFile> {
    return new Promise((resolve, reject) => {
      const worker = this.createWorker(filePath, originalName);
      let settled = false;
      const settle = async (deliver: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          await worker.terminate();
        } catch {
          // 原始解析结果优先；slot 仍会由外层 finally 释放。
        }
        worker.removeAllListeners();
        deliver();
      };
      const succeed = (value: ProcessedContractFile) => void settle(() => resolve(value));
      const fail = (error: Error) => void settle(() => reject(error));
      const timer = setTimeout(() => {
        fail(new Error('合同文件解析 Worker 超时'));
      }, this.workerTimeoutMs);
      timer.unref?.();
      worker.once('message', (message: ContractFileWorkerResponse) => {
        if (message.ok) succeed(message.result);
        else if (message.errorType === 'validation') fail(fileValidationError(message.message));
        else fail(new Error('合同文件解析 Worker 失败'));
      });
      // terminate 完成前保持 error listener，以免终止期间的错误变成未捕获事件。
      worker.on('error', () => fail(new Error('合同文件解析 Worker 失败')));
      worker.once('exit', (code) => {
        fail(new Error(`合同文件解析 Worker 未返回结果（exit ${code}）`));
      });
    });
  }

  protected createWorker(filePath: string, originalName: string): Worker {
    return new Worker(this.workerPath, {
      workerData: { filePath, originalName },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
  }

  protected shouldUseWorker(): boolean {
    return existsSync(this.workerPath);
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
    // JSZip 返回 readable-stream v2（非 Node 内置 Readable），没有
    // Symbol.asyncIterator。wrap 后再以标准 Node 流按块计数，避免回退整个 entry 入内存。
    const stream = new Readable({ read() {} }).wrap(entry.nodeStream('nodebuffer') as NodeJS.ReadableStream);
    try {
      for await (const value of stream) {
        const chunkBytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value));
        entryBytes += chunkBytes;
        totalBytes += chunkBytes;
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

function boundedPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function fileValidationError(error: string): UnprocessableEntityException {
  return new UnprocessableEntityException({ error, code: 'FILE_VALIDATION_FAILED' });
}
