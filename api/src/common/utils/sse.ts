import { Response } from 'express';
import { ChildProcess } from 'child_process';
import { Readable } from 'stream';
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
  stream: ChildProcess & { thinking?: Readable },
  donePayload: Record<string, unknown> = {},
  onDisconnect?: () => void,
): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // StringDecoder 自动处理跨 chunk 的多字节 UTF-8 字符
  const decoder = new StringDecoder('utf8');
  // 思考过程独立流（2026-08-11 app-server）：reasoning delta → data:{thinking}
  const thinkingDecoder = new StringDecoder('utf8');
  // 标记正常结束（done/error 已写入），用于区分"连接断开"与"正常结束"
  let ended = false;

  stream.stdout?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  });

  stream.thinking?.on('data', (chunk: Buffer) => {
    const text = thinkingDecoder.write(chunk);
    if (text) {
      res.write(`data: ${JSON.stringify({ thinking: text })}\n\n`);
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
    const remainingThinking = thinkingDecoder.end();
    if (remainingThinking) {
      res.write(`data: ${JSON.stringify({ thinking: remainingThinking })}\n\n`);
    }
    if (code === 0) {
      ended = true;
      res.write(`data: ${JSON.stringify({ done: true, ...donePayload })}\n\n`);
    } else {
      ended = true;
      res.write(`data: ${JSON.stringify({ error: true, message: 'AI 答复生成失败' })}\n\n`);
    }
    res.end();
  });

  stream.on('error', () => {
    if (res.destroyed || res.writableEnded) return;
    ended = true;
    res.write(`data: ${JSON.stringify({ error: true, message: '服务异常' })}\n\n`);
    res.end();
  });

  // 客户端断开（P1-02 6.2-8）：取消排队中或终止已启动的 Codex 任务，释放队列槽位。
  // 排队任务不 spawn；已启动任务由 CodexService 侧发 SIGTERM → 宽限期后 SIGKILL。
  // 取消后的子进程标记 __cancelled，service 的 close handler 跳过失败落库（刷新 ≠ 生成失败）。
  res.on('close', () => {
    if (!ended && onDisconnect) onDisconnect();
  });
}
