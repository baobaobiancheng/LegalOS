import { Prisma } from '@prisma/client';

export const aiProjectVersionSelect = {
  updatedAt: true,
  route: true,
  status: true,
  result: true,
  reviewStatus: true,
  ownerId: true,
  legalBpId: true,
} satisfies Prisma.ProjectSelect;

export type AiProjectVersion = Prisma.ProjectGetPayload<{
  select: typeof aiProjectVersionSelect;
}>;

/**
 * AI 写回只认启动时看到的工单版本。状态、人工结果或指派任一变化都会让 CAS 失败；
 * 显式递增 updatedAt，避免同一毫秒内两个 AI 完成者都命中旧版本。
 */
export function aiProjectVersionWhere(
  projectId: string,
  version: AiProjectVersion,
): Prisma.ProjectWhereInput {
  return {
    id: projectId,
    updatedAt: version.updatedAt,
    route: version.route,
    status: version.status,
    result: version.result,
    reviewStatus: version.reviewStatus,
    ownerId: version.ownerId,
    legalBpId: version.legalBpId,
  };
}

export function nextProjectVersion(version: AiProjectVersion): Date {
  return new Date(Math.max(Date.now(), version.updatedAt.getTime() + 1));
}
