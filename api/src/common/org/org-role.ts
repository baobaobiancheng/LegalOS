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

export function resolveOrgRole(
  identity: string | undefined,
  dept: string | undefined,
  config: Pick<ConfigService, 'get'>,
): Role {
  if (identity) {
    const personal = parseRoleMap(config.get('CAS_ROLE_MAP') || '')[identity.trim().toLowerCase()];
    if (personal) return personal;
  }
  if (dept) {
    const deptRole = parseRoleMap(config.get('CAS_DEPT_MAP') || '')[dept.trim()];
    if (deptRole) return deptRole;
  }
  return 'business';
}
