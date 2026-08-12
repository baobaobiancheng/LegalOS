import { Injectable, Logger } from '@nestjs/common';
import * as mammoth from 'mammoth';

/**
 * 咨询附件正文提取（2026-08-12 review：DOCX 正文从未交给模型）：
 * 第一期仅承诺 .docx / .txt / .md；其余格式前端不展示、后端不接收。
 * 只存提取后的正文，不落盘原文件；批量抽取有 zip-bomb 上限由调用方按 size 拦截。
 */
export interface ExtractionResult {
  text: string;
  warning?: string;
}

@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);

  /** 提取正文：.docx 用 mammoth.extractRawText；txt/md 按 UTF-8 读文本。 */
  async extract(buffer: Buffer, fileName: string): Promise<ExtractionResult> {
    if (fileName.toLowerCase().endsWith('.docx')) return this.extractDocx(buffer);
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
