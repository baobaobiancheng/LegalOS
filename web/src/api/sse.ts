import { apiFetch, parseApiResponse, readRequestId, RequestError, type RequestOptions } from './client'
import { apiLogger } from './logger'

export type SseEvent = Record<string, unknown>
type EventHandler<T extends SseEvent> = (event: T) => void

const reportSseError = (error: RequestError): RequestError => {
  apiLogger.warn('sse.error', {
    code: error.payload.code,
    statusCode: error.payload.statusCode,
    requestId: error.payload.requestId,
  })
  return error
}

const consumeSseResponse = async <T extends SseEvent>(response: Response, onEvent: EventHandler<T>): Promise<void> => {
  const requestId = readRequestId(response)
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    throw reportSseError(new RequestError({
      error: '服务响应异常，请重试',
      code: 'BAD_RESPONSE',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
  }
  if (!response.body) {
    throw reportSseError(new RequestError({
      error: '流式连接不可用，请重试',
      code: 'SSE_CONNECTION_CLOSED',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''
  let terminalEvent = false

  const dispatch = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) return

    let event: T
    try {
      event = JSON.parse(data) as T
    } catch {
      throw reportSseError(new RequestError({
        error: '流式响应格式异常，请重试',
        code: 'BAD_SSE_EVENT',
        statusCode: response.status,
        ...(requestId ? { requestId } : {}),
      }))
    }
    if (event.done === true || event.error === true) terminalEvent = true
    onEvent(event)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) dispatch(block)
    }
    buffer += decoder.decode()
    if (buffer.trim()) dispatch(buffer)
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw reportSseError(new RequestError({
      error: '流式连接中断，请重试',
      code: 'SSE_CONNECTION_CLOSED',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
  } finally {
    reader.releaseLock()
  }

  if (!terminalEvent) {
    throw reportSseError(new RequestError({
      error: '流式连接意外结束，请重试',
      code: 'SSE_CONNECTION_CLOSED',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
  }
}

/** 所有 POST SSE 统一走这里，不自动重放副作用请求。 */
export async function streamSse<T extends SseEvent = SseEvent>(
  path: string,
  options: Omit<RequestOptions, 'retry'>,
  onEvent: EventHandler<T>,
): Promise<void> {
  const response = await apiFetch(path, { ...options, retry: false })
  if (!response.ok) await parseApiResponse(response)
  await consumeSseResponse(response, onEvent)
}

/** 同一后端接口可能返回 SSE 或普通 JSON（例如风险升级分支）时使用。 */
export async function requestStreamOrJson<T extends SseEvent = SseEvent>(
  path: string,
  options: Omit<RequestOptions, 'retry'>,
  onEvent: EventHandler<T>,
): Promise<T | undefined> {
  const response = await apiFetch(path, { ...options, retry: false })
  if (!response.ok) await parseApiResponse(response)
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    await consumeSseResponse(response, onEvent)
    return undefined
  }
  return parseApiResponse<T>(response)
}
