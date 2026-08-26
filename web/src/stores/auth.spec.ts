import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../api/client', () => ({
  request: vi.fn(),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(),
}))

import { useAuthStore } from './auth'
import { request, setAccessToken } from '../api/client'

describe('auth store 登录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('casLogin: 调 /auth/cas-login 存 token 并设 user', async () => {
    vi.mocked(request).mockResolvedValue({
      accessToken: 'at-1',
      user: { id: 'u1', username: 'zhenghe.bao', role: 'business', displayName: '包正和' },
    })
    const store = useAuthStore()
    const user = await store.casLogin('zhenghe.bao', 'pw-123')

    expect(request).toHaveBeenCalledWith('/auth/cas-login', {
      method: 'POST',
      body: { username: 'zhenghe.bao', password: 'pw-123' },
    })
    expect(setAccessToken).toHaveBeenCalledWith('at-1')
    expect(user.role).toBe('business')
    expect(store.isLoggedIn).toBe(true)
  })

  it('signIn: 本地开发种子账号走 /auth/login', async () => {
    vi.mocked(request).mockResolvedValue({
      accessToken: 'local-at',
      user: { id: 'local-admin', username: 'admin', role: 'admin', displayName: '管理员' },
    })
    const store = useAuthStore()
    await store.signIn(' admin ', 'local-password')

    expect(request).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'local-password' },
    })
  })

  it('signIn: 非种子账号走 /auth/cas-login，不回退本地认证', async () => {
    vi.mocked(request).mockResolvedValue({
      accessToken: 'cas-at',
      user: { id: 'cas-user', username: 'zhenghe.bao', role: 'business', displayName: '包正和' },
    })
    const store = useAuthStore()
    await store.signIn(' zhenghe.bao ', 'cas-password')

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('/auth/cas-login', {
      method: 'POST',
      body: { username: 'zhenghe.bao', password: 'cas-password' },
    })
  })
})
