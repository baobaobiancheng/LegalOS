import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import * as mammoth from 'mammoth';

const LEGACY_DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const LEGACY_DOC_HEADER_BYTES = 512;
const LEGACY_DOC_MAX_TEXT_CHARS = 50_000;
const LEGACY_DOC_TIMEOUT_MS = 8_000;
const LEGACY_DOC_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const WordExtractor = require('word-extractor');
(async () => {
  const extractor = new WordExtractor();
  const document = await extractor.extract(Buffer.from(workerData.buffer));
  const body = String(document.getBody() || '');
  parentPort.postMessage({
    text: body.slice(0, workerData.maxChars),
    originalChars: body.length,
  });
})().catch((error) => {
  parentPort.postMessage({ error: String(error && error.message ? error.message : error) });
});
`;

/**
 * 咨询附件正文提取（2026-08-12 review：DOCX 正文从未交给模型）：
 * 支持 .docx / .doc / .txt / .md；其余格式前端不展示、后端不接收。
 * 只存提取后的正文，不落盘原文件；批量抽取有 zip-bomb 上限由调用方按 size 拦截。
 */
export interface ExtractionResult {
  text: string;
  warning?: string;
}

@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);

  /** 提取正文：.docx 用 mammoth，旧版 .doc 用 OLE 解析器；txt/md 按 UTF-8 读文本。 */
  async extract(buffer: Buffer, fileName: string): Promise<ExtractionResult> {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.docx')) return this.extractDocx(buffer);
    if (lower.endsWith('.doc')) return this.extractDoc(buffer);
    return { text: this.normalizeText(buffer.toString('utf8')) };
  }

  /** 普通 DOCX：extractRawText 覆盖正文+表格；批注/修订痕迹/嵌入图片不提取 */
  async extractDocx(buffer: Buffer): Promise<ExtractionResult> {
    const result = await mammoth.extractRawText({ buffer });
    const text = this.normalizeText(result.value);
    const warning =
      result.messages && result.messages.length > 0
        ? '已提取正文，批注、修订痕迹及图片可能未包含'
        : undefined;
    return { text, warning };
  }

  /** 旧版二进制 Word（OLE .doc）：提取正文文本，不包含图片、批注和修订记录。 */
  async extractDoc(buffer: Buffer): Promise<ExtractionResult> {
    validateLegacyDocContainer(buffer);
    const document = await extractLegacyDocIsolated(buffer);
    const warnings = ['已提取旧版 Word 正文，图片、批注及修订痕迹未包含'];
    if (document.originalChars > LEGACY_DOC_MAX_TEXT_CHARS) {
      warnings.push(`正文超长，已截断（${document.originalChars} 字）`);
    }
    return {
      text: this.normalizeText(document.text),
      warning: warnings.join('；'),
    };
  }

  /** 归一化：统一换行、去掉行尾空白、压缩连续空行（防模型输出/文档产生巨大留白） */
  normalizeText(text: string): string {
    if (!text) return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

/** 在进入第三方 OLE 解析器前约束 CFB 头，拒绝明显伪造的扇区/分配表声明。 */
export function validateLegacyDocContainer(buffer: Buffer): void {
  if (buffer.length < LEGACY_DOC_HEADER_BYTES || !buffer.subarray(0, 8).equals(LEGACY_DOC_SIGNATURE)) {
    throw new Error('DOC 文件头不完整');
  }
  if (buffer.readUInt16LE(28) !== 0xfffe) throw new Error('DOC 字节序无效');
  const sectorShift = buffer.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('DOC 扇区大小无效');
  if (buffer.readUInt16LE(32) !== 6) throw new Error('DOC Mini Sector 大小无效');
  const sectorSize = 2 ** sectorShift;
  if (buffer.length < sectorSize || buffer.length % sectorSize !== 0) {
    throw new Error('DOC 文件长度与扇区声明不一致');
  }
  const sectorCount = (buffer.length / sectorSize) - 1;
  const fatSectorCount = buffer.readUInt32LE(44);
  const difatSectorCount = buffer.readUInt32LE(72);
  if (fatSectorCount > sectorCount || difatSectorCount > sectorCount) {
    throw new Error('DOC 分配表超出文件范围');
  }
}

function extractLegacyDocIsolated(buffer: Buffer): Promise<{ text: string; originalChars: number }> {
  return new Promise((resolve, reject) => {
    const exactBuffer = Uint8Array.from(buffer).buffer;
    const worker = new Worker(LEGACY_DOC_WORKER, {
      eval: true,
      workerData: { buffer: exactBuffer, maxChars: LEGACY_DOC_MAX_TEXT_CHARS },
      transferList: [exactBuffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('DOC 文档解析超时')));
    }, LEGACY_DOC_TIMEOUT_MS);
    worker.once('message', (message: { text?: string; originalChars?: number; error?: string }) => {
      if (message.error) {
        finish(() => reject(new Error(message.error)));
        return;
      }
      finish(() => resolve({
        text: String(message.text ?? ''),
        originalChars: Number(message.originalChars ?? 0),
      }));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`DOC 文档解析进程未返回结果（${code}）`)));
    });
  });
}
