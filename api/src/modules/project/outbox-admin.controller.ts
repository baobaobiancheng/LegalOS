import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { OutboxRepository } from './infrastructure/outbox.repository';

/**
 * Outbox 运维查询（P1-04 8.2-10）：查看 pending / processing / dead 数量及最近错误。
 * 仅 admin / legal_lead 可访问。
 */
@Controller('admin/outbox')
@Roles(Role.admin, Role.legal_lead)
export class OutboxAdminController {
  constructor(private readonly outbox: OutboxRepository) {}

  @Get('stats')
  async stats() {
    return this.outbox.stats();
  }
}
