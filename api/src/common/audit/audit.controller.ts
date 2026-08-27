import { Controller, Get, Query, Req } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { Request } from 'express';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from './audit.service';
import { auditRequestContext } from './audit-request';
import { AuditQueryDto } from './dto/audit-query.dto';

@Controller('admin/audit-logs')
@Roles(Role.admin, Role.legal_lead)
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Query() query: AuditQueryDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    const where = auditWhere(query, actorRole);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    await this.audit.record({
      actor: { id: actorId, role: actorRole },
      action: 'audit.read',
      resourceType: 'audit_event',
      source: 'web',
      outcome: 'success',
      request: auditRequestContext(request),
      metadata: { filters: Object.keys(where), returned: items.length },
      retentionClass: 'security',
    });
    return { items, total, page: query.page, size: query.size, retentionPolicyDays: this.audit.retentionPolicy() };
  }

  @Get('stats')
  async stats(
    @Query() query: AuditQueryDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    const where = auditWhere(query, actorRole);
    const groups = await this.prisma.auditEvent.groupBy({
      by: ['action', 'outcome', 'reasonCode'],
      where,
      _count: { _all: true },
      orderBy: [{ action: 'asc' }, { outcome: 'asc' }, { reasonCode: 'asc' }],
    });
    await this.audit.record({
      actor: { id: actorId, role: actorRole },
      action: 'audit.read',
      resourceType: 'audit_event_stats',
      source: 'web',
      outcome: 'success',
      request: auditRequestContext(request),
      metadata: { filters: Object.keys(where), groupCount: groups.length },
      retentionClass: 'security',
    });
    return {
      total: groups.reduce((sum, group) => sum + group._count._all, 0),
      groups: groups.map((group) => ({
        action: group.action,
        outcome: group.outcome,
        reasonCode: group.reasonCode,
        count: group._count._all,
      })),
    };
  }

  @Get('integrity')
  @Roles(Role.admin)
  async integrity(
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    const items = await this.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'desc' }, take: 500 });
    const invalidEventIds = items.filter((item) => !this.audit.verifyEvent(item as any)).map((item) => item.eventId);
    await this.audit.record({
      actor: { id: actorId, role: actorRole },
      action: 'audit.integrity.verify',
      resourceType: 'audit_event',
      source: 'web',
      outcome: invalidEventIds.length ? 'failed' : 'success',
      reasonCode: invalidEventIds.length ? 'EVENT_HASH_MISMATCH' : null,
      request: auditRequestContext(request),
      metadata: { checked: items.length, invalidCount: invalidEventIds.length },
      retentionClass: 'security',
    });
    return { checked: items.length, valid: invalidEventIds.length === 0, invalidEventIds };
  }
}

function auditWhere(query: AuditQueryDto, actorRole: Role): Prisma.AuditEventWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {
    ...(query.from && !Number.isNaN(Date.parse(query.from)) ? { gte: new Date(query.from) } : {}),
    ...(query.to && !Number.isNaN(Date.parse(query.to)) ? { lte: new Date(query.to) } : {}),
  };
  return {
    ...(actorRole === Role.legal_lead ? { retentionClass: { in: ['business', 'ai'] } } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.resourceType ? { resourceType: query.resourceType } : {}),
    ...(query.resourceId ? { resourceId: query.resourceId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.requestId ? { requestId: query.requestId } : {}),
    ...(query.correlationId ? { correlationId: query.correlationId } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}),
    ...(Object.keys(occurredAt).length ? { occurredAt } : {}),
  };
}
