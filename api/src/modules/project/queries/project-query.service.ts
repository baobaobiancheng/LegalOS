import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../domain/project-access.types';
import { Prisma, ProjectKind, ProjectStatus } from '@prisma/client';

/** 用户选择器：查询投影统一脱敏,不暴露密码哈希 */
const userSelect = { id: true, username: true, displayName: true, role: true };

export interface ProjectListParams {
  status?: ProjectStatus;
  statusGroup?: BusinessStatusGroupKey;
  kind?: ProjectKind;
  group?: ProjectGroupKey;
  query?: string;
  mine?: boolean;
  page?: number;
  size?: number;
}

export interface ProjectHistoryCursors {
  beforeMessageId?: string;
  beforeEventId?: string;
}

const MESSAGE_PAGE_SIZE = 200;
const EVENT_PAGE_SIZE = 100;

export const PROJECT_GROUP_KEYS = ['待处理', '合同协作', '已回传', '数字分身处理'] as const;
export type ProjectGroupKey = (typeof PROJECT_GROUP_KEYS)[number];
export const isProjectGroupKey = (value: string | undefined): value is ProjectGroupKey =>
  Boolean(value && PROJECT_GROUP_KEYS.includes(value as ProjectGroupKey));

export const BUSINESS_STATUS_GROUP_KEYS = ['processing', 'completed', 'cancelled'] as const;
export type BusinessStatusGroupKey = (typeof BUSINESS_STATUS_GROUP_KEYS)[number];
export const isBusinessStatusGroupKey = (value: string | undefined): value is BusinessStatusGroupKey =>
  Boolean(value && BUSINESS_STATUS_GROUP_KEYS.includes(value as BusinessStatusGroupKey));
export const isProjectKind = (value: string | undefined): value is ProjectKind =>
  Boolean(value && Object.values(ProjectKind).includes(value as ProjectKind));
export const isProjectStatus = (value: string | undefined): value is ProjectStatus =>
  Boolean(value && Object.values(ProjectStatus).includes(value as ProjectStatus));

export function businessStatusGroupWhere(group: BusinessStatusGroupKey): Prisma.ProjectWhereInput {
  switch (group) {
    case 'processing':
      return { status: { in: [ProjectStatus.分析中, ProjectStatus.待处理, ProjectStatus.待复核] } };
    case 'completed':
      return { status: ProjectStatus.已回传 };
    case 'cancelled':
      return { status: ProjectStatus.已取消 };
  }
}

/** 与列表投影的优先级保持一致：合同 > LLM > 已结束 > 待处理。 */
export function projectGroupWhere(group: ProjectGroupKey): Prisma.ProjectWhereInput {
  switch (group) {
    case '合同协作':
      return { kind: ProjectKind.contract };
    case '数字分身处理':
      return {
        kind: { not: ProjectKind.contract },
        route: 'llm',
      };
    case '已回传':
      return {
        kind: { not: ProjectKind.contract },
        route: { not: 'llm' },
        status: { in: [ProjectStatus.已回传, ProjectStatus.已取消] },
      };
    case '待处理':
      return {
        kind: { not: ProjectKind.contract },
        route: { not: 'llm' },
        status: { notIn: [ProjectStatus.已回传, ProjectStatus.已取消] },
      };
  }
}

/**
 * P2-01 查询服务：只负责读取、分页、范围过滤和响应投影,不执行任何外部副作用。
 * 查询范围始终来自 ProjectAccessPolicy.listScope(actor),禁止客户端绕过。
 */
@Injectable()
export class ProjectQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: ProjectAccessPolicy,
  ) {}

  /** 列表：服务端范围过滤 + 分页 + 按状态分组投影 */
  async findAll(actor: ProjectActor, params: ProjectListParams) {
    const { status, statusGroup, kind, group, query, mine, page = 1, size = 20 } = params;
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new BadRequestException('page 必须是大于等于 1 的整数');
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new BadRequestException('size 必须是 1 到 100 的整数');
    }
    if (status !== undefined && !isProjectStatus(status)) {
      throw new BadRequestException('未知工单状态');
    }
    const skip = (page - 1) * size;
    if (!Number.isSafeInteger(skip)) {
      throw new BadRequestException('分页参数超出安全范围');
    }
    const mineScopeWhere: Prisma.ProjectWhereInput | undefined = mine ? { creatorId: actor.id } : undefined;
    const baseWhere: Prisma.ProjectWhereInput = mine
      ? { ...mineScopeWhere }
      : this.accessPolicy.listScope(actor);

    if (status) baseWhere.status = status;
    if (kind) baseWhere.kind = kind;
    if (query?.trim()) baseWhere.title = { contains: query.trim().slice(0, 100) };

    const groupWhere = group
      ? projectGroupWhere(group)
      : statusGroup
        ? businessStatusGroupWhere(statusGroup)
        : undefined;
    const where: Prisma.ProjectWhereInput = groupWhere ? { AND: [baseWhere, groupWhere] } : baseWhere;

    const [items, groupCountValues, mineTotal, mineStatusRows] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: size,
      }),
      Promise.all(PROJECT_GROUP_KEYS.map((key) => this.prisma.project.count({
        where: { AND: [baseWhere, projectGroupWhere(key)] },
      }))),
      mine ? this.prisma.project.count({ where }) : Promise.resolve(undefined),
      mine
        ? this.prisma.project.groupBy({
            by: ['status'],
            where: mineScopeWhere,
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const groupCounts = Object.fromEntries(
      PROJECT_GROUP_KEYS.map((key, index) => [key, groupCountValues[index]]),
    ) as Record<ProjectGroupKey, number>;
    const total = mine
      ? (mineTotal ?? 0)
      : group
        ? groupCounts[group]
        : groupCountValues.reduce((sum, count) => sum + count, 0);
    const statusCounts = Object.fromEntries(
      Object.values(ProjectStatus).map((statusKey) => [statusKey, 0]),
    ) as Record<ProjectStatus, number>;
    for (const row of mineStatusRows) statusCounts[row.status] = row._count._all;

    // 脱敏：extra（技能 prompt 快照）不随列表响应返回
    const safeItems = items.map(({
      extra: _extra,
      crmDeliveryLastError: _crmDeliveryLastError,
      crmPayloadSha256: _crmPayloadSha256,
      crmFileManifestSha256: _crmFileManifestSha256,
      ...rest
    }) => {
      if (actor.role === 'legal_bp' && rest.legalBpId === null && rest.ownerId !== actor.id) {
        const { id, kind, title, status, risk, route, legalBpId, createdAt, updatedAt } = rest;
        return { id, kind, title, status, risk, route, legalBpId, createdAt, updatedAt };
      }
      return rest;
    });

    // 按状态分组
    const groups: Record<string, typeof safeItems> = { 待处理: [], 合同协作: [], 已回传: [], 数字分身处理: [] };
    for (const p of safeItems) {
      if (p.kind === 'contract') groups['合同协作'].push(p);
      else if (p.route === 'llm') groups['数字分身处理'].push(p);
      else if (p.status === '已回传' || p.status === '已取消') groups['已回传'].push(p);
      else groups['待处理'].push(p);
    }

    return { items: safeItems, groups, groupCounts, statusCounts, total, page, size };
  }

  /** 详情：含消息/事件/文件；对象级授权(P1-01);extra 脱敏 */
  async findOne(id: string, actor: ProjectActor, cursors: ProjectHistoryCursors = {}) {
    const messageBefore = cursors.beforeMessageId
      ? await this.prisma.projectMessage.findFirst({ where: { id: cursors.beforeMessageId, projectId: id } })
      : null;
    const eventBefore = cursors.beforeEventId
      ? await this.prisma.projectEvent.findFirst({ where: { id: cursors.beforeEventId, projectId: id } })
      : null;
    if ((cursors.beforeMessageId && !messageBefore) || (cursors.beforeEventId && !eventBefore)) {
      throw new BadRequestException('历史游标不存在或不属于该工单');
    }
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
        messages: {
          where: beforeRow(messageBefore),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MESSAGE_PAGE_SIZE + 1,
        },
        events: {
          where: beforeRow(eventBefore),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: EVENT_PAGE_SIZE + 1,
        },
        files: {
          include: { uploader: { select: { id: true, displayName: true, role: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Read, project);

    const pageMessages = project.messages.slice(0, MESSAGE_PAGE_SIZE).reverse();
    const events = project.events.slice(0, EVENT_PAGE_SIZE).reverse();
    const answerIds = pageMessages.map((message) => message.id);
    const researchRuns = answerIds.length
      ? await this.prisma.consultationRun.findMany({
          where: {
            answerMessageId: { in: answerIds },
            status: 'succeeded',
            researchTrace: { not: Prisma.JsonNull },
          },
          select: { answerMessageId: true, capability: true, researchTrace: true },
        })
      : [];
    const traceByAnswerId = new Map(
      researchRuns
        .filter((run) => run.answerMessageId)
        .map((run) => [run.answerMessageId!, { capability: run.capability, trace: run.researchTrace }]),
    );
    const messages = pageMessages.map((message) => ({
      ...message,
      ...(traceByAnswerId.has(message.id) ? { research: traceByAnswerId.get(message.id) } : {}),
    }));

    const {
      extra: _extra,
      messages: _messages,
      crmDeliveryLastError: _crmDeliveryLastError,
      crmPayloadSha256: _crmPayloadSha256,
      crmFileManifestSha256: _crmFileManifestSha256,
      ...safeProject
    } = project;
    return {
      ...safeProject, messages, events,
      history: {
        beforeMessageId: project.messages.length > MESSAGE_PAGE_SIZE ? messages[0].id : null,
        beforeEventId: project.events.length > EVENT_PAGE_SIZE ? events[0].id : null,
      },
    };
  }
}

function beforeRow(row: { id: string; createdAt: Date } | null) {
  return row ? { OR: [
    { createdAt: { lt: row.createdAt } },
    { createdAt: row.createdAt, id: { lt: row.id } },
  ] } : undefined;
}
