import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  HttpCode,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkillService } from './skill.service';
import { CreateSkillDto, UpdateSkillDto, ReviewSkillDto } from './dto/skill.dto';
import { Role } from '@prisma/client';

/**
 * 技能库 API（2026-08-04 技能库模块）。
 * 权限矩阵（设计文档 §7，逐格写死）：
 *   business        只读公有（详情剥离 prompt）
 *   legal_bp        注册/编辑/停用/恢复自己的私有与公有、提交审核、撤回
 *   legal_lead/admin 全部（审核/直接建公有/编辑停用任何公有）
 * 他人私有技能对所有角色（含 lead/admin）不可见。
 */
@Controller('skills')
export class SkillController {
  constructor(private readonly skillService: SkillService) {}

  /** 注册技能（默认 private；lead/admin 可直接 public） */
  @Post()
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  create(@Body() dto: CreateSkillDto, @CurrentUser('id') userId: string, @CurrentUser('role') role: Role) {
    return this.skillService.create(dto, userId, role);
  }

  /**
   * 列表：scope=public|mine|pending|usable，group 筛选。
   * usable = 公有 + 创建者私有（+ 兜底"通用法务咨询"由前端常量呈现，选中提交 skillId=null）。
   */
  @Get()
  @Roles(Role.legal_bp, Role.legal_lead, Role.business, Role.admin)
  list(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Query('scope') scope = 'public',
    @Query('group') group?: string,
  ) {
    return this.skillService.list(scope, group, userId, role);
  }

  /** 详情（审核页看 prompt 全文；business 剥离） */
  @Get(':id')
  @Roles(Role.legal_bp, Role.legal_lead, Role.business, Role.admin)
  detail(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: Role) {
    return this.skillService.detail(id, userId, role);
  }

  /** 编辑（private 仅创建者 / public 仅 lead-admin / pending 409） */
  @Put(':id')
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.skillService.update(id, dto, userId, role);
  }

  /** 提交审核：private → pending */
  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  submit(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.skillService.submit(id, userId);
  }

  /** 撤回：pending → private */
  @Post(':id/withdraw')
  @HttpCode(200)
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  withdraw(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.skillService.withdraw(id, userId);
  }

  /** 审核：通过 → public / 驳回 → private（reason 必填） */
  @Post(':id/review')
  @HttpCode(200)
  @Roles(Role.legal_lead, Role.admin)
  review(@Param('id') id: string, @Body() dto: ReviewSkillDto, @CurrentUser('id') userId: string) {
    return this.skillService.review(id, dto, userId);
  }

  /** 停用（pending 409） */
  @Post(':id/archive')
  @HttpCode(200)
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  archive(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: Role) {
    return this.skillService.archive(id, userId, role);
  }

  /** 恢复 */
  @Post(':id/restore')
  @HttpCode(200)
  @Roles(Role.legal_bp, Role.legal_lead, Role.admin)
  restore(@Param('id') id: string, @CurrentUser('id') userId: string, @CurrentUser('role') role: Role) {
    return this.skillService.restore(id, userId, role);
  }
}
