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
})
