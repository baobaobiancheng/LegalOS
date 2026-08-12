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
      // finalText 是 item 感知组装后的权威快照：前端必须赋值替换，不能继续追加
      res.write(`data: ${JSON.stringify({
        done: true,
        finalText: (stream as any).__finalText ?? undefined,
        answerItemId: (stream as any).__answerItemId ?? undefined,
        ...donePayload,
      })}\n\n`);
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

// ════════════════════════════════════════════════════════════════════
// 咨询流式协议（2026-08-12，P0 有身份的流）：runId/messageId/seq
// 一次 Run = 一个稳定 runId；一次回答 = 一个 messageId（流式用 runId 暂代）；
// seq 严格递增，前端忽略 seq <= lastSeq 的过期/重复事件；message_end 只处理一次；
// finalText 是权威覆盖，绝不追加。仅咨询用；合同模块继续用 sendSSE 旧协议。
// ════════════════════════════════════════════════════════════════════

/** 咨询流式 stream 对象的最小结构（sendSSE/sendConsultSSE 消费） */
export interface SseStream {
  stdout?: Readable;
  thinking?: Readable;
  on(event: string, listener: (...args: any[]) => void): any;
  __finalText?: string;
  __answerItemId?: string | null;
  __cancelled?: boolean;
  __runId?: string;
}

export type ConsultStreamEvent =
  | { type: 'message_start'; runId: string; messageId: string }
  | { type: 'reasoning_delta'; runId: string; seq: number; delta: string }
  | { type: 'text_delta'; runId: string; seq: number; delta: string }
  | { type: 'message_end'; runId: string; seq: number; messageId: string; finalText: string }
  | { type: 'error'; runId: string; seq: number; code: string; message: string };

export function sendConsultSSE(
  res: Response,
  stream: SseStream & { __runId?: string },
  donePayload: Record<string, unknown> = {},
  onDisconnect?: () => void,
): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const decoder = new StringDecoder('utf8');
  const thinkingDecoder = new StringDecoder('utf8');
  const runId = stream.__runId ?? '';
  let seq = 0;
  let started = false;
  let ended = false;
  const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const next = () => ++seq;
  const start = () => {
    if (started) return;
    started = true;
    emit({ type: 'message_start', runId, messageId: runId });
  };

  stream.stdout?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (!text) return;
    start();
    emit({ type: 'text_delta', runId, seq: next(), delta: text });
  });

  stream.thinking?.on('data', (chunk: Buffer) => {
    const text = thinkingDecoder.write(chunk);
    if (!text) return;
    start();
    emit({ type: 'reasoning_delta', runId, seq: next(), delta: text });
  });

  stream.on('close', (code: number) => {
    if (res.destroyed || res.writableEnded) return;
    const remaining = decoder.end();
    if (remaining) {
      start();
      emit({ type: 'text_delta', runId, seq: next(), delta: remaining });
    }
    const remainingThinking = thinkingDecoder.end();
    if (remainingThinking) {
      start();
      emit({ type: 'reasoning_delta', runId, seq: next(), delta: remainingThinking });
    }
    ended = true;
    if (code === 0) {
      emit({
        type: 'message_end',
        runId,
        seq: next(),
        messageId: runId,
        finalText: stream.__finalText ?? '',
        ...donePayload,
      });
    } else {
      emit({ type: 'error', runId, seq: next(), code: 'AI_GENERATION_FAILED', message: 'AI 答复生成失败' });
    }
    res.end();
  });

  stream.on('error', () => {
    if (res.destroyed || res.writableEnded) return;
    ended = true;
    emit({ type: 'error', runId, seq: next(), code: 'SERVICE_ERROR', message: '服务异常' });
    res.end();
  });

  res.on('close', () => {
    if (!ended && onDisconnect) onDisconnect();
  });
}
