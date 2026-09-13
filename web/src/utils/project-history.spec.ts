import { describe, expect, it } from 'vitest'
import { prependProjectHistory } from './project-history'
import type { ProjectDetail } from '../types'

describe('工单历史合并', () => {
  it('去重后保留当前消息和最新内容，并区分消息/事件身份', () => {
    const current = [{ id: 'm2', role: 'assistant' as const, text: '当前版本', createdAt: '2026-09-02' }]
    const page = {
      messages: [{ ...current[0], text: '旧版本' }, { id: 'm1', role: 'user', text: '旧问题', createdAt: '2026-09-01' }],
      events: [{ id: 'm2', text: '同 ID 事件', createdAt: '2026-09-03' }],
    } as ProjectDetail
    const merged = prependProjectHistory(current, page)
    expect(merged.map(item => item.text)).toEqual(['旧问题', '当前版本', '同 ID 事件'])
  })
  it('当前会话尚未回填数据库 ID 的本地消息不互相覆盖', () => {
    const current = ['第一问', '第二问'].map(text => ({ role: 'user', text, createdAt: '2026-09-02' }))
    const merged = prependProjectHistory(current as never[], { messages: [], events: [] } as unknown as ProjectDetail)
    expect(merged.map(item => item.text)).toEqual(['第一问', '第二问'])
  })
})
