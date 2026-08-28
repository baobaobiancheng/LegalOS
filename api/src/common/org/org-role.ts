import type { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';

/**
 * 组织架构角色解析（用户决策 A，2026-08-11）：
 * 个人映射(CAS_ROLE_MAP，按账号) > 部门映射(CAS_DEPT_MAP，按钉钉部门) > 默认 business。
 * 登录(casLogin)与钉钉同步(绑定/重算/解绑)共用同一解析器，保证角色判定一致（review 2026-08-11 P1）。
 */
const VALID_ROLES = new Set<Role>(['admin', 'legal_bp', 'legal_lead', 'business']);

function parseRoleMap(raw: string): Record<string, Role> {
  const map: Record<string, Role> = {};
  for (const pair of raw.split(',')) {
    const [key, role] = pair.split(':').map((s) => s.trim());
    if (key && VALID_ROLES.has(role as Role)) map[key.toLowerCase()] = role as Role;
  }
  return map;
}

function personalRole(
  identity: string | undefined,
  config: Pick<ConfigService, 'get'>,
): Role | undefined {
  if (!identity) return undefined;
  return parseRoleMap(config.get('CAS_ROLE_MAP') || '')[identity.trim().toLowerCase()];
}

function departmentRole(
  dept: string | undefined,
  config: Pick<ConfigService, 'get'>,
): Role | undefined {
  if (!dept) return undefined;
  return parseRoleMap(config.get('CAS_DEPT_MAP') || '')[dept.trim().toLowerCase()];
}

export function resolveOrgRole(
  identity: string | undefined,
  dept: string | undefined,
  config: Pick<ConfigService, 'get'>,
): Role {
  return personalRole(identity, config) ?? departmentRole(dept, config) ?? 'business';
}

/**
 * 应用组织架构角色（用户决策 2026-08-11）：
 * 个人显式映射是管理员授权的权威配置，可以晋升或降级任何已有角色；
 * 未配置个人映射时，已有 admin 仍受保护，不会因部门同步或缺少部门而降级。
 */
export function applyOrgRole(
  existingRole: Role,
  identity: string | undefined,
  dept: string | undefined,
  config: Pick<ConfigService, 'get'>,
): Role {
  const personal = personalRole(identity, config);
  if (personal) return personal;
  if (existingRole === 'admin') return 'admin';
  return departmentRole(dept, config) ?? 'business';
}
