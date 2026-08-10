import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../api/client', () => ({
  request: vi.fn(),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(),
}))

import { useAuthStore } from './auth'
import { request, setAccessToken } from '../api/client'

describe('auth store casLogin（T3）', () => {
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
    const user = await store.casLogin('ticket-abc')

    expect(request).toHaveBeenCalledWith('/auth/cas-login', {
      method: 'POST',
      body: { ticket: 'ticket-abc' },
    })
    expect(setAccessToken).toHaveBeenCalledWith('at-1')
    expect(user.role).toBe('business')
    expect(store.isLoggedIn).toBe(true)
  })
})
