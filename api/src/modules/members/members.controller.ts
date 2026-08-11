import { Controller, Get, Post, Put, Query, Body } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { MembersService } from './members.service';
import { BindContactDto, SetBpDomainDto } from './dto/members.dto';

/**
 * 管理端成员管理（2026-08-05 钉钉拉群模块）：
 * 同步钉钉通讯录 / 手动绑定 / BP 领域映射 / 拉群失败计数。
 * 仅 admin 可见（与空壳 Dashboard 共存）。
 */
@Controller('admin/members')
@Roles(Role.admin)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  /** 一键同步钉钉通讯录（拉全量 → 快照 → 姓名自动匹配绑定） */
  @Post('sync')
  async sync() {
    return this.membersService.syncContacts();
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

  /** 手动绑定系统用户 ↔ 钉钉成员 */
  @Post('bind')
  async bind(@Body() dto: BindContactDto) {
    return this.membersService.bind(dto.userId, dto.dingtalkUserId);
  }

  /** 解绑 */
  @Post('unbind')
  async unbind(@Body('userId') userId: string) {
    return this.membersService.unbind(userId);
  }

  /** BP 领域映射列表（法务角色 + 现有映射） */
  @Get('bp-domains')
  async listBpDomains() {
    return this.membersService.listBpDomains();
  }

  /** 设置 BP 领域映射 */
  @Put('bp-domains')
  async setBpDomain(@Body() dto: SetBpDomainDto) {
    return this.membersService.setBpDomain(dto.userId, dto.domain, dto.enabled);
  }

  /** 拉群失败工单计数 */
  @Get('failures')
  async failures() {
    return this.membersService.failures();
  }
}
