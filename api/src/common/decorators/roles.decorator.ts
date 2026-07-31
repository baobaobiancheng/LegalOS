import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** RBAC 角色声明，配合 RolesGuard 使用 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
