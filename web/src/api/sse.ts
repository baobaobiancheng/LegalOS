import { apiFetch, parseApiResponse, readRequestId, RequestError, type RequestOptions } from './client'
import { apiLogger } from './logger'

export type SseEvent = Record<string, unknown>
type EventHandler<T extends SseEvent> = (event: T) => void

/** 终止事件判定（2026-08-12 review P0）：兼容新旧协议。
 *  旧协议 `{done:true}/{error:true}`；新咨询协议 `{type:'message_end'}/{type:'error'}`。
 *  只有收到终止事件才算业务完成——不能靠 HTTP EOF 推测（半截断流仍要报错）。 */
export const isTerminalEvent = (event: SseEvent): boolean =>
  event.done === true ||
  event.error === true ||
  event.type === 'message_end' ||
  event.type === 'error'

/** 咨询流式协议（2026-08-12，与后端 sendConsultSSE 对齐）：runId/seq 去重，messageId 唯一节点 */
export type ConsultStreamEvent =
  | { type: 'message_start'; runId: string; messageId: string }
  | { type: 'reasoning_delta'; runId: string; seq: number; delta: string }
  | { type: 'text_delta'; runId: string; seq: number; delta: string }
  | { type: 'message_end'; runId: string; seq: number; messageId: string; finalText: string }
  | { type: 'error'; runId: string; seq: number; code: string; message: string }

const reportSseError = (error: RequestError): RequestError => {
  apiLogger.warn('sse.error', {
    code: error.payload.code,
    statusCode: error.payload.statusCode,
    requestId: error.payload.requestId,
  })
  return error
}

/** 流式空闲超时（2026-08-11）：长静默期（推理模型思考）不超时，只在「很久没有任何数据」时中断。 */
const SSE_IDLE_TIMEOUT_MS = 120_000

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
  // 空闲超时：每收到一个 chunk 重置；超时 → 取消读取并报「请求超时」（推理模型长思考不误杀）
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      reader.cancel().catch(() => {})
    }, SSE_IDLE_TIMEOUT_MS)
  }
  const clearIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

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
    if (isTerminalEvent(event)) terminalEvent = true
    onEvent(event)
  }

  try {
    while (true) {
      armIdleTimer()
      const { done, value } = await reader.read()
      clearIdleTimer()
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
    if (idleTimedOut) {
      throw reportSseError(new RequestError({
        error: '请求超时，请重试',
        code: 'REQUEST_TIMEOUT',
        statusCode: response.status,
        ...(requestId ? { requestId } : {}),
      }))
    }
    throw reportSseError(new RequestError({
      error: '流式连接中断，请重试',
      code: 'SSE_CONNECTION_CLOSED',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
  } finally {
    clearIdleTimer()
    reader.releaseLock()
  }

  // reader.cancel() 后 read() 通常以 done 正常结束而非抛错,此处兜底判空闲超时
  if (idleTimedOut) {
    throw reportSseError(new RequestError({
      error: '请求超时，请重试',
      code: 'REQUEST_TIMEOUT',
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
    }))
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
