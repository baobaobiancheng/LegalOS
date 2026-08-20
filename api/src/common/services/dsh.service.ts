import { EventEmitter } from 'events';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CodexExecutionCancelledError,
  CodexExecutionQueueService,
  CodexQueueBusyError,
} from './codex-execution-queue.service';

/** dsh 侧类型（ESM-only，运行时按需 import；这里只声明调用方需要的最小结构方便类型检查）。 */
interface DshContext {
  get(key: string): unknown;
  on(event: 'session/event', listener: (session: any, event: any) => void): () => void;
  fiber: { dispose(): Promise<void> };
}

export interface DshOptions {
  model?: string;
  /** 单轮任务的整体超时（毫秒）；dsh 本身没有整段 wall-clock 超时，这层由 DshService 自己包装（迁移覆盖清单 #8） */
  timeout?: number;
  /** 隔离会话 ID（如 projectId），映射为 dsh 的 session id；同会话任务严格串行（复用 CodexExecutionQueueService） */
  sessionId?: string;
  /** 排队超时（毫秒），覆盖默认 */
  queueTimeoutMs?: number;
  /** 调用方取消信号（HTTP/SSE 连接断开），取消排队或终止已启动任务 */
  signal?: AbortSignal;
}

/**
 * dsh 单轮任务的语义化事件句柄：不伪装成 ChildProcess（stdout/close），
 * 直接对应 dsh 的 session 事件模型（assistant/chunk 文本增量 + turn/end 结果）。
 * 事件：
 *   'text'      (delta: string)               — 模型输出的文本增量
 *   'done'      (result: { text: string })     — turn 正常完成，text 为最终完整文本
 *   'cancelled' ()                             — 排队中或执行中被取消（调用方应跳过落库，视为"未完成"而非"失败"）
 *   'error'     (error: Error)                 — turn 异常结束（超时/网关错误/AI 禁用等）
 */
export class DshExecutionHandle extends EventEmitter {}

/** AI 禁用/排队被取消时返回的伪句柄：立即 emit 对应事件，调用方走既有失败/取消分支。 */
function disabledHandle(message: string): DshExecutionHandle {
  const handle = new DshExecutionHandle();
  setImmediate(() => handle.emit('error', new Error(message)));
  return handle;
}

function cancelledHandle(): DshExecutionHandle {
  const handle = new DshExecutionHandle();
  setImmediate(() => handle.emit('cancelled'));
  return handle;
}

/**
 * DshService — LegalOS 的 AI 执行引擎（Codex CLI 子进程 → dsh 库嵌入 迁移，Phase 1/2）。
 *
 * 与 CodexService 的关系：
 * - 复用 CodexExecutionQueueService 做全局并发 + per-session 互斥（该队列本身与 Codex 无关，见迁移计划）。
 * - 不复用 CodexService 的 ChildProcess 伪装：dsh 的真实模型是 session 事件（assistant/chunk/turn/end），
 *   直接暴露语义化事件（'text'/'done'/'error'/'cancelled'），比伪造 stdout/close 更贴近底层、更易扩展
 *   （后续多轮对话、工具调用不需要再往假 stdout 里塞新语义）。
 * - dsh 是纯 ESM 包，NestJS 是 CJS：boot() 通过动态 import() 调用，且只在首次使用时启动一次（常驻），
 *   不是每次任务都重新 boot。
 *
 * 会话持久化（D1 决策）：dsh 侧用默认 JSONL（$DSH_HOME/sessions，指向 LegalOS 工作区下的独立目录，
 * 不与其他 dsh 安装混用），LegalOS 业务表（ContractGenerationRun 等）继续只存结构化结果摘要，
 * 双写、互不依赖。
 */
@Injectable()
export class DshService {
  private readonly logger = new Logger(DshService.name);
  private readonly dshHome: string;
  private readonly gatewayBaseUrl: string;
  private readonly gatewayApiKeyEnv = 'LLM_API_KEY';
  private readonly defaultModel: string;
  private bootPromise: Promise<DshContext> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: CodexExecutionQueueService,
  ) {
    this.dshHome = this.config.get('DSH_HOME') || join(process.cwd(), '.tmp', 'dsh-home');
    mkdirSync(this.dshHome, { recursive: true });
    this.gatewayBaseUrl = this.config.get('LLM_BASE_URL', 'http://api-cybotforge-pre.brapp.com/v1');
    this.defaultModel = this.config.get('LLM_MODEL', 'glm-5-2');
    this.logger.log(`dsh 库嵌入：DSH_HOME=${this.dshHome} 网关=${this.gatewayBaseUrl} 模型=${this.defaultModel}`);
  }

  /** AI Kill Switch：AI_EXECUTION_ENABLED=false / 0 / off 时拦截所有 AI 调用（与 CodexService 语义一致）。 */
  private aiEnabled(): boolean {
    const v = String(this.config.get('AI_EXECUTION_ENABLED', 'true')).toLowerCase();
    return !['false', '0', 'off', 'no', 'disabled'].includes(v);
  }

  /**
   * 首次调用时启动常驻 dsh Context；此后所有任务复用同一个 Context（多个 agent 并存于同一棵树），
   * 不是每个任务各 boot 一次。dsh 是 ESM-only，这里用动态 import() 从 CJS 调用方桥接。
   */
  private async ensureBooted(): Promise<DshContext> {
    if (!this.bootPromise) {
      this.bootPromise = this.bootDsh().catch((error) => {
        this.bootPromise = undefined; // 启动失败不缓存，允许下次任务重试
        throw error;
      });
    }
    return this.bootPromise;
  }

  private async bootDsh(): Promise<DshContext> {
    process.env.DSH_HOME = this.dshHome;
    const { boot } = await import('@deepseek-ai/dsh-app-boot');
    const configPath = join(process.cwd(), 'dsh-config', 'cordis.yml');
    const apiKey = this.config.get('LLM_API_KEY') || this.config.get('CODEX_API_KEY');
    if (apiKey) process.env[this.gatewayApiKeyEnv] = apiKey;

    const patches = [
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            'legalos-gateway': {
              api: 'openai-completions',
              displayName: 'LegalOS 法务网关',
              baseURL: this.gatewayBaseUrl,
              apiKeyEnv: this.gatewayApiKeyEnv,
              models: [
                {
                  id: this.defaultModel,
                  contextWindow: Number(this.config.get('CONSULT_CONTEXT_MAX_TOKENS', 12000)),
                  maxTokens: Number(this.config.get('CONSULT_OUTPUT_TOKEN_RESERVE', 16000)),
                  input: ['text'],
                  reasoningEfforts: false,
                },
              ],
            },
          },
        },
      },
      {
        id: 'agent-default-model',
        config: { provider: 'legalos-gateway', model: this.defaultModel },
      },
    ];

    this.logger.log('dsh boot() 启动中...');
    const ctx = (await boot('legalos-dsh', configPath, patches)) as unknown as DshContext;
    this.logger.log('dsh 树已就绪（常驻）');
    return ctx;
  }

  /**
   * 单轮任务：经共享有界队列（复用 CodexExecutionQueueService），获得全局槽位 + session 槽位后
   * 创建一个 dsh agent，followup 一条用户消息，流式转发文本增量，turn 结束后 emit 'done'/'error'。
   *
   * 接口对齐 CodexService.executeStream 的调用惯例（timeout/sessionId/queueTimeoutMs/signal），
   * 但返回值是语义化的 DshExecutionHandle，不是 ChildProcess——调用方需要监听
   * 'text'/'done'/'error'/'cancelled' 而不是 stdout.on('data')/on('close')。
   */
  async executeStream(prompt: string, options?: DshOptions): Promise<DshExecutionHandle> {
    if (!this.aiEnabled()) {
      this.logger.warn('DshService executeStream 被拦截：AI_EXECUTION_ENABLED=false');
      return disabledHandle('AI 执行已禁用（AI_EXECUTION_ENABLED=false）');
    }

    const sessionId = options?.sessionId;
    const timeout = options?.timeout ?? 120_000;

    try {
      return await this.queue.run(
        { sessionId, queueTimeoutMs: options?.queueTimeoutMs, signal: options?.signal },
        (abort) => this.runTurn(prompt, { model: options?.model, sessionId, timeout, abort }),
      );
    } catch (e) {
      if (e instanceof CodexExecutionCancelledError) return cancelledHandle();
      if (e instanceof CodexQueueBusyError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  /**
   * 队列取消信号 + 本任务超时合并成一个 AbortSignal，唯一转达给 driveAgent。
   * done 完全由 driveAgent 的 Promise 决定——超时/取消不再自行 emit 终态事件或提前
   * resolve done，而是请求 dsh agent 真正 cancel()，等 driveAgent 确认 turn 已停止后，
   * 由它自己（且只有它）emit 一次终态事件。这保证：
   *   1) 每次任务只有一个终态事件（不会出现 timeout 之后 driveAgent 又迟到 emit 一次）；
   *   2) done 只有在 dsh 真正停止后才 resolve，队列（session 互斥槶位）不会提前释放。
   */
  private runTurn(
    prompt: string,
    params: { model?: string; sessionId?: string; timeout: number; abort: AbortSignal },
  ): { result: DshExecutionHandle; done: Promise<void> } {
    const handle = new DshExecutionHandle();

    const combinedAbort = new AbortController();
    const onQueueAbort = () => combinedAbort.abort(new Error('dsh 任务已取消'));
    params.abort.addEventListener('abort', onQueueAbort, { once: true });

    const timer = setTimeout(() => {
      this.logger.warn(`dsh 任务超时（${params.timeout}ms），请求取消`);
      combinedAbort.abort(new Error(`dsh 执行超时（${params.timeout}ms）`));
    }, params.timeout);
    timer.unref?.();

    const done = this.driveAgent(prompt, params, handle, combinedAbort.signal)
      .catch((error: unknown) => {
        handle.emit('error', error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        clearTimeout(timer);
        params.abort.removeEventListener('abort', onQueueAbort);
      });

    return { result: handle, done };
  }

  private async driveAgent(
    prompt: string,
    params: { model?: string; sessionId?: string },
    handle: DshExecutionHandle,
    abort: AbortSignal,
  ): Promise<void> {
    if (abort.aborted) {
      handle.emit('cancelled');
      return;
    }

    const ctx = await this.ensureBooted();
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const { SessionId } = await import('@deepseek-ai/dsh-session');
    const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
    const { randomUUID } = await import('crypto');

    const agents = ctx.get('agents') as any;
    const defaultModel = ctx.get('agentDefaultModel') as any;
    const sessions = ctx.get('sessions') as any;
    if (!agents || !defaultModel || !sessions) {
      throw new Error('dsh 核心服务未就绪（agents/agentDefaultModel/sessions）');
    }

    const selection = defaultModel.currentSelection();
    const model = params.model ?? selection.model;
    // 每次任务独立 dsh session id：agents.create 的 sessionId 必须唯一（dsh SessionStore
    // 对已存在的 id 抛 "session already exists"），同 projectId 的并发/重试生成不能再复用
    // 同一个 dsh session。合同起草/审查是单轮任务，不依赖跨调用会话延续；多轮会话复用
    // 属于二期（法律咨询）的 dsh resume 能力，见迁移计划 Phase 3。
    const dshSessionId = SessionId(`legalos-${randomUUID()}`);

    const { agent } = await agents.create({
      sessionId: dshSessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, { current: { ...selection, model }, assembled: undefined });
      },
    });
    await agent.whenIdle();

    // 创建完成后才能真正 cancel：若创建期间已经被取消，立即请求；否则挂监听，
    // 超时/连接断开时把取消信号真正转达给 dsh（而不是自己在外面伪造一个 cancelled 事件）。
    const onAbort = () => agent.cancel(new Error('dsh 任务已取消'));
    if (abort.aborted) onAbort();
    else abort.addEventListener('abort', onAbort, { once: true });

    let fullText = '';
    const off = ctx.on('session/event', (session: any, event: any) => {
      if (session.id !== dshSessionId) return;
      if (event.type !== 'assistant/chunk') return;
      const chunk = event.data.chunk;
      if (chunk.type === 'text-delta' && chunk.text) {
        fullText += chunk.text;
        handle.emit('text', chunk.text);
      }
    });

    try {
      // 取消可能发生在 create 之后、followup 之前：agent.cancel() 在 idle 阶段只清 inbox，
      // 若不在这里拦住，后面的 followup 会照常启动一个新 turn。已取消则直接收尾。
      if (abort.aborted) {
        handle.emit('cancelled');
        return;
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }));
      await agent.whenIdle();
    } finally {
      off();
      abort.removeEventListener('abort', onAbort);
    }

    await sessions.flush(agent.session);

    const reason = this.readTurnEndReason(agent.session.events);
    if (reason?.kind === 'completed') {
      handle.emit('done', { text: fullText });
    } else if (reason?.kind === 'aborted') {
      handle.emit('cancelled');
    } else {
      const message = reason?.kind === 'error'
        ? `dsh turn 失败：${reason.error?.message ?? '未知错误'}`
        : 'dsh turn 未正常结束';
      handle.emit('error', new Error(message));
    }
  }

  private readTurnEndReason(events: readonly any[]): { kind: string; error?: { message?: string } } | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === 'turn/end') return event.data.reason;
    }
    return undefined;
  }

  getStats() {
    return this.queue.getStats();
  }
}
