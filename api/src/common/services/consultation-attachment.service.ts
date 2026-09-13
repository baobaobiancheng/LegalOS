import { BadRequestException, ForbiddenException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentExtractionService } from './document-extraction.service';
import { normalizeUploadFilename } from '../utils/upload-filename';

/**
 * 咨询附件（2026-08-12 review：DOCX 正文从未交给模型）：
 * multipart 上传 → 校验扩展名/大小/签名 → Word/文本解析器提取正文 → 存库(只存文本，不落盘原文件) →
 * 发送消息时带 attachmentIds → 校验归属/状态/过期 → 绑定工单 → 正文注入上下文。
 * 支持 .docx / .doc / .txt / .md；其余格式前端 accept 不开放、后端拒绝。
 */
export interface AttachmentMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string | null;
  status: string;
  extractedChars: number;
  warning: string | null;
}

const ALLOWED_EXTS = ['.docx', '.doc', '.txt', '.md'];
const LEGACY_DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_CHARS = 50_000; // zip bomb / 模型预算防护
const TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ConsultationAttachmentService {
  private readonly logger = new Logger(ConsultationAttachmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly extractor: DocumentExtractionService,
  ) {}

  /** 上传并提取：返回附件元数据（不含正文） */
  async upload(file: Express.Multer.File, userId: string): Promise<AttachmentMetadata> {
    // 中文文件名 UTF-8 还原（multer Latin-1 解释 bug）
    const name = normalizeUploadFilename(file.originalname || 'unnamed');
    const lower = name.toLowerCase();
    // 懒清理：本用户过期附件在下次上传时删除
    await this.prisma.consultationAttachment
      .deleteMany({ where: { creatorId: userId, expiresAt: { lt: new Date() } } })
      .catch(() => undefined);
    if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
      throw new BadRequestException('暂不支持该文件类型（仅支持 .docx / .doc / .txt / .md）');
    }
    if (file.size > MAX_SIZE) throw new PayloadTooLargeException('文件超过 10MB');
    // 真实签名校验：docx 是 zip(PK\x03\x04)
    if (lower.endsWith('.docx')) {
      const sig = file.buffer?.slice(0, 2);
      if (!sig || !sig.equals(Buffer.from([0x50, 0x4b]))) {
        throw new BadRequestException('DOCX 文件签名校验失败（可能不是有效文档）');
      }
    }
    // 旧版 .doc 是 OLE Compound File，固定 8 字节文件头。
    if (lower.endsWith('.doc')) {
      const sig = file.buffer?.subarray(0, LEGACY_DOC_SIGNATURE.length);
      if (!sig || !sig.equals(LEGACY_DOC_SIGNATURE)) {
        throw new BadRequestException('DOC 文件签名校验失败（可能不是有效的旧版 Word 文档）');
      }
    }

    let extracted: { text: string; warning?: string };
    try {
      extracted = await this.extractor.extract(file.buffer, name);
    } catch (e) {
      this.logger.error(`附件提取失败 ${name}: ${e}`);
      throw new BadRequestException('文档解析失败，请确认文件未损坏');
    }
    if (!extracted.text) throw new BadRequestException('文档中没有可提取的正文');

    const overLimit = extracted.text.length > MAX_TEXT_CHARS;
    const text = overLimit ? extracted.text.slice(0, MAX_TEXT_CHARS) : extracted.text;
    const warnings = [
      extracted.warning,
      overLimit ? `正文超长，已截断（${extracted.text.length} 字）` : undefined,
    ].filter((item): item is string => Boolean(item));
    const warning = warnings.length ? warnings.join('；') : null;

    const att = await this.prisma.consultationAttachment.create({
      data: {
        creatorId: userId,
        fileName: name,
        fileSize: file.size,
        mimeType: file.mimetype ?? null,
        status: 'ready',
        extractedText: text,
        extractedChars: text.length,
        warning,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
    return this.metadata(att);
  }

  /** 使用前校验：归属当前用户、状态 ready、未过期；任一不满足抛错 */
  async validateForUser(ids: string[], userId: string): Promise<void> {
    if (!ids?.length) return;
    const attachments = await this.prisma.consultationAttachment.findMany({ where: { id: { in: ids } } });
    for (const id of ids) {
      const att = attachments.find((a) => a.id === id);
      if (!att) throw new BadRequestException('附件不存在');
      if (att.creatorId !== userId) throw new ForbiddenException('无权使用该附件');
      if (att.status !== 'ready') throw new BadRequestException('附件未就绪');
      if (att.expiresAt < new Date()) throw new BadRequestException('附件已过期，请重新上传');
    }
  }

  /** 绑定到工单（首次使用才绑定，幂等） */
  async bind(ids: string[], projectId: string): Promise<void> {
    if (!ids?.length) return;
    await this.prisma.consultationAttachment.updateMany({
      where: { id: { in: ids }, projectId: null },
      data: { projectId },
    });
  }

  /** 取附件正文，拼成带文件名前缀的块（注入模型上下文用；正文视为不可信资料） */
  async getTexts(ids: string[]): Promise<string[]> {
    if (!ids?.length) return [];
    const attachments = await this.prisma.consultationAttachment.findMany({
      where: { id: { in: ids }, status: 'ready' },
      select: { id: true, fileName: true, extractedText: true },
    });
    const byId = new Map(attachments.map((a) => [a.id, a]));
    return ids
      .map((id) => {
        const att = byId.get(id);
        return att?.extractedText ? `【附件 ${att.fileName}】\n${att.extractedText}` : '';
      })
      .filter(Boolean);
  }

  private metadata(att: any): AttachmentMetadata {
    return {
      id: att.id,
      name: att.fileName,
      size: att.fileSize,
      mimeType: att.mimeType,
      status: att.status,
      extractedChars: att.extractedChars,
      warning: att.warning,
    };
  }
}
