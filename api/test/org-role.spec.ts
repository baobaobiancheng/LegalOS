import { describe, it, expect } from 'vitest';
import { resolveOrgRole, applyOrgRole } from '../src/common/org/org-role';

const cfg = (over: Record<string, string> = {}) => ({
  get: (k: string) =>
    ({
      CAS_ROLE_MAP: 'xin.yan:admin,junfang.zhao:legal_lead',
      CAS_DEPT_MAP: '合规一组:legal_bp,合规二组:legal_bp,法务一组:legal_bp,合规三组:legal_bp',
      ...over,
    })[k] ?? undefined,
});

describe('org-role 组织架构角色解析', () => {
  it('个人映射 > 部门映射 > business', () => {
    expect(resolveOrgRole('xin.yan', '合规一组', cfg())).toBe('admin'); // 个人赢
    expect(resolveOrgRole('junfang.zhao', '法务一组', cfg())).toBe('legal_lead'); // 个人赢
    expect(resolveOrgRole('yuxin.peng', '合规一组', cfg())).toBe('legal_bp'); // 部门赢
    expect(resolveOrgRole('jun.wang1', '合规二组', cfg())).toBe('legal_bp');
    expect(resolveOrgRole('staff.a', '法务一组', cfg())).toBe('legal_bp');
    expect(resolveOrgRole('staff.b', '合规三组', cfg())).toBe('legal_bp');
    expect(resolveOrgRole('zhenghe.bao', '研发部', cfg())).toBe('business'); // 默认
  });

  it('applyOrgRole：个人显式映射可调整 admin，未映射的既有 admin 仍受保护', () => {
    expect(applyOrgRole('business', 'xin.yan', '合规一组', cfg())).toBe('admin');
    expect(applyOrgRole('admin', 'junfang.zhao', '法务一组', cfg())).toBe('legal_lead');
    expect(applyOrgRole('admin', 'legacy.admin', '研发部', cfg())).toBe('admin');
    expect(applyOrgRole('legal_bp', 'zhenghe.bao', '研发部', cfg())).toBe('business'); // 非 admin 可降级
  });

  it('部门名称匹配忽略大小写并清理首尾空格', () => {
    expect(resolveOrgRole('staff', ' 合规一组 ', cfg())).toBe('legal_bp');
  });
});
