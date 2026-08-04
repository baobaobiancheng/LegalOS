import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Res,
  HttpCode,
} from '@nestjs/common';
import { Response } from 'express';
import { sendSSE } from '../../common/utils/sse';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectService } from './project.service';
import {
  CreateProjectDto,
  CreateProjectMessageDto,
  ReplyProjectDto,
  TransferProjectDto,
} from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Role } from '@prisma/client';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  /** 创建工单 */
  @Post()
  @Roles(Role.legal_bp, Role.legal_lead, Role.business)
  async create(@Body() dto: CreateProjectDto, @CurrentUser('id') userId: string) {
    return this.projectService.create(dto, userId);
  }

  /** 工单列表（按状态分组） */
  @Get()
  @Roles(Role.legal_bp, Role.legal_lead)
  async list(
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.projectService.findAll({
      status: status as any,
      kind: kind as any,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  /** 当前用户的工单（业务端"我的记录"） */
  @Get('mine')
  @Roles(Role.legal_bp, Role.legal_lead, Role.business)
  async mine(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.projectService.findAll({
      creatorId: userId,
      status: status as any,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  /** 工单详情 */
  @Get(':id')
  @Roles(Role.legal_bp, Role.legal_lead, Role.business)
  async findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
    @CurrentUser('role') role?: string,
  ) {
    return this.projectService.findOne(id, userId, role);
  }

  /** 更新工单 */
  @Patch(':id')
  @Roles(Role.legal_bp, Role.legal_lead)
  async update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projectService.update(id, dto);
  }

  /** 发送消息 — SSE 流式返回 AI 答复 */
  @Post(':id/messages')
  @Roles(Role.legal_bp, Role.legal_lead, Role.business)
  async createMessage(
    @Param('id') id: string,
    @Body() dto: CreateProjectMessageDto,
    @CurrentUser('id') userId: string,
    @Res() res: Response,
  ) {
    const result = await this.projectService.createMessage(id, dto, userId);

    if (result.stream) {
      // P2 llm 路由 → SSE 流式推送（共享 sendSSE helper，消除重复）
      sendSSE(res, result.stream, { projectId: id });
    } else {
      // P1/P0 非流式 → 普通 JSON 响应
      res.json(result.message);
    }
  }

  /** 法务 BP 正式回传 */
  @Post(':id/reply')
  @Roles(Role.legal_bp, Role.legal_lead)
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplyProjectDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.reply(id, dto, userId);
  }

  /** 取消工单 */
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Role.legal_bp, Role.legal_lead, Role.business)
  async cancel(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectService.cancel(id, userId);
  }

  /** 转派 */
  @Post(':id/transfer')
  @Roles(Role.legal_bp, Role.legal_lead)
  async transfer(@Param('id') id: string, @Body() dto: TransferProjectDto) {
    return this.projectService.transfer(id, dto.legalBpId);
  }
}
