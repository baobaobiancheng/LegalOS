import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

const ACTIVE_LEGAL_ROLES: readonly Role[] = [Role.legal_bp, Role.legal_lead];
type LegalAssigneeDb = Pick<Prisma.TransactionClient, 'user'>;

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
