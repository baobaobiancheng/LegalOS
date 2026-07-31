import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { request, setAccessToken, getAccessToken } from '../api/client'
import type { User, Role } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const resolved = ref(false)

  const isLoggedIn = computed(() => Boolean(user.value))
  const currentRole = computed<Role | null>(() => user.value?.role ?? null)

  async function login(username: string, password: string) {
    const data = await request<{ accessToken: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    })
    setAccessToken(data.accessToken)
    user.value = data.user
    resolved.value = true
    return data.user
  }

  /**
   * 恢复会话：内存无 token 时先尝试 refresh（httpOnly cookie 自动携带）
   */
  async function fetchMe() {
    try {
      if (!getAccessToken()) {
        const data = await request<{ accessToken: string }>('/auth/refresh', {
          method: 'POST',
        })
        setAccessToken(data.accessToken)
      }
      user.value = await request<User>('/auth/me')
    } catch {
      setAccessToken(null)
      user.value = null
    } finally {
      resolved.value = true
    }
    return user.value
  }

  async function logout() {
    await request<void>('/auth/logout', { method: 'POST' }).catch(() => undefined)
    setAccessToken(null)
    user.value = null
  }

  return { user, resolved, isLoggedIn, currentRole, login, fetchMe, logout }
})
