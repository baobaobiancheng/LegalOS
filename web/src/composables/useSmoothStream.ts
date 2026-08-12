/**
 * 流式显示调度器（review 2026-08-12 P0：正文一卡一卡）：
 * SSE 高频到达 → pendingBuffer → requestAnimationFrame 每 ~32ms 批量渲染（20-30 FPS）。
 * 积压越多每帧输出越多（≥3 字/帧、按积压 1/8 加速），UI 至多落后真实数据几百毫秒。
 * message_end 用 finalText 权威校准并立即清空缓冲。
 * 只调度文本输出，不解析/不记录正文之外的敏感内容。
 */
export function useSmoothStream() {
  let receivedChunks: string[] = []
  let renderedText = ''
  let frameId: number | null = null
  let lastPaintAt = 0
  let listener: ((text: string) => void) | null = null

  const setListener = (fn: ((text: string) => void) | null) => { listener = fn }

  /** SSE 收到增量：只入队，不直接触发页面更新 */
  const enqueue = (delta: string) => {
    if (!delta) return
    receivedChunks.push(delta)
    schedule()
  }

  /** 完成/中止：取消未决帧、清空积压、以权威文本校准 */
  const finish = (finalText: string) => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
    receivedChunks = []
    renderedText = finalText
    listener?.(finalText)
  }

  /** 当前已渲染文本（供异常/未完成时兜底） */
  const current = () => renderedText

  /** 取消待执行动画帧并清空缓冲（组件卸载/新建会话/网络异常时兜底，防陈旧绘制） */
  const cancel = () => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
    receivedChunks = []
  }

  function schedule() {
    if (frameId !== null) return
    frameId = requestAnimationFrame((now) => {
      frameId = null
      // 每帧至少 32ms 才渲染一次（~30 FPS），避免逐 token 重排
      if (now - lastPaintAt < 32) {
        schedule()
        return
      }
      lastPaintAt = now
      const pending = receivedChunks.join('')
      if (pending.length) {
        // 积压越多，每帧消耗越多；至少 3 字/帧
        const count = Math.min(pending.length, Math.max(3, Math.ceil(pending.length / 8)))
        renderedText += pending.slice(0, count)
        receivedChunks = [pending.slice(count)]
      }
      listener?.(renderedText)
      if (receivedChunks.length && receivedChunks[0].length) schedule()
    })
  }

  return { setListener, enqueue, finish, cancel, current }
}
