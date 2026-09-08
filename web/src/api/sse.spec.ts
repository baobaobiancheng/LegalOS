import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamSse } from './sse'

const streamResponse = (chunks: string[], requestId = 'rid-sse') => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': requestId },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('P2-03 SSE client', () => {
  it('跨 chunk 拼接 SSE 事件并要求 terminal done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"text":"你好"}\n\n',
      'data: {"done":true}\n\n',
    ])))
    const events: Record<string, unknown>[] = []

    await streamSse('/stream', { method: 'POST', body: { once: true } }, event => events.push(event))
    expect(events).toEqual([{ text: '你好' }, { done: true }])
  })

  it('新协议 message_start → text_delta → message_end → EOF：成功不报断流', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"message_start","runId":"r1","messageId":"r1"}\n\n',
      'data: {"type":"text_delta","runId":"r1","seq":1,"delta":"你好"}\n\n',
      'data: {"type":"message_end","runId":"r1","seq":2,"messageId":"r1","finalText":"你好"}\n\n',
    ])))
    const events: Record<string, unknown>[] = []
    await streamSse('/stream', { method: 'POST' }, event => events.push(event))
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ type: 'message_end', finalText: '你好' })
  })

  it('新协议 reasoning_delta → text_delta → message_end：成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"reasoning_delta","runId":"r1","seq":1,"delta":"思考"}\n\n',
      'data: {"type":"text_delta","runId":"r1","seq":2,"delta":"答案"}\n\n',
      'data: {"type":"message_end","runId":"r1","seq":3,"messageId":"r1","finalText":"答案"}\n\n',
    ])))
    await expect(streamSse('/stream', { method: 'POST' }, () => undefined)).resolves.toBeUndefined()
  })

  it('type:error → EOF：识别为终止事件', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"error","runId":"r1","seq":1,"code":"AI_GENERATION_FAILED","message":"失败"}\n\n',
    ])))
    const events: Record<string, unknown>[] = []
    await streamSse('/stream', { method: 'POST' }, event => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
  })

  it('AI 搜法 report_completed → EOF：识别为完整报告流', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"research_stage","seq":1,"stage":"recall","status":"running","title":"定位与检索","detail":"检索中"}\n\n',
      'data: {"type":"report_summary","seq":2,"summary":"总结"}\n\n',
      'data: {"type":"report_completed","seq":3,"runId":"r1","conversationId":"c1","turnId":"r1","contextVersion":1,"reportId":"d1"}\n\n',
    ])))
    const events: Record<string, unknown>[] = []

    await streamSse('/legal-research/ai/stream', { method: 'POST' }, event => events.push(event))
    expect(events.at(-1)).toMatchObject({ type: 'report_completed', reportId: 'd1' })
  })

  it('有正文但无 message_end 就 EOF：仍报回答不完整（半截断）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"message_start","runId":"r1","messageId":"r1"}\n\n',
      'data: {"type":"text_delta","runId":"r1","seq":1,"delta":"半段答案"}\n\n',
    ])))
    await expect(streamSse('/stream', { method: 'POST' }, () => undefined)).rejects.toMatchObject({
      payload: { code: 'SSE_CONNECTION_CLOSED' },
    })
  })

  it('message_end 被拆成多个网络 chunk：仍能正确解析', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"message_start","runId":"r1","messageId":"r1"}\n\n',
      'data: {"type":"text_delta","runId":"r1","seq":1,"delta":"a"}\n\n',
      'data: {"type":"me', // chunk 边界拆开 message_end
      'ssage_end","runId":"r1","seq":2,"messageId":"r1","finalText":"a"}\n\n',
    ])))
    const events: Record<string, unknown>[] = []
    await streamSse('/stream', { method: 'POST' }, event => events.push(event))
    expect(events.at(-1)).toMatchObject({ type: 'message_end', finalText: 'a' })
  })

  it('坏 SSE JSON 返回 BAD_SSE_EVENT 和 requestId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(['data: {broken}\n\n'])))

    await expect(streamSse('/stream', { method: 'POST' }, () => undefined)).rejects.toMatchObject({
      payload: { code: 'BAD_SSE_EVENT', requestId: 'rid-sse' },
    })
  })

  it('没有 terminal 事件的正常关闭返回 SSE_CONNECTION_CLOSED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(['data: {"text":"partial"}\n\n'])))

    await expect(streamSse('/stream', { method: 'POST' }, () => undefined)).rejects.toMatchObject({
      payload: { code: 'SSE_CONNECTION_CLOSED' },
    })
  })

  it('成功但非 event-stream 返回 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'rid-json' },
    })))

    await expect(streamSse('/stream', { method: 'POST' }, () => undefined)).rejects.toMatchObject({
      payload: { code: 'BAD_RESPONSE', requestId: 'rid-json' },
    })
  })

  it('响应头和首个事件已到达后，停止操作仍会取消正文流', async () => {
    const cancel = vi.fn()
    const abort = new AbortController()
    let firstEvent!: () => void
    const started = new Promise<void>((resolve) => { firstEvent = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openStream('data: {"text":"partial"}\n\n', cancel)))

    const cancelled = expect(streamSse('/stream', { method: 'POST', signal: abort.signal }, firstEvent))
      .rejects.toMatchObject({ payload: { code: 'REQUEST_ABORTED' } })
    await started
    abort.abort()
    await cancelled
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['非法 JSON', 'data: {broken}\n\n', 'BAD_SSE_EVENT'],
    ['事件处理器失败', 'data: {"text":"partial"}\n\n', 'SSE_CONNECTION_CLOSED'],
  ])('%s 后取消仍未关闭的底层流', async (_name, chunk, code) => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openStream(chunk, cancel)))

    await expect(streamSse('/stream', { method: 'POST' }, () => { throw new Error('fixture handler failed') }))
      .rejects.toMatchObject({ payload: { code } })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('正文长时间无新数据时取消读取，清除空闲计时器', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let firstEvent!: () => void
    const started = new Promise<void>((resolve) => { firstEvent = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openStream('data: {"text":"partial"}\n\n', cancel)))

    const timedOut = expect(streamSse('/stream', { method: 'POST' }, firstEvent))
      .rejects.toMatchObject({ payload: { code: 'ANSWER_GENERATION_TIMEOUT' } })
    await started
    await vi.advanceTimersByTimeAsync(120_001)
    await timedOut
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

function openStream(chunk: string, cancel: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)) },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'rid-open' } })
}
