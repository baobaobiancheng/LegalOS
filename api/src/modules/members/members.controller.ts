import { Controller, Get, Post, Put, Query, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { MembersService } from './members.service';
import { BindContactDto, ProvisionMemberDto, SetBpDomainDto } from './dto/members.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { auditRequestContext } from '../../common/audit/audit-request';
import { LegalResponsibilityService } from './legal-responsibility.service';

/**
 * 管理端成员管理（2026-08-05 钉钉拉群模块）：
 * 同步钉钉通讯录 / 手动绑定 / BP 领域映射 / 拉群失败计数。
 * 仅 admin 可见（与空壳 Dashboard 共存）。
 */
@Controller('admin/members')
@Roles(Role.admin)
export class MembersController {
  constructor(private readonly membersService: MembersService, private readonly responsibilities: LegalResponsibilityService) {}

  @Get('bp-responsibilities')
  async previewResponsibilities() {
    return this.responsibilities.preview();
  }

  @Post('bp-responsibilities/apply')
  async applyResponsibilities(
    @CurrentUser('id') id: string,
    @CurrentUser('role') role: Role,
    @Req() request: Request,
  ) {
    return this.responsibilities.apply({ id, role }, auditRequestContext(request));
  }

  /** 一键同步钉钉通讯录（拉全量 → 快照 → 姓名自动匹配绑定） */
  @Post('sync')
  async sync(
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.membersService.syncContacts(
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }

  /** 最近一次成功同步统计（切页/刷新后恢复统计卡） */
  @Get('last-sync')
  async lastSync() {
    return this.membersService.lastSync();
  }

  /** 系统用户列表（含绑定状态） */
  @Get('users')
  async listUsers() {
    return this.membersService.listUsers();
  }

  /** 通讯录快照列表（手动绑定搜索源） */
  @Get('contacts')
  async listContacts(@Query('keyword') keyword?: string) {
    return this.membersService.listContacts(keyword);
  }

  /** 首次登录前预开通 CAS 用户，并原子绑定钉钉身份、部门和组织角色。 */
  @Post('provision')
  async provision(
    @Body() dto: ProvisionMemberDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.membersService.provision(
      dto.casUsername,
      dto.dingtalkUserId,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }

  /** 手动绑定系统用户 ↔ 钉钉成员 */
  @Post('bind')
  async bind(
    @Body() dto: BindContactDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.membersService.bind(
      dto.userId,
      dto.dingtalkUserId,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }

  /** 解绑 */
  @Post('unbind')
  async unbind(
    @Body('userId') userId: string,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.membersService.unbind(
      userId,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }

  /** BP 领域映射列表（法务角色 + 现有映射） */
  @Get('bp-domains')
  async listBpDomains() {
    return this.membersService.listBpDomains();
  }

  /** 设置 BP 领域映射 */
  @Put('bp-domains')
  async setBpDomain(
    @Body() dto: SetBpDomainDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.membersService.setBpDomain(
      dto.userId,
      dto.domain,
      dto.enabled,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }

  /** 拉群失败工单计数 */
  @Get('failures')
  async failures() {
    return this.membersService.failures();
  }
}
