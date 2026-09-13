import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { Role } from '../types'

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, createWebHistory: () => createMemoryHistory() }
})
vi.mock('../api/client', () => ({ request: vi.fn() }))
import router from './index'

describe('实际路由配置与角色守卫', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it.each([Role.ADMIN, Role.LEGAL_LEAD, Role.LEGAL_BP])('%s 可以进入法务工单列表和详情路由', async role => {
    const auth = useAuthStore()
    auth.user = { id: 'routing-user', username: 'routing-user', displayName: '测试用户', avatarUrl: null, role }
    auth.resolved = true
    // 不加载页面组件；对真实路由的合并 meta 执行实际守卫。
    const { registerGuards } = await import('./guards')
    const beforeEach = vi.fn()
    registerGuards({ beforeEach } as never)
    const guard = beforeEach.mock.calls[0]![0]
    for (const path of ['/legal/projects', '/legal/projects/test-id']) {
      expect(await guard(router.resolve(path))).toBe(true)
    }
  })

  it('业务角色仍被拒绝进入法务工单和管理员路由', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'biz', username: 'biz', displayName: '业务测试', avatarUrl: null, role: Role.BUSINESS }
    auth.resolved = true
    const { registerGuards } = await import('./guards')
    const beforeEach = vi.fn()
    registerGuards({ beforeEach } as never)
    const guard = beforeEach.mock.calls[0]![0]
    for (const path of ['/legal/projects', '/legal/projects/test-id', '/admin/members']) {
      expect(await guard(router.resolve(path))).toEqual({ name: 'forbidden' })
    }
  })
})
