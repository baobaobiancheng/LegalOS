import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  UseInterceptors,
  UploadedFile,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { join, extname } from 'path';
import { chmodSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { sendSSE } from '../../common/utils/sse';
import { withResponseAbort } from '../../common/utils/response-abort';
import { ContractService } from './contract.service';
import { ContractFileService } from './contract-file.service';
import { ContractTemplateService } from './contract-template.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { Role } from '@prisma/client';
import { ProjectActor } from '../project/domain/project-access.types';
import { auditRequestContext } from '../../common/audit/audit-request';
import { ProjectFileAccessGuard } from './project-file-access.guard';

/**
 * multer diskStorage：先落盘到 storage/contracts/.staging/，不占内存。
 * ProjectFileAccessGuard 在落盘前授权；提交文件元数据前再次检查当前指派。
 * 文件名用 uuid+扩展名，避免路径穿越与中文文件名问题。
 */
const storageDir = process.env.CONTRACT_STORAGE_DIR
  || join(process.cwd(), 'storage', 'contracts');

const contractStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(storageDir, '.staging');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      cb(null, dir);
    } catch (error) {
      cb(error as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, randomUUID() + ext);
  },
});

@Controller()
export class ContractController {
  constructor(
    private readonly contractService: ContractService,
    private readonly fileService: ContractFileService,
    private readonly templateService: ContractTemplateService,
  ) {}

  /** 合同模板列表 */
  @Get('contract-templates')
  @Roles(Role.admin, Role.business, Role.legal_bp, Role.legal_lead)
  listTemplates() {
    return this.templateService.list();
  }

  /** 生成合同草稿 — SSE 流式；连接断开取消排队/终止任务 */
  @Post('contracts/generate')
  @Roles(Role.admin, Role.business, Role.legal_bp, Role.legal_lead)
  async generate(
    @Body() dto: CreateContractDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Res() res: Response,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return withResponseAbort(res, async (abort) => {
      const result = await this.contractService.generateDraft(dto, actor, abort.signal);
      if (abort.signal.aborted || res.destroyed) return;
      if (result.stream) {
        sendSSE(
          res,
          result.stream,
          { projectId: result.projectId, status: '待复核' },
          () => abort.abort(),
          result.completion,
        );
      } else {
        res.json(result);
      }
    });
  }

  /** business 发起法务审阅 */
  @Post('contracts/:id/submit-review')
  @Roles(Role.admin, Role.business)
  async submitReview(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.contractService.submitReview(id, actor);
  }

  /**
   * legal AI 风险审查 — SSE 流式（P1-05）：
   * 可选技能 skillId + 可选 sourceDocumentId；SSE 完成事件携带 reviewRunId/sourceDocumentId/sourceVersion。
   */
  @Post('contracts/:id/review')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead)
  async review(
    @Param('id') id: string,
    @Body() body: { skillId?: string; sourceDocumentId?: string },
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Res() res: Response,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return withResponseAbort(res, async (abort) => {
      const result = await this.contractService.reviewContract(
        id,
        actor,
        body?.skillId,
        body?.sourceDocumentId,
        abort.signal,
      );
      if (abort.signal.aborted || res.destroyed) return;
      if (result.stream) {
        sendSSE(
          res,
          result.stream,
          {
            projectId: result.projectId,
            reviewRunId: result.reviewRunId,
            sourceDocumentId: result.sourceDocumentId,
            sourceVersion: result.sourceVersion,
          },
          () => abort.abort(),
          result.completion,
        );
      } else {
        res.json(result);
      }
    });
  }

  /** 上传合同附件（multipart: file + kind） */
  @Post('projects/:id/files')
  @Roles(Role.admin, Role.business, Role.legal_bp, Role.legal_lead)
  @UseGuards(ProjectFileAccessGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: contractStorage,
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 1,
      parts: 3,
      fieldSize: 64,
      fieldNameSize: 32,
    },
  }))
  async upload(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('kind') kind: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.fileService.uploadFile(id, file, kind, actor);
  }

  /** 附件列表 */
  @Get('projects/:id/files')
  @Roles(Role.admin, Role.business, Role.legal_bp, Role.legal_lead)
  async listFiles(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.fileService.listFiles(id, actor);
  }

  /** 下载附件（读磁盘流） */
  @Get('projects/:id/files/:fileId')
  @Roles(Role.admin, Role.business, Role.legal_bp, Role.legal_lead)
  async download(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Res() res: Response,
    @Req() request: Request,
  ) {
    const actor: ProjectActor = { id: userId, role };
    await this.fileService.downloadFile(id, fileId, actor, res, auditRequestContext(request));
  }
}
