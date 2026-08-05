import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { join, extname } from 'path';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { sendSSE } from '../../common/utils/sse';
import { ContractService } from './contract.service';
import { ContractTemplateService } from './contract-template.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { Role } from '@prisma/client';

/**
 * multer diskStorage：文件直接落盘到 storage/contracts/{projectId}/，不占内存
 * （NestJS FileInterceptor 默认 memoryStorage 需显式覆盖，工程评审决策 #6）。
 * 文件名用 uuid+扩展名，避免路径穿越与中文文件名问题。
 */
const storageDir = process.env.CONTRACT_STORAGE_DIR
  || join(process.cwd(), 'storage', 'contracts');

const contractStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = (req.params as any).id;
    const dir = join(storageDir, projectId || 'tmp');
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
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
    private readonly templateService: ContractTemplateService,
  ) {}

  /** 合同模板列表 */
  @Get('contract-templates')
  @Roles(Role.business, Role.legal_bp, Role.legal_lead)
  listTemplates() {
    return this.templateService.list();
  }

  /** 生成合同草稿 — SSE 流式 */
  @Post('contracts/generate')
  @Roles(Role.business, Role.legal_bp, Role.legal_lead)
  async generate(
    @Body() dto: CreateContractDto,
    @CurrentUser('id') userId: string,
    @Res() res: Response,
  ) {
    const result = await this.contractService.generateDraft(dto, userId);
    if (result.stream) {
      sendSSE(res, result.stream, { projectId: result.projectId, status: '待复核' });
    } else {
      res.json(result);
    }
  }

  /** business 发起法务审阅 */
  @Post('contracts/:id/submit-review')
  @Roles(Role.business)
  async submitReview(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.contractService.submitReview(id, userId);
  }

  /** legal AI 风险审查 — SSE 流式（可选技能 skillId，2026-08-04 技能库） */
  @Post('contracts/:id/review')
  @Roles(Role.legal_bp, Role.legal_lead)
  async review(
    @Param('id') id: string,
    @Body('skillId') skillId: string | undefined,
    @CurrentUser('id') userId: string,
    @Res() res: Response,
  ) {
    const result = await this.contractService.reviewContract(id, userId, skillId);
    if (result.stream) {
      sendSSE(res, result.stream, { projectId: result.projectId });
    } else {
      res.json(result);
    }
  }

  /** 上传合同附件（multipart: file + kind） */
  @Post('projects/:id/files')
  @Roles(Role.business, Role.legal_bp, Role.legal_lead)
  @UseInterceptors(FileInterceptor('file', { storage: contractStorage, limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('kind') kind: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.contractService.uploadFile(id, file, kind, userId, role);
  }

  /** 附件列表 */
  @Get('projects/:id/files')
  @Roles(Role.business, Role.legal_bp, Role.legal_lead)
  async listFiles(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.contractService.listFiles(id, userId, role);
  }

  /** 下载附件（读磁盘流） */
  @Get('projects/:id/files/:fileId')
  @Roles(Role.business, Role.legal_bp, Role.legal_lead)
  async download(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Res() res: Response,
  ) {
    await this.contractService.downloadFile(id, fileId, userId, role, res);
  }
}
