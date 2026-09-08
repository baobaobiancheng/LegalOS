import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { ConsultationAttachmentService } from '../../common/services/consultation-attachment.service';

/**
 * 咨询附件上传：multipart 单文件，内存缓冲 → 校验 → Word/文本解析 → 存库。
 * 只接受 .docx / .doc / .txt / .md；返回附件元数据（attachmentId 供消息引用）。
 */
@Controller('consultation-attachments')
export class ConsultationAttachmentsController {
  constructor(private readonly attachmentService: ConsultationAttachmentService) {}

  @Post()
  @Roles(Role.business, Role.legal_bp, Role.legal_lead, Role.admin)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2, fieldNameSize: 32 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser('id') userId: string) {
    if (!file) throw new BadRequestException('缺少文件字段（file）');
    return this.attachmentService.upload(file, userId);
  }
}
