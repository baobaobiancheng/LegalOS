import { describe, it, expect } from 'vitest'
import { useRemoteData } from './useRemoteData'
import { RequestError } from '../api/client'

describe('P2-03 useRemoteData', () => {
  it('idle → loading → success(data)', async () => {
    const r = useRemoteData(async () => ({ items: [1] }))
    expect(r.status.value).toBe('idle')
    const p = r.load()
    expect(r.status.value).toBe('loading')
    await p
    expect(r.status.value).toBe('success')
    expect(r.data.value).toEqual({ items: [1] })
    expect(r.error.value).toBeNull()
  })

  it('失败 → error(带 requestId),data 保持 null(不伪装成空态)', async () => {
    const r = useRemoteData(async () => {
      throw new RequestError({ error: '禁止访问', code: 'FORBIDDEN', statusCode: 403, requestId: 'rid-123' })
    })
    await r.load()
    expect(r.status.value).toBe('error')
    expect(r.data.value).toBeNull()
    expect(r.error.value?.payload.requestId).toBe('rid-123')
    expect(r.requestId.value).toBe('rid-123')
  })

  it('重试后恢复成功,旧错误清除', async () => {
    let fail = true
    const r = useRemoteData(async () => {
      if (fail) throw new RequestError({ error: '网络异常', code: 'NETWORK_ERROR', statusCode: 0 })
      return { ok: true }
    })
    await r.load()
    expect(r.status.value).toBe('error')
    fail = false
    await r.load()
    expect(r.status.value).toBe('success')
    expect(r.error.value).toBeNull()
    expect(r.requestId.value).toBeUndefined()
  })

  it('非 RequestError 的异常也归一为错误态', async () => {
    const r = useRemoteData(async () => {
      throw new Error('boom')
    })
    await r.load()
    expect(r.status.value).toBe('error')
    expect(r.error.value?.payload.code).toBe('UNKNOWN')
  })
})
