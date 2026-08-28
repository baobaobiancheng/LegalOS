import { Injectable } from '@nestjs/common';
import { Prisma, ProjectStatus, RiskLevel, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const PROCESSING_STATUSES = [ProjectStatus.分析中, ProjectStatus.待处理, ProjectStatus.待复核];
const RESEARCH_FAILURE_ACTIONS = [
  'ai.legal_research.degraded',
  'ai.legal_research.failed',
  'ai.run.degraded',
];
const ACTIVITY_ACTIONS = [
  'project.transfer',
  'project.reply',
  'project.cancel',
  'member.bind',
  'member.unbind',
  'member.bp_scope.change',
  'ai.legal_research.succeeded',
  'ai.legal_research.degraded',
  'ai.legal_research.failed',
  'ai.run.degraded',
  'contract.download',
  'consultation_record.download',
];

type TrendCountRow = { day: Date | string; total: bigint | number | string };

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(days: 7 | 30 = 30) {
    const now = new Date();
    const todayStart = startOfShanghaiDay(now);
    const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
    const periodStart = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
    const staleBefore = new Date(now.getTime() - DAY_MS);

    const [
      createdToday,
      pending,
      highRisk,
      periodCreated,
      periodAi,
      stale,
      evidenceFailures,
      createdTrendRows,
      returnedTrendRows,
      workloadRows,
      legalMembers,
      activityRows,
    ] = await Promise.all([
      this.prisma.project.count({ where: { createdAt: { gte: todayStart, lt: tomorrowStart } } }),
      this.prisma.project.count({ where: { status: { in: PROCESSING_STATUSES } } }),
      this.prisma.project.count({ where: { risk: RiskLevel.P0, status: { in: PROCESSING_STATUSES } } }),
      this.prisma.project.count({ where: { createdAt: { gte: periodStart, lt: tomorrowStart } } }),
      this.prisma.project.count({ where: { createdAt: { gte: periodStart, lt: tomorrowStart }, route: 'llm' } }),
      this.prisma.project.count({ where: { status: { in: PROCESSING_STATUSES }, updatedAt: { lt: staleBefore } } }),
      this.prisma.auditEvent.count({
        where: {
          occurredAt: { gte: periodStart, lt: tomorrowStart },
          OR: [
            { action: { in: RESEARCH_FAILURE_ACTIONS } },
            { action: 'ai.run.failed', reasonCode: { startsWith: 'RESEARCH_' } },
          ],
        },
      }),
      this.prisma.$queryRaw<TrendCountRow[]>(Prisma.sql`
        SELECT DATE(DATE_ADD(created_at, INTERVAL 8 HOUR)) AS day, COUNT(*) AS total
        FROM projects
        WHERE created_at >= ${periodStart} AND created_at < ${tomorrowStart}
        GROUP BY DATE(DATE_ADD(created_at, INTERVAL 8 HOUR))
        ORDER BY day ASC
      `),
      this.prisma.$queryRaw<TrendCountRow[]>(Prisma.sql`
        SELECT DATE(DATE_ADD(occurred_at, INTERVAL 8 HOUR)) AS day, COUNT(*) AS total
        FROM audit_events
        WHERE occurred_at >= ${periodStart}
          AND occurred_at < ${tomorrowStart}
          AND (
            (action = 'project.reply' AND outcome = 'success')
            OR (action = 'ai.run.succeeded' AND outcome = 'success')
            OR (action = 'ai.run.degraded' AND outcome = 'partial')
          )
        GROUP BY DATE(DATE_ADD(occurred_at, INTERVAL 8 HOUR))
        ORDER BY day ASC
      `),
      this.prisma.project.groupBy({
        by: ['legalBpId'],
        where: { legalBpId: { not: null }, status: { in: PROCESSING_STATUSES } },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: { isActive: true, role: { in: [Role.legal_bp, Role.legal_lead] } },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.auditEvent.findMany({
        where: { action: { in: ACTIVITY_ACTIONS } },
        select: {
          id: true,
          action: true,
          actorId: true,
          projectId: true,
          outcome: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: 6,
      }),
    ]);

    const actorIds = [...new Set(activityRows.flatMap((event) => event.actorId ? [event.actorId] : []))];
    const projectIds = [...new Set(activityRows.flatMap((event) => event.projectId ? [event.projectId] : []))];
    const [actors, activityProjects] = await Promise.all([
      actorIds.length
        ? this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } })
        : [],
      projectIds.length
        ? this.prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true } })
        : [],
    ]);

    const actorNames = new Map<string, string>(
      actors.map((actor): [string, string] => [actor.id, actor.displayName]),
    );
    const projectTitles = new Map<string, string>(
      activityProjects.map((project): [string, string] => [project.id, project.title]),
    );
    const workloadCounts = new Map(
      workloadRows.flatMap((row) => row.legalBpId ? [[row.legalBpId, row._count._all] as const] : []),
    );
    const workload = legalMembers
      .map((member) => {
        const count = workloadCounts.get(member.id) ?? 0;
        return {
          id: member.id,
          name: member.displayName,
          count,
          level: count >= 8 ? 'busy' : count >= 5 ? 'normal' : 'idle',
        } as const;
      })
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'))
      .slice(0, 5);

    return {
      period: {
        days,
        from: periodStart.toISOString(),
        to: tomorrowStart.toISOString(),
      },
      summary: {
        createdToday,
        pending,
        highRisk,
        aiHandlingRate: periodCreated ? Math.round((periodAi / periodCreated) * 100) : 0,
      },
      trend: buildTrend(days, periodStart, createdTrendRows, returnedTrendRows),
      attention: {
        highRisk,
        stale,
        evidenceFailures,
      },
      workload,
      activities: activityRows.map((event) => ({
        id: event.id,
        tone: activityTone(event.action, event.outcome),
        text: activityText(
          event.action,
          event.actorId ? actorNames.get(event.actorId) : undefined,
          event.projectId ? projectTitles.get(event.projectId) : undefined,
        ),
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }
}

function startOfShanghaiDay(value: Date): Date {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS);
}

function buildTrend(
  days: number,
  periodStart: Date,
  createdRows: TrendCountRow[],
  returnedRows: TrendCountRow[],
) {
  const created = countByDay(createdRows);
  const returned = countByDay(returnedRows);
  return Array.from({ length: days }, (_, index) => {
    const key = shanghaiDateKey(new Date(periodStart.getTime() + index * DAY_MS));
    return { date: key, created: created.get(key) ?? 0, returned: returned.get(key) ?? 0 };
  });
}

function countByDay(rows: TrendCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [databaseDateKey(row.day), Number(row.total)]));
}

function databaseDateKey(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shanghaiDateKey(value: Date): string {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function activityTone(action: string, outcome: string): 'success' | 'info' | 'warning' | 'danger' {
  if (outcome === 'failed') return 'danger';
  if (outcome === 'partial') return 'warning';
  if (action === 'project.cancel' || action === 'member.unbind') return 'warning';
  if (action.includes('succeeded') || action === 'project.reply') return 'success';
  return 'info';
}

function activityText(action: string, actorName?: string, projectTitle?: string): string {
  const actor = actorName || '系统';
  const project = projectTitle ? `“${truncate(projectTitle, 22)}”` : '工单';
  const labels: Record<string, string> = {
    'project.transfer': `${actor}转派了${project}`,
    'project.reply': `${actor}回传了${project}`,
    'project.cancel': `${actor}取消了${project}`,
    'member.bind': `${actor}绑定了钉钉身份`,
    'member.unbind': `${actor}解除了钉钉绑定`,
    'member.bp_scope.change': `${actor}调整了 BP 工作范围`,
    'ai.legal_research.succeeded': 'AI 法规证据核验完成',
    'ai.legal_research.degraded': 'AI 法规证据核验已降级',
    'ai.legal_research.failed': 'AI 法规证据核验失败',
    'ai.run.degraded': '业务咨询法规证据核验已降级',
    'contract.download': `${actor}下载了合同文件`,
    'consultation_record.download': `${actor}下载了咨询记录`,
  };
  return labels[action] ?? `${actor}完成了平台操作`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
