import { Response } from 'express';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';

/**
 * 将 Codex 子进程的 stdout 以 SSE 流式推送到前端。
 *
 * 抽取自 ProjectController.createMessage，供业务咨询 / 合同协作等多处复用（DRY）。
 * 工程评审决策 #9：消除 SSE 推送逻辑重复。
 *
 * 事件格式：
 *   data: { text: "<增量>" }     逐字增量
 *   data: { done: true, ... }    正常结束（附加 donePayload，如 { projectId }）
 *   data: { error: true, ... }   失败 / 异常退出
 */
export function sendSSE(
  res: Response,
  stream: ChildProcess,
  donePayload: Record<string, unknown> = {},
): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // StringDecoder 自动处理跨 chunk 的多字节 UTF-8 字符
  const decoder = new StringDecoder('utf8');

  stream.stdout?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  });

  stream.on('close', (code) => {
    // 客户端已断开（刷新/切页）时无需推送，落库由 service 的 close handler 完成
    if (res.destroyed || res.writableEnded) return;
    // 刷新 decoder 剩余缓冲
    const remaining = decoder.end();
    if (remaining) {
      res.write(`data: ${JSON.stringify({ text: remaining })}\n\n`);
    }
    if (code === 0) {
      res.write(`data: ${JSON.stringify({ done: true, ...donePayload })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: true, message: 'AI 答复生成失败' })}\n\n`);
    }
    res.end();
  });

  stream.on('error', () => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ error: true, message: '服务异常' })}\n\n`);
    res.end();
  });

  // 客户端断开时【不终止子进程】——让 Codex 跑完并落库（工程决策 2026-08-03）：
  // 刷新/切页 ≠ 生成失败，用户下次打开工单可见完整草稿；
  // 真正失败（Codex 退出非 0 / 超时 kill）才走 service 的失败路径（status→待处理）
  res.on('close', () => {
    /* 有意为之：不 kill */
  });
}
