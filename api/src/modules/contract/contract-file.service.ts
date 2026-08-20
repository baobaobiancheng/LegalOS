import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import * as mammoth from 'mammoth';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';

/**
 * 合同文件服务（从 ContractService 抽出，2026-08-20 上帝类拆分）。
 *
 * 职责：合同附件的上传/列表/下载 + 磁盘文件管理（staging → 项目目录）+ 文件签名校验
 * + docx 正文抽取落库（createContractDocument，供上传和生成两条路径复用）。
 * ContractService 只保留生成/审查编排，不再持有任何文件系统逻辑。
 */
@Injectable()
export class ContractFileService {
  private readonly logger = new Logger(ContractFileService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: ProjectAccessPolicy,
  ) {
    this.storageDir = process.env.CONTRACT_STORAGE_DIR
      || join(process.cwd(), 'storage', 'contracts');
  }

  /** 上传合同附件（先落 staging，Policy 通过后再移动到项目目录，P1-06） */
  async uploadFile(
    projectId: string,
    file: Express.Multer.File,
    kind: string,
    actor: ProjectActor,
  ) {
    if (!file) throw new BadRequestException('未收到文件');
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      this.tryCleanup(file.path);
      throw new NotFoundException('工单不存在');
    }
    try {
      this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);
    } catch (e) {
      this.tryCleanup(file.path);
      throw e;
    }

    // 类型白名单（不信任 mimetype，工程评审决策 #6）
    const ext = extname(file.originalname).toLowerCase();
    const allowed = ['.docx', '.pdf', '.txt', '.md'];
    if (!allowed.includes(ext)) {
      this.tryCleanup(file.path);
      throw new BadRequestException('不支持的文件类型，仅支持 .docx/.pdf/.txt/.md');
    }
    if (file.size > 20 * 1024 * 1024) {
      this.tryCleanup(file.path);
      throw new BadRequestException('文件超过 20MB 限制');
    }
    try {
      this.assertFileSignature(file.path, ext);
    } catch (e) {
      this.tryCleanup(file.path);
      throw e;
    }
    if (kind !== 'revised' && kind !== 'final') {
      this.tryCleanup(file.path);
      throw new BadRequestException('kind 仅支持 revised / final');
    }

    const storedName = file.filename || `${randomUUID()}${ext}`;
    const projectDir = join(this.storageDir, projectId);
    const finalPath = join(projectDir, storedName);
    try {
      // file.path 仍位于 staging；只有完成对象级鉴权和输入校验后才进入
      // projectId 目录，避免未授权请求先创建/污染业务目录。
      mkdirSync(projectDir, { recursive: true });
      renameSync(file.path, finalPath);
    } catch (e) {
      this.tryCleanup(file.path);
      this.logger.error(`附件移动到正式目录失败：${e}`);
      throw new InternalServerErrorException('附件保存失败');
    }

    let record;
    try {
      record = await this.prisma.contractFile.create({
        data: {
          projectId,
          kind,
          originalName: file.originalname,
          storedName,
          mimeType: file.mimetype,
          size: file.size,
          uploadedBy: actor.id,
        },
      });
    } catch (e) {
      this.tryCleanup(finalPath);
      this.logger.error(`附件记录落库失败：${e}`);
      throw new InternalServerErrorException('附件保存失败');
    }

    // revised/final + .docx：mammoth 抽取正文 → ContractDocument（9.3-2/9.3-3）。
    // 抽取失败不得创建空文档，返回 textExtracted=false 让前端可识别"暂不可审查"。
    let textExtracted = false;
    if ((kind === 'revised' || kind === 'final') && ext === '.docx') {
      try {
        const result = await mammoth.extractRawText({ path: finalPath });
        const text = result.value.trim();
        if (text) {
          textExtracted = true;
          await this.prisma.$transaction(async (tx) => {
            await this.createContractDocument(tx, {
              projectId,
              documentType: kind as 'revised' | 'final',
              content: text,
              sourceFileId: record.id,
              createdBy: actor.id,
            });
            await tx.projectMessage.create({
              data: {
                projectId,
                role: 'assistant',
                text,
                label: kind === 'revised' ? '修订版文本' : '终稿文本',
              },
            });
          });
        }
      } catch (e) {
        this.logger.warn(`mammoth 抽取失败（不影响上传）：${e}`);
      }
    }

    await this.addEvent(projectId, this.formatTime() + ` · 上传了合同文件：${file.originalname}`);
    return {
      fileId: record.id,
      originalName: record.originalName,
      size: record.size,
      kind: record.kind,
      textExtracted,
    };
  }

  /** 附件列表（含上传人显示名） */
  async listFiles(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);
    return this.prisma.contractFile.findMany({
      where: { projectId },
      include: { uploader: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 下载附件 — 读磁盘流，RFC5987 filename* 支持中文名（工程评审决策 #9） */
  async downloadFile(
    projectId: string,
    fileId: string,
    actor: ProjectActor,
    res: Response,
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);

    const file = await this.prisma.contractFile.findFirst({
      where: { id: fileId, projectId },
    });
    if (!file) throw new NotFoundException('文件不存在');

    const targetPath = join(this.storageDir, projectId, file.storedName);
    if (!existsSync(targetPath)) throw new NotFoundException('文件已丢失');

    const stat = statSync(targetPath);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    );
    res.setHeader('Content-Length', stat.size);
    createReadStream(targetPath).pipe(res);
  }

  /**
   * 版本号安全分配（9.3-4）：事务内 count+1；并发唯一冲突(P2002)重试，不覆盖旧版本。
   * 供上传（revised/final docx 抽取）与生成草稿两条路径复用。
   */
  async createContractDocument(
    tx: Prisma.TransactionClient,
    data: {
      projectId: string;
      documentType: 'draft' | 'revised' | 'final';
      content: string;
      sourceFileId?: string | null;
      createdBy?: string | null;
    },
    attempts = 0,
  ): Promise<any> {
    const count = await tx.contractDocument.count({ where: { projectId: data.projectId } });
    const version = count + 1;
    try {
      return await tx.contractDocument.create({ data: { ...data, version } });
    } catch (e: any) {
      if (e?.code === 'P2002' && attempts < 5) {
        return this.createContractDocument(tx, data, attempts + 1);
      }
      throw e;
    }
  }

  private tryCleanup(path?: string) {
    if (path) { try { unlinkSync(path); } catch {} }
  }

  /**
   * 校验常见文件头，避免仅凭扩展名把伪装的二进制文件送入后续解析链路。
   * 文本格式只拒绝明显的二进制 NUL；DOCX/PDF 必须匹配 ZIP/PDF 文件签名。
   */
  private assertFileSignature(filePath: string, ext: string): void {
    const fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
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
    if (!valid) throw new BadRequestException('文件内容与扩展名不匹配');
  }

  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({ data: { projectId, text } });
  }

  private formatTime(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
