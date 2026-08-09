import { describe, it, expect } from 'vitest'
import { PROJECT_STATUS_META, ALL_PROJECT_STATUSES, isStatusInGroup, statusAllowsAction, statusClass } from './project-status'

describe('P2-02 唯一状态配置', () => {
  it('五种状态各有唯一配置且穷尽（新增状态未配置会编译失败）', () => {
    expect(ALL_PROJECT_STATUSES).toHaveLength(5)
    expect(Object.keys(PROJECT_STATUS_META).sort()).toEqual(['已回传', '已取消', '待处理', '待复核', '分析中'].sort())
  })

  it('processing 分组包含 待处理（回归：P2-02 修复）', () => {
    for (const s of ['分析中', '待处理', '待复核'] as const) {
      expect(isStatusInGroup(s, 'processing')).toBe(true)
    }
    // 终态不进入 processing
    expect(isStatusInGroup('已回传', 'processing')).toBe(false)
    expect(isStatusInGroup('已取消', 'processing')).toBe(false)
  })

  it('动作配置：待复核可 reply/transfer,已回传为终态仅 view', () => {
    expect(statusAllowsAction('待复核', 'reply')).toBe(true)
    expect(statusAllowsAction('待复核', 'transfer')).toBe(true)
    expect(PROJECT_STATUS_META['已回传'].terminal).toBe(true)
    expect(statusAllowsAction('已回传', 'cancel')).toBe(false)
    expect(statusAllowsAction('已取消', 'transfer')).toBe(false)
  })

  it('稳定 tone class(不直接用中文值)', () => {
    expect(statusClass('已回传')).toBe('status-success')
    expect(statusClass('已取消')).toBe('status-neutral')
    expect(statusClass('待处理')).toBe('status-warning')
  })
})
