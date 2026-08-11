import { describe, it, expect } from 'vitest';
import { resolveOrgRole, applyOrgRole } from '../src/common/org/org-role';

const cfg = (over: Record<string, string> = {}) => ({
  get: (k: string) =>
    ({ CAS_ROLE_MAP: 'junfang.zhao:legal_lead', CAS_DEPT_MAP: '法务部:legal_bp', ...over })[k] ?? undefined,
});

describe('org-role 组织架构角色解析', () => {
  it('个人映射 > 部门映射 > business', () => {
    expect(resolveOrgRole('junfang.zhao', '法务部', cfg())).toBe('legal_lead'); // 个人赢
    expect(resolveOrgRole('yuxin.peng', '法务部', cfg())).toBe('legal_bp'); // 部门赢
    expect(resolveOrgRole('zhenghe.bao', '研发部', cfg())).toBe('business'); // 默认
  });

  it('applyOrgRole：已有 admin 不降级（平台管理员手动/种子授予）', () => {
    expect(applyOrgRole('admin', 'junfang.zhao', '法务部', cfg())).toBe('admin'); // admin 保留
    expect(applyOrgRole('legal_bp', 'junfang.zhao', '法务部', cfg())).toBe('legal_lead'); // 非 admin 正常映射
    expect(applyOrgRole('legal_bp', 'zhenghe.bao', '研发部', cfg())).toBe('business'); // 非 admin 可降级
  });
});
