import type { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';

/**
 * 组织架构角色解析（用户决策 A，2026-08-11）：
 * 个人映射(CAS_ROLE_MAP，按账号) > 部门映射(CAS_DEPT_MAP，按钉钉部门) > 默认 business。
 * 登录(casLogin)与钉钉同步(绑定/重算/解绑)共用同一解析器，保证角色判定一致（review 2026-08-11 P1）。
 */
const VALID_ROLES = new Set<Role>(['admin', 'legal_bp', 'legal_lead', 'business']);
type DepartmentInput = string | readonly string[] | undefined;

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

function normalizeDepartments(dept: DepartmentInput): string[] {
  const values = Array.isArray(dept) ? dept : dept ? [dept] : [];
  const seen = new Set<string>();
  const departments: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    const key = normalized?.toLowerCase();
    if (!normalized || !key || seen.has(key)) continue;
    seen.add(key);
    departments.push(normalized);
  }
  return departments;
}

function departmentRole(
  dept: DepartmentInput,
  config: Pick<ConfigService, 'get'>,
): Role | undefined {
  const roleMap = parseRoleMap(config.get('CAS_DEPT_MAP') || '');
  for (const department of normalizeDepartments(dept)) {
    const role = roleMap[department.toLowerCase()];
    if (role) return role;
  }
  return undefined;
}

/**
 * 多部门成员的有效部门：优先选择命中角色映射的部门，避免兼任部门覆盖法务主部门；
 * 都未命中时稳定回退到通讯录顺序中的第一个部门。
 */
export function selectOrgDepartment(
  dept: DepartmentInput,
  config: Pick<ConfigService, 'get'>,
): string | undefined {
  const departments = normalizeDepartments(dept);
  if (!departments.length) return undefined;
  const roleMap = parseRoleMap(config.get('CAS_DEPT_MAP') || '');
  return departments.find((department) => roleMap[department.toLowerCase()]) ?? departments[0];
}

export function resolveOrgRole(
  identity: string | undefined,
  dept: DepartmentInput,
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
  dept: DepartmentInput,
  config: Pick<ConfigService, 'get'>,
): Role {
  const personal = personalRole(identity, config);
  if (personal) return personal;
  if (existingRole === 'admin') return 'admin';
  return departmentRole(dept, config) ?? 'business';
}
