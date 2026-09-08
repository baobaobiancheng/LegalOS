import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, getAccessToken, request, RequestError, setAccessToken } from './client'
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
  vi.useRealTimers()
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

  it('收到响应头后，调用方仍可中止正文流并释放监听', async () => {
    const abort = new AbortController()
    const removeListener = vi.spyOn(abort.signal, 'removeEventListener')
    let transportSignal: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      transportSignal = init.signal!
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        },
      })))
    }))

    const response = await apiFetch('/download', { signal: abort.signal })
    const consumed = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await consumed
    expect(transportSignal!.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('刷新超时后释放单飞状态，下一次请求可以重新刷新', async () => {
    vi.useFakeTimers()
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1
        if (refreshCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        }
        return Promise.resolve(jsonResponse({ accessToken: 'recovered-token' }))
      }
      return Promise.resolve(getAccessToken() === 'recovered-token'
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: '未登录', code: 'UNAUTHORIZED' }, 401))
    }))

    const failed = expect(request('/first')).rejects.toMatchObject({ payload: { statusCode: 401 } })
    await vi.advanceTimersByTimeAsync(10_001)
    await failed
    await expect(request('/second')).resolves.toEqual({ ok: true })
    expect(refreshCalls).toBe(2)
  })

  it.each([null, 'new-login-token'])('刷新期间会话变为 %s 时，迟到响应不能覆盖新状态', async (nextToken) => {
    let resolveRefresh!: (response: Response) => void
    const refreshStarted = new Promise<void>((started) => {
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url === '/api/auth/refresh') {
          return new Promise<Response>((resolve) => {
            resolveRefresh = resolve
            started()
          })
        }
        return Promise.resolve(jsonResponse({ error: '未登录', code: 'UNAUTHORIZED' }, 401))
      }))
    })
    setAccessToken('expired-token')
    const failed = expect(request('/session')).rejects.toMatchObject({ payload: { statusCode: 401 } })
    await refreshStarted
    setAccessToken(nextToken)
    resolveRefresh(jsonResponse({ accessToken: 'stale-refresh-token' }))
    await failed
    expect(getAccessToken()).toBe(nextToken)
  })

  it('日志上下文会脱敏，不输出 token、body 等秘密字段', () => {
    expect(redactApiLogContext({ requestId: 'rid', authorization: 'Bearer secret', body: { password: 'p' } })).toEqual({
      requestId: 'rid',
      authorization: '[REDACTED]',
      body: '[REDACTED]',
    })
  })
})
