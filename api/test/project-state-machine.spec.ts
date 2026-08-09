import { describe, it, expect } from 'vitest';
import { ProjectStateMachine } from '../src/modules/project/domain/project-state-machine';

/**
 * P2-01 状态机：合法迁移通过,非法迁移拒绝;终态不可变。
 */
describe('ProjectStateMachine', () => {
  const sm = new ProjectStateMachine();

  it('分析中 → 已回传/待处理/待复核/已取消(合法)', () => {
    expect(sm.canTransition('分析中', '已回传')).toBe(true);
    expect(sm.canTransition('分析中', '待处理')).toBe(true);
    expect(sm.canTransition('分析中', '待复核')).toBe(true);
    expect(sm.canTransition('分析中', '已取消')).toBe(true);
  });

  it('待处理 → 待复核/已回传/已取消(合法)', () => {
    expect(sm.canTransition('待处理', '待复核')).toBe(true);
    expect(sm.canTransition('待处理', '已回传')).toBe(true);
    expect(sm.canTransition('待处理', '已取消')).toBe(true);
  });

  it('待复核 → 已回传/已取消(合法)', () => {
    expect(sm.canTransition('待复核', '已回传')).toBe(true);
    expect(sm.canTransition('待复核', '已取消')).toBe(true);
  });

  it('终态(已回传/已取消)不可再迁移', () => {
    expect(sm.canTransition('已回传', '待复核')).toBe(false);
    expect(sm.canTransition('已回传', '待处理')).toBe(false);
    expect(sm.canTransition('已取消', '待复核')).toBe(false);
    expect(sm.canTransition('已取消', '分析中')).toBe(false);
  });

  it('同状态视为合法(幂等 PATCH)', () => {
    expect(sm.canTransition('已回传', '已回传')).toBe(true);
    expect(sm.canTransition('待复核', '待复核')).toBe(true);
  });
});
