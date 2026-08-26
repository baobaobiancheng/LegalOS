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

  /** CAS 登录（T3 修订）：登录页账号密码 → 后端走 CAS 方式一校验 */
  async function casLogin(username: string, password: string) {
    const data = await request<{ accessToken: string; user: User }>('/auth/cas-login', {
      method: 'POST',
      body: { username, password },
    })
    setAccessToken(data.accessToken)
    user.value = data.user
    resolved.value = true
    return data.user
  }

  /**
   * 统一登录入口：生产与预发始终走 CAS；本地开发仅固定种子账号走密码旁路。
   * CAS 失败不降级到本地认证，避免形成隐式绕过路径。
   */
  async function signIn(username: string, password: string) {
    const normalizedUsername = username.trim()
    const localSeedUsers = new Set(['admin', 'legal_bp', 'business'])
    return import.meta.env.DEV && localSeedUsers.has(normalizedUsername)
      ? login(normalizedUsername, password)
      : casLogin(normalizedUsername, password)
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

  return { user, resolved, isLoggedIn, currentRole, login, casLogin, signIn, fetchMe, logout }
})
