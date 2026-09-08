import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Response } from 'express';
import {
  createReadStream,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { formatEventTime } from '../../common/utils/event-time';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';
import { ContractDocumentWriter } from './application/contract-document.writer';
import { AuditService } from '../../common/audit/audit.service';
import { AuditRequestContext } from '../../common/audit/audit.types';
import { ContractFileProcessor } from './application/contract-file.processor';
import { safeErrorTag } from '../../common/utils/safe-error';

/**
 * 合同文件服务（从 ContractService 抽出，2026-08-20 上帝类拆分）。
 *
 * 职责：合同附件的上传/列表/下载 + 磁盘文件管理（staging → 项目目录）+ 文件签名校验
 * + DOCX/PDF/TXT/MD 正文抽取落库（createContractDocument，供上传和生成两条路径复用）。
 * ContractService 只保留生成/审查编排，不再持有任何文件系统逻辑。
 */
@Injectable()
export class ContractFileService {
  private readonly logger = new Logger(ContractFileService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: ProjectAccessPolicy,
    private readonly documentWriter: ContractDocumentWriter,
    private readonly fileProcessor: ContractFileProcessor,
    @Optional() private readonly audit?: AuditService,
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
    try {
      return await this.persistUpload(projectId, file, kind, actor);
    } finally {
      // 覆盖查库、鉴权、chmod、解析、移动等所有失败点；成功移动后原路径不存在。
      this.tryCleanup(file.path);
    }
  }

  private async persistUpload(
    projectId: string,
    file: Express.Multer.File,
    kind: string,
    actor: ProjectActor,
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException('工单不存在');
    }
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);

    const ext = extname(file.originalname).toLowerCase();
    if (file.size > 20 * 1024 * 1024) {
      throw new BadRequestException('文件超过 20MB 限制');
    }
    chmodSync(file.path, 0o600);
    if (kind !== 'revised' && kind !== 'final') {
      throw new BadRequestException('kind 仅支持 revised / final');
    }

    // 四种格式都必须在 staging 阶段解析出非空正文；失败不进入业务目录/数据库。
    const extractedText = (await this.fileProcessor.validateAndExtract(file.path, file.originalname)).text;

    const storedName = file.filename || `${randomUUID()}${ext}`;
    const projectDir = join(this.storageDir, projectId);
    const finalPath = join(projectDir, storedName);
    try {
      // file.path 仍位于 staging；只有完成对象级鉴权和输入校验后才进入
      // projectId 目录，避免未授权请求先创建/污染业务目录。
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      chmodSync(projectDir, 0o700);
      renameSync(file.path, finalPath);
    } catch (e) {
      this.tryCleanup(finalPath);
      this.logger.error(`附件移动到正式目录失败：${safeErrorTag(e)}`);
      throw new InternalServerErrorException('附件保存失败');
    }

    let record;
    try {
      record = await this.prisma.$transaction(async (tx) => {
        const created = await tx.contractFile.create({
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
        await this.documentWriter.create(tx, {
          projectId,
          documentType: kind as 'revised' | 'final',
          content: extractedText,
          sourceFileId: created.id,
          createdBy: actor.id,
        });
        await tx.projectMessage.create({
          data: {
            projectId,
            role: 'assistant',
            text: extractedText,
            label: kind === 'revised' ? '修订版文本' : '终稿文本',
          },
        });
        await tx.projectEvent.create({
          data: { projectId, text: formatEventTime() + ` · 上传了合同文件：${file.originalname}` },
        });
        return created;
      });
    } catch (e) {
      this.tryCleanup(finalPath);
      this.logger.error(`附件记录落库失败：${safeErrorTag(e)}`);
      throw new InternalServerErrorException('附件保存失败');
    }

    return {
      fileId: record.id,
      originalName: record.originalName,
      size: record.size,
      kind: record.kind,
      textExtracted: true,
      extractedChars: extractedText.length,
    };
  }

  /** 附件列表（含上传人显示名） */
  async listFiles(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.ManageFile, project);
    return this.prisma.contractFile.findMany({
      where: { projectId },
      include: { uploader: { select: { id: true, displayName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 下载附件 — 读磁盘流，RFC5987 filename* 支持中文名（工程评审决策 #9） */
  async downloadFile(
    projectId: string,
    fileId: string,
    actor: ProjectActor,
    res: Response,
    request?: AuditRequestContext,
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
    if (!this.audit) throw new InternalServerErrorException('审计服务不可用，暂不能下载附件');
    await this.audit.record({
      actor,
      action: 'attachment.download',
      resourceType: 'attachment',
      resourceId: fileId,
      projectId,
      source: 'web',
      outcome: 'success',
      request,
      metadata: { kind: file.kind, size: stat.size, mimeType: file.mimeType ?? null },
      retentionClass: 'business',
    });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    );
    res.setHeader('Content-Length', stat.size);
    try {
      await pipeline(createReadStream(targetPath), res);
    } catch (error) {
      // 客户端断开时 pipeline 会受控关闭文件描述符；响应已开始后不能再写 JSON 错误。
      if (res.destroyed || res.writableEnded || res.headersSent) return;
      this.logger.error(`附件读取失败：${safeErrorTag(error)}`);
      throw new InternalServerErrorException('附件读取失败');
    }
  }

  private tryCleanup(path?: string) {
    if (path) { try { unlinkSync(path); } catch {} }
  }

}
