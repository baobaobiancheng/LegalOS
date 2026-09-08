import type { ApiError } from '../types'
import { apiLogger } from './logger'

/** accessToken 存内存（Pinia），不落 localStorage，防 XSS */
let accessToken: string | null = null
let refreshing: Promise<boolean> | null = null
let authGeneration = 0

export const setAccessToken = (token: string | null) => {
  accessToken = token
  authGeneration += 1
}
export const getAccessToken = () => accessToken

export class RequestError extends Error {
  constructor(readonly payload: ApiError) {
    super(payload.error)
    this.name = 'RequestError'
  }
}

/** 单飞刷新：并发 401 只触发一次 refresh */
async function refreshAccessToken(): Promise<boolean> {
  const generation = authGeneration
  refreshing ??= (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      })
      if (!response.ok) return false
      const text = await response.text()
      const data = JSON.parse(text) as { accessToken?: string }
      if (!data.accessToken) return false
      // logout/重新登录发生在 refresh 飞行期间时，迟到响应不得恢复旧会话。
      if (generation !== authGeneration) return false
      accessToken = data.accessToken
      return true
    } catch (error) {
      apiLogger.warn('auth.refresh_failed', { reason: error instanceof Error ? error.name : 'unknown' })
      return false
    } finally {
      clearTimeout(timer)
      refreshing = null
    }
  })()
  return refreshing
}

export type RequestOptions = {
  method?: string
  body?: unknown
  retry?: boolean
  timeoutMs?: number
  /** 阶段化超时错误码（2026-08-12 P1）：区分建单/SSE 头/回答生成哪个阶段超时，便于定位 */
  timeoutCode?: string
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000

/** 从响应头读取请求 ID(服务端 X-Request-ID),供错误详情与排查 */
export function readRequestId(response: Response): string | undefined {
  const id = response.headers.get('x-request-id')
  return id && id.length <= 64 ? id : undefined
}

const isSafeRetryMethod = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())

const toErrorPayload = (statusCode: number, requestId?: string, payload?: unknown): ApiError => {
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string') {
    const value = payload as ApiError
    return { ...value, statusCode: value.statusCode || statusCode, requestId: value.requestId || requestId }
  }
  return {
    error: '服务响应异常，请稍后重试',
    code: 'BAD_RESPONSE',
    statusCode,
    ...(requestId ? { requestId } : {}),
  }
}

/** 将一次响应解析为 JSON；预期 JSON 的 2xx 非 JSON 也必须失败。 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T

  const requestId = readRequestId(response)
  const text = await response.text()
  let parsed: unknown
  let isJson = false
  if (text.trim()) {
    try {
      parsed = JSON.parse(text)
      isJson = true
    } catch {
      isJson = false
    }
  }

  if (!response.ok) {
    const error = new RequestError(toErrorPayload(response.status, requestId, isJson ? parsed : undefined))
    apiLogger.warn('http.error', { statusCode: response.status, requestId, code: error.payload.code })
    throw error
  }

  if (!isJson) {
    const error = new RequestError(toErrorPayload(response.status, requestId))
    apiLogger.warn('http.bad_response', { statusCode: response.status, requestId, code: error.payload.code })
    throw error
  }
  return parsed as T
}

/** 发起 API 请求并处理安全方法的单飞刷新；POST 等副作用请求绝不自动重放。 */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, retry = true, timeoutMs = DEFAULT_TIMEOUT_MS, timeoutCode = 'REQUEST_TIMEOUT', signal } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }

  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        Accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    const requestError = new RequestError({
      error: timedOut ? '请求超时，请重试' : aborted ? '请求已取消' : '网络异常，请检查连接后重试',
      code: timedOut ? timeoutCode : aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
      statusCode: 0,
    })
    apiLogger.warn('http.transport_error', { path, method, code: requestError.payload.code })
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', abortFromCaller)
    throw requestError
  }
  clearTimeout(timer)
  response = keepCallerAbortUntilBodyEnds(response, signal, abortFromCaller)

  const requestId = readRequestId(response)
  // 只有 GET/HEAD/OPTIONS 可安全重放；POST 401 必须让调用方决定，避免重复业务写入。
  if (response.status === 401 && retry && path !== '/auth/refresh' && isSafeRetryMethod(method)) {
    // refresh 失败时仍需向调用方返回原始 401 契约；先完整读取，
    // 同时让 caller abort listener 在 body 结束时正常释放。
    const unauthorizedBody = await response.arrayBuffer()
    const unauthorizedResponse = new Response(unauthorizedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    if (await refreshAccessToken()) return apiFetch(path, { ...options, retry: false })
    return unauthorizedResponse
  }
  if (response.status === 401 && retry && path !== '/auth/refresh' && !isSafeRetryMethod(method)) {
    apiLogger.warn('http.unsafe_401_no_replay', { path, method, requestId, statusCode: response.status })
  }
  return response
}

function keepCallerAbortUntilBodyEnds(
  response: Response,
  signal: AbortSignal | undefined,
  abortFromCaller: () => void,
): Response {
  if (!signal) return response
  if (!response.body) {
    signal.removeEventListener('abort', abortFromCaller)
    return response
  }
  const reader = response.body.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    signal.removeEventListener('abort', abortFromCaller)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          finish()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        finish()
      }
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return parseApiResponse<T>(await apiFetch(path, options))
}

export async function requestForm<T>(path: string, formData: FormData, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
  return parseApiResponse<T>(await apiFetch(path, { ...options, body: formData }))
}

export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await apiFetch(path, options)
  if (!response.ok) await parseApiResponse(response)
  return response.blob()
}
