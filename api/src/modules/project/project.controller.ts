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
import { ProjectActor } from './domain/project-access.types';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  /** 创建工单 */
  @Post()
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead, Role.business)
  async create(@Body() dto: CreateProjectDto, @CurrentUser('id') userId: string) {
    return this.projectService.create(dto, userId);
  }

  /** 工单列表（按状态分组）— 范围由服务端按 actor 生成（P1-01 5.3.4） */
  @Get()
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead)
  async list(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.findAll(actor, {
      status: status as any,
      kind: kind as any,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  /** 当前用户的工单（业务端"我的记录"） */
  @Get('mine')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead, Role.business)
  async mine(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.findAll(actor, {
      mine: true,
      status: status as any,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  /** 工单详情 */
  @Get(':id')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead, Role.business)
  async findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.findOne(id, actor);
  }

  /** 更新工单 */
  @Patch(':id')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.update(id, dto, actor);
  }

  /** 认领未分配工单（P1-01：legal_bp 原子条件认领；legal_lead/admin 可认领） */
  @Post(':id/claim')
  @HttpCode(200)
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead)
  async claim(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.claim(id, actor);
  }

  /** 发送消息 — SSE 流式返回 AI 答复；连接断开取消排队/终止任务 */
  @Post(':id/messages')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead, Role.business)
  async createMessage(
    @Param('id') id: string,
    @Body() dto: CreateProjectMessageDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Res() res: Response,
  ) {
    const actor: ProjectActor = { id: userId, role };
    const abort = new AbortController();
    const result = await this.projectService.createMessage(id, dto, actor, abort.signal);

    if (result.stream) {
      // P2 llm 路由 → SSE 流式推送（连接断开 → abort → 释放 Codex 队列槽位）
      sendSSE(res, result.stream, { projectId: id }, () => abort.abort());
    } else {
      // P1/P0 非流式 → 普通 JSON 响应
      res.json(result.message);
    }
  }

  /** 法务 BP 正式回传 */
  @Post(':id/reply')
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead)
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplyProjectDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.reply(id, dto, actor);
  }

  /** 取消工单 */
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Role.admin, Role.legal_bp, Role.legal_lead, Role.business)
  async cancel(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.cancel(id, actor);
  }

  /** 转派（仅 legal_lead/admin，P1-01） */
  @Post(':id/transfer')
  @Roles(Role.admin, Role.legal_lead)
  async transfer(
    @Param('id') id: string,
    @Body() dto: TransferProjectDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    const actor: ProjectActor = { id: userId, role };
    return this.projectService.transfer(id, dto.legalBpId, actor);
  }
}
