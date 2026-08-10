import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAccessToken, request, RequestError, setAccessToken } from './client'
import { redactApiLogContext } from './logger'

const jsonResponse = (body: unknown, status = 200, requestId?: string) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    ...(requestId ? { 'x-request-id': requestId } : {}),
  },
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setAccessToken(null)
})

describe('P2-03 API client', () => {
  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
  ])('保留 %s 错误体和响应 requestId', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: '业务错误', code, statusCode: status }, status, `rid-${status}`),
    ))

    await expect(request('/case')).rejects.toMatchObject({
      payload: { code, statusCode: status, requestId: `rid-${status}` },
    })
  })

  it('2xx 非 JSON 不能作为成功数据返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', {
      status: 200,
      headers: { 'content-type': 'text/html', 'x-request-id': 'rid-html' },
    })))

    await expect(request('/case')).rejects.toMatchObject({
      payload: { code: 'BAD_RESPONSE', statusCode: 200, requestId: 'rid-html' },
    })
  })

  it('超时转换为可识别 RequestError', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(request('/slow', { timeoutMs: 5 })).rejects.toMatchObject({
      payload: { code: 'REQUEST_TIMEOUT', statusCode: 0 },
    })
  })

  it('并发 GET 401 只触发一次 refresh，并各自重试一次', async () => {
    let resourceCalls = 0
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1
        return Promise.resolve(jsonResponse({ accessToken: 'fresh-token' }))
      }
      resourceCalls += 1
      return Promise.resolve(resourceCalls <= 2
        ? jsonResponse({ error: '过期', code: 'UNAUTHORIZED', statusCode: 401 }, 401)
        : jsonResponse({ ok: true }))
    }))

    const result = await Promise.all([request<{ ok: boolean }>('/one'), request<{ ok: boolean }>('/two')])
    expect(result).toEqual([{ ok: true }, { ok: true }])
    expect(refreshCalls).toBe(1)
    expect(resourceCalls).toBe(4)
    expect(getAccessToken()).toBe('fresh-token')
  })

  it('POST 401 不自动 refresh 或重放，避免重复业务写入', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: '未登录', code: 'UNAUTHORIZED', statusCode: 401 }, 401),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error: unknown = await request('/write', { method: 'POST', body: { once: true } }).catch(e => e)
    expect(error).toBeInstanceOf(RequestError)
    if (error instanceof RequestError) expect(error.payload.statusCode).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('日志上下文会脱敏，不输出 token、body 等秘密字段', () => {
    expect(redactApiLogContext({ requestId: 'rid', authorization: 'Bearer secret', body: { password: 'p' } })).toEqual({
      requestId: 'rid',
      authorization: '[REDACTED]',
      body: '[REDACTED]',
    })
  })
})
