import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSmoothStream } from './useSmoothStream'

/**
 * 流式调度器（review 2026-08-12 P0）：SSE 入队 → rAF 每 ~32ms 批量渲染；
 * 积压越多每帧输出越多；finish 以 finalText 权威校准并清空缓冲；cancel 停止待执行帧。
 */

function installRaf() {
  let now = 0
  const frames = new Map<number, () => void>()
  let id = 0
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const fid = ++id
    frames.set(fid, () => cb(now))
    return fid
  })
  const caf = vi.fn((fid: number) => { frames.delete(fid) }) // 真实 cancelAnimationFrame 会移除待执行帧
  ;(globalThis as any).requestAnimationFrame = raf
  ;(globalThis as any).cancelAnimationFrame = caf
  ;(globalThis as any).performance = { now: () => now }
  return {
    raf,
    caf,
    /** 推进 33ms 并跑一帧（每帧 ≥32ms 才渲染一次） */
    tick: () => { now += 33; const q = [...frames.values()]; frames.clear(); for (const f of q) f() },
    flush: (n = 60) => { let guard = 0; while (guard++ < n && frames.size) { now += 33; const q = [...frames.values()]; frames.clear(); for (const f of q) f() } },
  }
}

describe('useSmoothStream', () => {
  let clock: ReturnType<typeof installRaf>
  beforeEach(() => { clock = installRaf() })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as any).requestAnimationFrame
    delete (globalThis as any).cancelAnimationFrame
  })

  it('入队后经调度渲染，正文逐步累加', () => {
    const stream = useSmoothStream()
    const texts: string[] = []
    stream.setListener((t) => texts.push(t))

    stream.enqueue('你好')
    stream.enqueue('，世界')
    clock.flush()

    expect(texts.at(-1)).toBe('你好，世界')
  })

  it('积压越多每帧输出越多，最终追上全部内容', () => {
    const stream = useSmoothStream()
    const texts: string[] = []
    stream.setListener((t) => texts.push(t))

    const big = '甲'.repeat(100)
    stream.enqueue(big)
    clock.flush(40) // 40 帧内应追完

    expect(texts.at(-1)).toBe(big)
    expect(stream.current()).toBe(big)
  })

  it('finish 以 finalText 权威校准并清空缓冲', () => {
    const stream = useSmoothStream()
    const texts: string[] = []
    stream.setListener((t) => texts.push(t))

    stream.enqueue('半段')
    stream.finish('完整答案')
    clock.flush()

    expect(texts.at(-1)).toBe('完整答案')
    expect(stream.current()).toBe('完整答案')
    // 不再输出半段
    expect(texts).not.toContain('半段')
  })

  it('cancel 停止待执行帧并清空缓冲，不再更新', () => {
    const stream = useSmoothStream()
    const texts: string[] = []
    stream.setListener((t) => texts.push(t))

    stream.enqueue('将被取消')
    stream.cancel()
    clock.flush()

    expect(texts).toHaveLength(0)
    expect(stream.current()).toBe('')
  })
})
