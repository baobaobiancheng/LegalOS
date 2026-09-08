import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

const ACTIVE_LEGAL_ROLES: readonly Role[] = [Role.legal_bp, Role.legal_lead];
type LegalAssigneeDb = Pick<Prisma.TransactionClient, 'user' | 'bpDomainMap'>;

export interface ActiveLegalAssignee {
  id: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  dingtalkUserId: string | null;
}

/** 人工指派的唯一有效性口径：账号启用且当前仍是法务角色。 */
export async function requireActiveLegalAssignee(
  db: LegalAssigneeDb,
  userId: string,
): Promise<ActiveLegalAssignee> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, role: true, isActive: true, dingtalkUserId: true },
  });
  if (!user || !user.isActive || !ACTIVE_LEGAL_ROLES.includes(user.role)) {
    throw new ForbiddenException('目标用户不是法务 BP（账号须启用）');
  }
  return user;
}

/** 自动匹配只选择启用、仍具法务角色且已绑定钉钉的人员。 */
export async function matchActiveLegalAssignee(
  db: LegalAssigneeDb,
  domain: string | null,
): Promise<string | null> {
  if (domain) {
    const mappings = await db.bpDomainMap.findMany({
      where: {
        domain,
        user: {
          isActive: true,
          role: { in: [...ACTIVE_LEGAL_ROLES] },
          dingtalkUserId: { not: null },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 1,
      select: { userId: true },
    });
    if (mappings[0]) return mappings[0].userId;
  }
  const lead = await db.user.findFirst({
    where: { role: 'legal_lead', isActive: true, dingtalkUserId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return lead?.id ?? null;
}
