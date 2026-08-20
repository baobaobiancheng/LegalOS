import { EventEmitter } from 'events';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiExecutionCancelledError,
  AiExecutionQueueService,
  AiQueueBusyError,
} from './ai-execution-queue.service';
import { DshBaijianToolsService, DSH_BAIJIAN_RESULT_META_KIND } from './dsh-baijian-tools.service';
import {
  DshExecutionResult,
  DshOptions,
  DshToolCallEvent,
  DshToolResultEvent,
  toolNameForCapability,
} from './dsh-agent.types';
import { BaijianNormalizedResult } from '../baijian/baijian.types';

/** dsh 侧类型（ESM-only，运行时按需 import；这里只声明调用方需要的最小结构方便类型检查）。 */
interface DshContext {
  get(key: string): unknown;
  on(event: 'session/event', listener: (session: any, event: any) => void): () => void;
  fiber: { dispose(): Promise<void> };
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
export class DshExecutionHandle extends EventEmitter {
  override on(event: 'text', listener: (delta: string) => void): this;
  override on(event: 'tool_call', listener: (call: DshToolCallEvent) => void): this;
  override on(event: 'tool_result', listener: (result: DshToolResultEvent) => void): this;
  override on(event: 'done', listener: (result: DshExecutionResult) => void): this;
  override on(event: 'cancelled', listener: () => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

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
 * - 复用 AiExecutionQueueService 做全局并发 + per-session 互斥。
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
  private readonly providerId: string;
  private readonly modelBaseUrl: string;
  private readonly modelApiKeyEnv = 'DSH_LLM_API_KEY';
  private readonly defaultModel: string;
  private readonly modelContextWindow: number;
  private readonly maxOutputTokens: number;
  private readonly toolCallLimit: number;
  private bootPromise: Promise<DshContext> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: AiExecutionQueueService,
    private readonly baijianTools: DshBaijianToolsService,
  ) {
    this.dshHome = this.config.get('DSH_HOME') || join(process.cwd(), '.tmp', 'dsh-home');
    mkdirSync(this.dshHome, { recursive: true });
    this.providerId = this.config.get('DSH_LLM_PROVIDER') || 'legalos-dsh';
    this.modelBaseUrl = this.config.get('DSH_LLM_BASE_URL')
      || this.config.get('LLM_BASE_URL', 'http://api-cybotforge-pre.brapp.com/v1');
    this.defaultModel = this.config.get('DSH_LLM_MODEL')
      || this.config.get('LLM_MODEL', 'glm-5-2');
    this.modelContextWindow = positiveInteger(this.config.get('DSH_MODEL_CONTEXT_WINDOW'), 131_072);
    this.maxOutputTokens = positiveInteger(this.config.get('DSH_MODEL_MAX_OUTPUT_TOKENS'), 16_000);
    this.toolCallLimit = positiveInteger(this.config.get('DSH_AGENT_TOOL_CALL_MAX'), 3);
    this.logger.log(`dsh 库嵌入：DSH_HOME=${this.dshHome} provider=${this.providerId} base=${this.modelBaseUrl} 模型=${this.defaultModel}`);
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
    const apiKey = this.config.get('DSH_LLM_API_KEY')
      || this.config.get('LLM_API_KEY')
      || this.config.get('CODEX_API_KEY');
    if (apiKey) process.env[this.modelApiKeyEnv] = apiKey;

    const patches = [
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            [this.providerId]: {
              api: 'openai-completions',
              displayName: 'LegalOS dsh 模型',
              baseURL: this.modelBaseUrl,
              apiKeyEnv: this.modelApiKeyEnv,
              models: [
                {
                  id: this.defaultModel,
                  contextWindow: this.modelContextWindow,
                  maxTokens: this.maxOutputTokens,
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
        config: { provider: this.providerId, model: this.defaultModel },
      },
    ];

    this.logger.log('dsh boot() 启动中...');
    const ctx = (await boot('legalos-dsh', configPath, patches)) as unknown as DshContext;
    this.logger.log('dsh 树已就绪（常驻）');
    return ctx;
  }

  /**
   * 单轮任务：经共享有界队列，获得全局槽位 + session 槽位后
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
        (abort) => this.runTurn(prompt, {
          model: options?.model,
          sessionId,
          timeout,
          abort,
          researchCapability: options?.researchCapability,
          requireResearchTool: options?.requireResearchTool ?? Boolean(options?.researchCapability),
          resumeDshSessionId: options?.resumeDshSessionId,
        }),
      );
    } catch (e) {
      if (e instanceof AiExecutionCancelledError) return cancelledHandle();
      if (e instanceof AiQueueBusyError) throw new ServiceUnavailableException(e.message);
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
    params: Pick<DshOptions, 'model' | 'sessionId' | 'researchCapability' | 'requireResearchTool' | 'resumeDshSessionId'>
      & { timeout: number; abort: AbortSignal },
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
    params: Pick<DshOptions, 'model' | 'sessionId' | 'researchCapability' | 'requireResearchTool' | 'resumeDshSessionId'>,
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
    const dshSessionId = SessionId(params.resumeDshSessionId ?? `legalos-${randomUUID()}`);
    const toolDefinition = params.researchCapability
      ? await this.baijianTools.createDefinition(params.researchCapability)
      : undefined;

    const agentConfig = {
      agentOptions: { provider: selection.provider, model, maxTokens: this.maxOutputTokens },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, { current: { ...selection, model }, assembled: undefined });
        if (toolDefinition) agentCtx.tools.register(toolDefinition);
      },
    };
    const agentHandle = params.resumeDshSessionId
      ? await agents.resume({ resumeSessionId: dshSessionId, ...agentConfig })
      : await agents.create({ sessionId: dshSessionId, meta: { cwd: process.cwd() }, ...agentConfig });
    const { agent } = agentHandle;
    await agent.whenIdle();

    // 创建完成后才能真正 cancel：若创建期间已经被取消，立即请求；否则挂监听，
    // 超时/连接断开时把取消信号真正转达给 dsh（而不是自己在外面伪造一个 cancelled 事件）。
    const onAbort = () => agent.cancel(new Error('dsh 任务已取消'));
    if (abort.aborted) onAbort();
    else abort.addEventListener('abort', onAbort, { once: true });

    let fullText = '';
    const toolCalls: DshToolCallEvent[] = [];
    const toolResults: DshToolResultEvent[] = [];
    const toolNamesByCallId = new Map<string, string>();
    let policyFailure: Error | undefined;
    const off = ctx.on('session/event', (session: any, event: any) => {
      if (session.id !== dshSessionId) return;
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta' && chunk.text) {
          fullText += chunk.text;
          handle.emit('text', chunk.text);
        }
        return;
      }
      if (event.type === 'tool/call') {
        const call: DshToolCallEvent = {
          callId: String(event.data.callId),
          name: String(event.data.name),
          arguments: parseToolArguments(event.data.arguments),
        };
        toolNamesByCallId.set(call.callId, call.name);
        toolCalls.push(call);
        handle.emit('tool_call', call);
        if (toolCalls.length > this.toolCallLimit && !policyFailure) {
          policyFailure = new Error(`dsh Agent 工具调用超过上限（${this.toolCallLimit}）`);
          agent.cancel(policyFailure);
        }
        return;
      }
      if (event.type === 'tool/result') {
        const block = event.data.message?.content?.[0];
        const callId = String(block?.toolCallId ?? event.data.message?.source?.callId ?? '');
        const canonicalResult = readBaijianResultMeta(event.data.meta);
        const result: DshToolResultEvent = {
          callId,
          name: toolNamesByCallId.get(callId) ?? 'unknown',
          isError: Boolean(block?.isError),
          ...(canonicalResult ? { result: canonicalResult } : {}),
          ...(event.data.error ? { error: event.data.error } : {}),
        };
        toolResults.push(result);
        handle.emit('tool_result', result);
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
      await sessions.flush(agent.session);

      const reason = this.readTurnEndReason(agent.session.events);
      if (reason?.kind === 'completed') {
        if (params.researchCapability && params.requireResearchTool) {
          const expectedTool = toolNameForCapability(params.researchCapability);
          const unexpected = toolCalls.find((call) => call.name !== expectedTool);
          if (unexpected) {
            throw new Error(`dsh Agent 调用了白名单外工具：${unexpected.name}`);
          }
          const successful = toolResults.some((result) =>
            result.name === expectedTool && !result.isError && result.result);
          if (!successful) throw new Error(`dsh Agent 未产生必需工具结果：${expectedTool}`);
        }
        handle.emit('done', {
          text: this.readFinalAssistantText(agent.session.events) || fullText,
          dshSessionId: String(dshSessionId),
          toolCalls,
          toolResults,
        } satisfies DshExecutionResult);
      } else if (reason?.kind === 'aborted') {
        if (policyFailure) handle.emit('error', policyFailure);
        else handle.emit('cancelled');
      } else {
        const message = reason?.kind === 'error'
          ? `dsh turn 失败：${reason.error?.message ?? '未知错误'}`
          : 'dsh turn 未正常结束';
        handle.emit('error', new Error(message));
      }
    } finally {
      off();
      abort.removeEventListener('abort', onAbort);
      await agentHandle.dispose();
    }
  }

  private readTurnEndReason(events: readonly any[]): { kind: string; error?: { message?: string } } | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === 'turn/end') return event.data.reason;
    }
    return undefined;
  }

  private readFinalAssistantText(events: readonly any[]): string {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== 'assistant/message') continue;
      return (event.data.message?.content ?? [])
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('')
        .trim();
    }
    return '';
  }

  getStats() {
    return this.queue.getStats();
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(0, 2_000);
  }
}

function readBaijianResultMeta(value: unknown): BaijianNormalizedResult | undefined {
  if (!isRecord(value) || value.kind !== DSH_BAIJIAN_RESULT_META_KIND) return undefined;
  return isRecord(value.result) ? value.result as unknown as BaijianNormalizedResult : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
