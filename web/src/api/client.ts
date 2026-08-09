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

type RequestOptions = { method?: string; body?: unknown; retry?: boolean; timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 30_000

/** 从响应头读取请求 ID(服务端 X-Request-ID),供错误详情与排查 */
function readRequestId(response: Response): string | undefined {
  const id = response.headers.get('x-request-id')
  return id && id.length <= 64 ? id : undefined
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, retry = true, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  // 超时用 AbortController;AbortError 映射为可识别错误(不自动重放)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
  } catch (e) {
    // 网络中断 / 超时 / 域名失败：fetch 抛 TypeError/AbortError
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    throw new RequestError({
      error: aborted ? '请求超时,请重试' : '网络异常,请检查连接后重试',
      code: aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      statusCode: 0,
    })
  } finally {
    clearTimeout(timer)
  }

  const requestId = readRequestId(response)

  // accessToken 过期时静默刷新并重试一次(401 会话恢复失败是预期降级,不显示为系统故障)
  if (response.status === 401 && retry && path !== '/auth/refresh') {
    if (await refreshAccessToken()) {
      return request<T>(path, { ...options, retry: false })
    }
  }

  if (response.status === 204) return undefined as T

  const payload = (await response.json().catch(() => ({
    error: '服务响应异常',
    code: 'BAD_RESPONSE',
    statusCode: response.status,
  }))) as ApiError

  // 服务端未带 requestId(如 BAD_RESPONSE 兜底)时,补上响应头里的
  if (!payload.requestId && requestId) payload.requestId = requestId

  if (!response.ok) throw new RequestError(payload)
  return payload as unknown as T
}
