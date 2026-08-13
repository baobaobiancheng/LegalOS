import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

/**
 * 咨询直连网关流式客户端（2026-08-12，多轮会话上下文改造）：
 * 法务咨询直接调用公司大模型网关 /v1/chat/completions，不再经 Codex app-server。
 *
 * 依据《咨询直连网关-契约记录》(2026-08-12 服务器实测钉死)：
 *   C3  `delta.reasoning`  —— 思考过程，增量，先于内容
 *   C4  `delta.content`    —— 正式答案，增量，在思考之后
 *   C5  reasoning 与 content 永不同帧（前后两段）
 *   C6  SSE 帧：`data: {...}` 换行分隔、帧间空行、末尾 `data: [DONE]`、无 event: 行
 *   C7  首帧 `delta:{role:"assistant",content:""}` 角色标记帧，不产生输出
 *   C8  max_tokens = 思考 + 答案合计；思考会吃满预算导致 content=null
 *   C9  不打印 prompt/messages/key；日志只记 projectId/runId/耗时/token/HTTP 状态/请求 id
 *
 * 返回与既有 SSE 消费方同构的 stream 对象（stdout/thinking/close/__finalText），
 * sendSSE 可直接复用，前端 SSE 协议零改动。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ConsultationChatStreamOptions {
  /** 输出 token 预算（含思考，见 C8）；默认取 CONSULT_OUTPUT_TOKEN_RESERVE */
  maxTokens?: number;
  /** 请求级超时（毫秒），默认 120s */
  timeout?: number;
  /** 调用方取消信号（SSE 连接断开） */
  signal?: AbortSignal;
  /** 审计标识（仅用于日志，不发送到网关） */
  runId?: string;
  projectId?: string;
}

/** 免责声明末尾最多一次（review 2026-08-12）：去掉重复的免责声明，只保留最后一份 */
function ensureDisclaimerOnce(text: string): string {
  const pattern = /> ⚠️ 本答复由AI生成[^\n]*/g;
  const matches = text.match(pattern);
  if (!matches || matches.length <= 1) return text;
  const last = matches[matches.length - 1];
  const without = text.replace(pattern, '').trimEnd();
  return `${without}\n${last}`;
}

/** 不可用/被拦截时返回的伪流：close(1) 走失败路径（转人工） */
function failedStream(): any {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const thinking = new PassThrough();
  const stream = Object.assign(emitter, { stdout, thinking });
  setImmediate(() => {
    stdout.end();
    thinking.end();
    emitter.emit('close', 1);
  });
  return stream;
}

@Injectable()
export class ConsultationChatService {
  private readonly logger = new Logger(ConsultationChatService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly outputTokenReserve: number;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = String(config.get('LLM_BASE_URL', '')).replace(/\/+$/, '');
    // 共享 key 场景：LLM_API_KEY 优先，回退 CODEX_API_KEY（网关文档 §0 共享 key）
    this.apiKey = String(config.get('LLM_API_KEY', '') || config.get('CODEX_API_KEY', ''));
    this.model = String(config.get('LLM_MODEL', 'glm-5-2'));
    // 输出预算 = 思考 + 答案合计（契约 C8：思考会吃预算）。glm-5-2 支持最大 16000 输出 token，
    // 长法律分析思考可能 5000+，按上限设计。
    this.outputTokenReserve =
      Number.parseInt(String(config.get('CONSULT_OUTPUT_TOKEN_RESERVE', '16000')), 10) || 16000;
    // 生成超时（毫秒）：16000 token 生成需数分钟，120s 会误杀；默认 10 分钟
    this.defaultTimeoutMs =
      Number.parseInt(String(config.get('CONSULT_CHAT_TIMEOUT_MS', '600000')), 10) || 600_000;
    this.logger.log(
      `咨询直连网关：model=${this.model} base=${this.baseUrl || '(未配置 LLM_BASE_URL)'} ` +
        `输出预算=${this.outputTokenReserve} 超时=${this.defaultTimeoutMs}ms AI执行=${this.aiEnabled() ? '允许' : '禁用'}`,
    );
  }

  /** AI Kill Switch：与 CodexService 同开关 */
  private aiEnabled(): boolean {
    const v = String(this.config.get('AI_EXECUTION_ENABLED', 'true')).toLowerCase();
    return !['false', '0', 'off', 'no', 'disabled'].includes(v);
  }

  /**
   * 直连网关非流式单次调用（2026-08-12 风险分类改造）：短超时 + 小 maxTokens。
   * 契约 C1/C2 已验证非流式：`choices[0].message.content` 为答案、`message.reasoning` 为思考。
   * 用于风险分类等"只要一次短答案"的场景，绕开 Codex CLI（Codex 子进程会卡满 90s）。
   * C8/C9：max_tokens 含思考；不打印 prompt/messages/key。
   */
  async complete(
    messages: ChatMessage[],
    options?: { maxTokens?: number; timeout?: number; runId?: string; projectId?: string },
  ): Promise<string> {
    if (!this.aiEnabled()) throw new Error('AI 执行已禁用（AI_EXECUTION_ENABLED=false）');
    if (!this.baseUrl || !this.apiKey) throw new Error('咨询直连网关未配置');
    if (!messages?.length) throw new Error('咨询直连网关收到空 messages，拒绝请求');

    const maxTokens = options?.maxTokens ?? 200;
    const timeoutMs = options?.timeout ?? 15_000;
    const tag = `project=${options?.projectId ?? '-'} run=${options?.runId ?? '-'}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    const t0 = Date.now();
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          max_tokens: maxTokens,
          // 2026-08-13 压测调优：分类关闭思考模式。vLLM 后端 GLM-5 用 chat_template_kwargs.enable_thinking=false，
          // 服务器实测：reasoning=null、content 直接出 JSON、completion 7 token、耗时 0.7s(之前 8-11s)。
          // thinking.type/disable_thinking/reasoning_effort 均无效，仅 chat_template_kwargs 生效。
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // C9：不记录网关错误响应体（可能回显请求内容）；只记状态码
        this.logger.error(`[consult-chat] complete HTTP ${resp.status} ${tag}`);
        throw new Error(`网关 HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as any;
      const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (!content) {
        // C8：思考吃满预算 → content 为空；作为失败处理，由调用方兜底（分类默认 P1）
        this.logger.error(`[consult-chat] complete 空内容 ${tag} elapsed=${Date.now() - t0}ms`);
        throw new Error('网关返回空内容（max_tokens 被思考吃满）');
      }
      this.logger.debug(
        `[consult-chat] complete 完成 ${tag} elapsed=${Date.now() - t0}ms content=${content.length}字`,
      );
      return content;
    } catch (e) {
      const timedOut = controller.signal.aborted;
      this.logger.error(
        `[consult-chat] complete ${timedOut ? `超时(${timeoutMs}ms)` : '失败'} ${tag} elapsed=${Date.now() - t0}ms`,
      );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 直连网关流式生成（thinking + content 双路）。
   * messages 由 ConsultationContextBuilder 构建（system 规则 + 历史 + 当前问题）。
   */
  async stream(messages: ChatMessage[], options?: ConsultationChatStreamOptions): Promise<any> {
    const opts = options ?? {};
    if (!this.aiEnabled()) {
      this.logger.warn('咨询直连网关被拦截：AI_EXECUTION_ENABLED=false');
      return failedStream();
    }
    if (!this.baseUrl) {
      this.logger.error('咨询直连网关未配置 LLM_BASE_URL，拒绝请求');
      return failedStream();
    }
    if (!this.apiKey) {
      this.logger.error('咨询直连网关未配置 LLM_API_KEY/CODEX_API_KEY，拒绝请求');
      return failedStream();
    }
    if (!messages?.length) {
      this.logger.warn('咨询直连网关收到空 messages，拒绝请求');
      return failedStream();
    }

    const maxTokens = opts.maxTokens ?? this.outputTokenReserve;
    const timeoutMs = opts.timeout ?? this.defaultTimeoutMs;

    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const thinking = new PassThrough();
    const stream: any = Object.assign(emitter, { stdout, thinking });

    const controller = new AbortController();
    let finalized = false;
    let fullText = '';
    let fullThinking = '';
    let gatewayRequestId: string | undefined;
    // P0-4 保守防线：检测到连续完全重复的大段后不再展示/累积
    let repeatGuardTriggered = false;

    const finalize = (code: number) => {
      if (finalized) return;
      finalized = true;
      // 权威最终文本交给 SSE done 事件；重复截断 + 免责声明最多一次在此收口
      if (code === 0 && fullText) {
        stream.__finalText = ensureDisclaimerOnce(fullText);
        if (repeatGuardTriggered) stream.__repeatGuard = true;
      }
      stdout.end();
      thinking.end();
      emitter.emit('close', code);
    };

    // 客户端断开 / 超时 → 中止 fetch（F2：区分两种原因，超时=失败、断连=取消）
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeoutTimer.unref?.();
    const abortHandler = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', abortHandler, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener('abort', abortHandler);
    };

    (async () => {
      const t0 = Date.now();
      const tag = `project=${opts.projectId ?? '-'} run=${opts.runId ?? '-'}`;
      try {
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            stream: true,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          // C9 / P2：不记录网关错误响应体（可能回显请求内容，含法律咨询正文）；只记状态码
          this.logger.error(`[consult-chat] HTTP ${resp.status} ${tag}`);
          finalize(1);
          return;
        }
        if (!resp.body) {
          this.logger.error(`[consult-chat] 网关无响应体 ${tag}`);
          finalize(1);
          return;
        }

        // ── SSE 逐行解析（契约 C3/C4/C5/C6/C7）──
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let sawDone = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || !line.startsWith('data:')) continue; // 空行 / 非 data 行忽略
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              sawDone = true;
              break;
            }
            let msg: any;
            try {
              msg = JSON.parse(payload);
            } catch {
              continue; // 坏帧忽略
            }
            if (msg?.id && !gatewayRequestId) gatewayRequestId = String(msg.id);
            const delta = msg?.choices?.[0]?.delta;
            if (delta?.reasoning) {
              fullThinking += delta.reasoning;
              thinking.write(delta.reasoning);
            }
            if (delta?.content) {
              if (repeatGuardTriggered) continue; // 已触发不再累积/写出
              const next = fullText + delta.content;
              // 连续完全一致的大段重复（≥200 字）→ 判定模型循环，只保留第一份
              const block = 200;
              if (next.length >= block * 2) {
                const tail = next.slice(-block);
                const prev = next.slice(-block * 2, -block);
                if (tail === prev) {
                  repeatGuardTriggered = true;
                  this.logger.warn(`[consult-chat] 检测到连续完全重复(≥${block}字)，停止展示 ${tag}`);
                  fullText = next.slice(0, -block);
                  continue;
                }
              }
              fullText = next;
              stdout.write(delta.content);
            }
          }
          if (sawDone) break;
        }
        if (!sawDone) {
          // F1：连接在未发送 [DONE] 时结束（半段答案）→ 按失败处理，不得保存截断的法律答复
          this.logger.error(
            `[consult-chat] 流式连接未收到 [DONE] 即结束（半段答案）${tag} elapsed=${Date.now() - t0}ms`,
          );
          finalize(1);
          return;
        }
        this.logger.debug(
          `[consult-chat] 完成 ${tag} elapsed=${Date.now() - t0}ms ` +
            `tokens(估算)≈${Math.ceil((fullThinking.length + fullText.length) / 1.5)} req=${gatewayRequestId ?? '-'}`,
        );
        finalize(0);
      } catch (e) {
        if (controller.signal.aborted) {
          if (timedOut) {
            // F2：请求超时 ≠ 用户断开 → 失败（前端收到 error，不收到成功 done）
            this.logger.error(
              `[consult-chat] 请求超时(${timeoutMs}ms) ${tag} elapsed=${Date.now() - t0}ms req=${gatewayRequestId ?? '-'}`,
            );
            finalize(1);
          } else {
            // 真实用户断开：取消 ≠ 生成失败
            stream.__cancelled = true;
            this.logger.warn(
              `[consult-chat] 已中止(断连) ${tag} elapsed=${Date.now() - t0}ms req=${gatewayRequestId ?? '-'}`,
            );
            finalize(0);
          }
        } else {
          this.logger.error(
            `[consult-chat] 请求失败 ${tag} elapsed=${Date.now() - t0}ms ${e instanceof Error ? e.message : e}`,
          );
          finalize(1);
        }
      } finally {
        cleanup();
      }
    })();

    return stream;
  }
}
