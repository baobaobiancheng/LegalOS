import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../domain/project-access.types';
import { Prisma, ProjectKind, ProjectStatus } from '@prisma/client';

/** 用户选择器：查询投影统一脱敏,不暴露密码哈希 */
const userSelect = { id: true, username: true, displayName: true, role: true };

export interface ProjectListParams {
  status?: ProjectStatus;
  kind?: ProjectKind;
  group?: ProjectGroupKey;
  mine?: boolean;
  page?: number;
  size?: number;
}

export const PROJECT_GROUP_KEYS = ['待处理', '合同协作', '已回传', '数字分身处理'] as const;
export type ProjectGroupKey = (typeof PROJECT_GROUP_KEYS)[number];
export const isProjectGroupKey = (value: string | undefined): value is ProjectGroupKey =>
  Boolean(value && PROJECT_GROUP_KEYS.includes(value as ProjectGroupKey));

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
    const { status, kind, group, mine, page = 1, size = 20 } = params;
    const baseWhere: Prisma.ProjectWhereInput = mine
      ? { creatorId: actor.id }
      : (this.accessPolicy.listScope(actor) as Prisma.ProjectWhereInput);

    if (status) baseWhere.status = status;
    if (kind) baseWhere.kind = kind;

    const where: Prisma.ProjectWhereInput = group
      ? { AND: [baseWhere, projectGroupWhere(group)] }
      : baseWhere;

    const [items, groupCountValues] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      Promise.all(PROJECT_GROUP_KEYS.map((key) => this.prisma.project.count({
        where: { AND: [baseWhere, projectGroupWhere(key)] },
      }))),
    ]);

    const groupCounts = Object.fromEntries(
      PROJECT_GROUP_KEYS.map((key, index) => [key, groupCountValues[index]]),
    ) as Record<ProjectGroupKey, number>;
    const total = group ? groupCounts[group] : groupCountValues.reduce((sum, count) => sum + count, 0);

    // 脱敏：extra（技能 prompt 快照）不随列表响应返回
    const safeItems = items.map(({ extra: _extra, ...rest }) => rest);

    // 按状态分组
    const groups: Record<string, typeof safeItems> = { 待处理: [], 合同协作: [], 已回传: [], 数字分身处理: [] };
    for (const p of safeItems) {
      if (p.kind === 'contract') groups['合同协作'].push(p);
      else if (p.route === 'llm') groups['数字分身处理'].push(p);
      else if (p.status === '已回传' || p.status === '已取消') groups['已回传'].push(p);
      else groups['待处理'].push(p);
    }

    return { items: safeItems, groups, groupCounts, total, page, size };
  }

  /** 详情：含消息/事件/文件；对象级授权(P1-01);extra 脱敏 */
  async findOne(id: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
        messages: { orderBy: { createdAt: 'asc' }, take: 200 },
        events: { orderBy: { createdAt: 'asc' }, take: 100 },
        files: { include: { uploader: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Read, project);

    const answerIds = project.messages.map((message) => message.id);
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
    const messages = project.messages.map((message) => ({
      ...message,
      ...(traceByAnswerId.has(message.id) ? { research: traceByAnswerId.get(message.id) } : {}),
    }));

    const { extra: _extra, messages: _messages, ...safeProject } = project;
    return { ...safeProject, messages };
  }
}
