import type { ApiError } from '../types'

/** accessToken 存内存（Pinia），不落 localStorage，防 XSS */
let accessToken: string | null = null
let refreshing: Promise<boolean> | null = null

export const setAccessToken = (token: string | null) => { accessToken = token }
export const getAccessToken = () => accessToken

export class RequestError extends Error {
  constructor(readonly payload: ApiError) {
    super(payload.error)
  }
}

/** 单飞刷新：并发 401 只触发一次 refresh */
async function refreshAccessToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) return false
      const data = (await response.json()) as { accessToken: string }
      accessToken = data.accessToken
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

type RequestOptions = { method?: string; body?: unknown; retry?: boolean }

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, retry = true } = options

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  // accessToken 过期时静默刷新并重试一次
  if (response.status === 401 && retry && path !== '/auth/refresh') {
    if (await refreshAccessToken()) {
      return request<T>(path, { ...options, retry: false })
    }
  }

  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => ({
    error: '服务响应异常',
    code: 'BAD_RESPONSE',
    statusCode: response.status,
  }))

  if (!response.ok) throw new RequestError(payload as ApiError)
  return payload as T
}
