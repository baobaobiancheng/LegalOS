import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { existsSync, mkdirSync, rmSync, rmdirSync } from 'fs';
import { join, sep, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import {
  CodexExecutionQueueService,
  CodexExecutionCancelledError,
  CodexQueueBusyError,
} from './codex-execution-queue.service';

/**
 * codex app-server 流式客户端（2026-08-11，review 加固）：
 * 官方高保真协议（换行分隔 JSON），把「思考过程」与「最终内容」分两条流增量输出，
 * 解决 codex exec 普通模式 stdout 整段缓冲导致的：① 前端长静默超时；② 看不到推理过程。
 *
 * 流程：spawn `codex app-server --stdio` → initialize 握手 + `initialized` 通知 →
 *       thread/start 建会话（隔离工作区 + 硬化 CODEX_HOME）→ turn/start 发消息 →
 *       订阅：reasoning/…/delta→thinking 流、agentMessage/delta→stdout 流、turn/completed→结束。
 *
 * 加固（review 2026-08-11）：
 * - initialized 握手缺一不可（否则后续方法报 Not initialized）
 * - 隔离工作区 + 硬化 CODEX_HOME + --strict-config + 结束回收工作区
 * - turn/completed 按 turn.status 判成功（仅 completed→0）
 * - turn 结束即关 stdin 终止常驻子进程，等真实 close 后才释放队列槽位
 * - AI Kill Switch（AI_EXECUTION_ENABLED）与 CodexService 同开关
 * - 取消：turn/interrupt（带 threadId/turnId）+ SIGTERM→SIGKILL 兜底
 */

export interface AppServerStreamOptions {
  sessionId?: string;
  queueTimeoutMs?: number;
  signal?: AbortSignal;
  timeout?: number;
  model?: string;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 换行分隔 JSON 协议客户端（0.146.0 app-server） */
export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private readonly onNotification: (method: string, params: any) => void;
  private readonly child: ChildProcess;

  constructor(child: ChildProcess, onNotification: (method: string, params: any) => void) {
    this.child = child;
    this.onNotification = onNotification;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（如警告）忽略
    }
    if (!msg) return;
    if (typeof msg.id !== 'undefined') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const message =
          typeof msg.error === 'string' ? msg.error : msg.error?.message ?? 'codex app-server 请求失败';
        p.reject(new Error(message));
      } else {
        p.resolve(msg.result);
      }
    } else if (typeof msg.method === 'string') {
      this.onNotification(msg.method, msg.params);
    }
  }

  request<T = unknown>(method: string, params: any): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }
}

/** 连接断开/排队取消返回的伪流：立即 close(null)，标记 __cancelled */
function cancelledStream(): any {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const thinking = new PassThrough();
  const stream = Object.assign(emitter, { stdout, thinking, __cancelled: true });
  setImmediate(() => {
    stdout.end();
    thinking.end();
    emitter.emit('close', null);
  });
  return stream;
}

/** AI Kill Switch 关闭时返回的伪流：close(1) → 走既有失败路径（转人工） */
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
export class CodexAppServerService {
  private readonly logger = new Logger(CodexAppServerService.name);
  private readonly codexBin: string;
  private readonly hardened: boolean;
  private readonly baseWorkspace: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: CodexExecutionQueueService,
  ) {
    this.hardened = this.config.get('CODEX_HARDENED', 'false') === 'true';
    this.codexBin = this.findCodex();
    this.baseWorkspace =
      this.config.get('CODEX_WORKSPACE') || join(process.cwd(), '.tmp', 'codex-workspaces');
    mkdirSync(this.baseWorkspace, { recursive: true });
    this.logger.log(
      `Codex app-server：bin=${this.codexBin} 硬化=${this.hardened ? '开启' : '关闭'} 工作区=${this.baseWorkspace}`,
    );
  }

  private findCodex(): string {
    const envPath = this.config.get('CODEX_PATH');
    if (envPath && existsSync(envPath)) return envPath;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [join(home, '.npm-global', 'bin', 'codex'), 'codex'];
    for (const p of candidates) if (existsSync(p)) return p;
    return 'codex';
  }

  /** AI Kill Switch：与 CodexService 同开关 */
  private aiEnabled(): boolean {
    const v = String(this.config.get('AI_EXECUTION_ENABLED', 'true')).toLowerCase();
    return !['false', '0', 'off', 'no', 'disabled'].includes(v);
  }

  /** 隔离工作区：<base>/<sessionId>/<executionId>，硬化模式内置 .codex（CODEX_HOME） */
  private ensureWorkspace(sessionId?: string, executionId?: string): string {
    const dir = join(
      this.baseWorkspace,
      sessionId ? `${sessionId}/${executionId}` : (executionId ?? randomUUID()),
    );
    mkdirSync(dir, { recursive: true });
    if (this.hardened) mkdirSync(join(dir, '.codex'), { recursive: true });
    return dir;
  }

  /** 结束回收工作区（只删自建目录，baseWorkspace 本身永不删除） */
  private cleanupWorkspace(dir?: string): void {
    if (dir && dir.startsWith(this.baseWorkspace)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        const sessionDir = dirname(dir);
        if (sessionDir !== this.baseWorkspace && sessionDir.startsWith(`${this.baseWorkspace}${sep}`)) {
          try { rmdirSync(sessionDir); } catch { /* 非空或正被其他任务使用 */ }
        }
      } catch { /* ignore */ }
    }
  }

  /** 环境白名单（与 CodexService 硬化一致）：CODEX_HOME 隔离 + 只透传认证/代理变量 */
  private buildSpawnEnv(workspaceDir: string): NodeJS.ProcessEnv {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: this.hardened
        ? join(workspaceDir, '.codex')
        : process.env.CODEX_HOME || join(home, '.codex'),
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
      SHELL: process.env.SHELL,
      NO_COLOR: process.env.NO_COLOR,
    };
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    if (process.env.HTTP_PROXY) env.HTTP_PROXY = process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
    if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY;
    return env;
  }

  /** 流式（思考 + 内容双路）。经共享 Codex 队列；Kill Switch / 排队取消在 spawn 前拦截。 */
  async executeStream(prompt: string, options?: AppServerStreamOptions): Promise<any> {
    if (!this.aiEnabled()) {
      this.logger.warn('app-server executeStream 被拦截：AI_EXECUTION_ENABLED=false');
      return failedStream();
    }
    const opts = options ?? {};
    try {
      return await this.queue.run(
        { sessionId: opts.sessionId, queueTimeoutMs: opts.queueTimeoutMs, signal: opts.signal },
        (abort) => this.spawnStream(prompt, opts, abort),
      );
    } catch (e) {
      if (e instanceof CodexExecutionCancelledError) return cancelledStream();
      if (e instanceof CodexQueueBusyError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  private spawnStream(
    prompt: string,
    opts: AppServerStreamOptions,
    abort: AbortSignal,
  ): { result: any; done: Promise<void> } {
    const executionId = randomUUID();
    const workspaceDir = this.ensureWorkspace(opts.sessionId, executionId);
    const args = ['app-server', '--stdio', ...(this.hardened ? ['--strict-config'] : [])];
    const child = spawn(this.codexBin, args, {
      env: this.buildSpawnEnv(workspaceDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspaceDir,
    });

    const stdout = new PassThrough();
    const thinking = new PassThrough();
    const emitter = new EventEmitter();
    const stream: any = Object.assign(emitter, { stdout, thinking });

    let finalized = false;
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => { doneResolve = r; });
    // 只在子进程真正 close 时收尾（保证槽位不被提前释放）
    const finalize = (code: number) => {
      if (finalized) return;
      finalized = true;
      this.cleanupWorkspace(workspaceDir);
      stdout.end();
      thinking.end();
      emitter.emit('close', code);
      doneResolve();
    };

    // turn 结束/失败/超时：清超时 → 关 stdin 优雅退出 → SIGTERM → SIGKILL 兜底
    let turnExitCode: number | null = null;
    let timer: NodeJS.Timeout | null = null;
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { child.stdin?.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, 2000).unref?.();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 6000).unref?.();
    };

    let threadId = '';
    let turnId = '';
    // ── item 感知组装（review 2026-08-11 P1）：一个 turn 可能有多个 agentMessage item ──
    interface AgentItem {
      phase: string | null; // 'commentary' | 'final_answer' | null
      text: string;
      completed: boolean;
      started: boolean;
    }
    const agentItems = new Map<string, AgentItem>();
    let answerItemId: string | null = null; // 选定的 final_answer item
    let agentItemCount = 0;
    let finalAnswerText = '';
    // 诊断（一）：定位重复是「多 item 拼接」还是「累计快照误当增量」
    const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
    const diag = (msg: string) =>
      this.logger.debug(`[app-server diag] turn=${turnId.slice(0, 8) || '-'} ${msg}`);

    const getItem = (itemId: string): AgentItem => {
      let it = agentItems.get(itemId);
      if (!it) {
        it = { phase: null, text: '', completed: false, started: false };
        agentItems.set(itemId, it);
      }
      return it;
    };

    const client = new AppServerClient(child, (method, params) => {
      switch (method) {
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          if (params?.delta) thinking.write(params.delta);
          break;

        case 'item/started': {
          const item = params?.item;
          if (item?.type === 'agentMessage') {
            const it = getItem(item.id);
            it.started = true;
            it.phase = item.phase ?? null;
            it.text = item.text ?? '';
            agentItemCount++;
            if (item.phase === 'final_answer') {
              answerItemId = item.id;
              finalAnswerText = it.text;
            }
            diag(`item/started id=${item.id.slice(0, 8)} phase=${it.phase} count=${agentItemCount}`);
          }
          break;
        }

        case 'item/agentMessage/delta': {
          const { itemId, delta } = params ?? {};
          if (!itemId || typeof delta !== 'string') break;
          const it = getItem(itemId);
          it.text += delta;
          diag(`delta item=${itemId.slice(0, 8)} phase=${it.phase} add=${delta.length} acc=${it.text.length} sha8=${sha8(delta)}`);
          if (it.phase === 'commentary') {
            thinking.write(delta);
          } else if (it.phase === 'final_answer') {
            if (answerItemId === itemId) {
              stdout.write(delta);
            } else {
              this.logger.warn(
                `第二个 final_answer item ${itemId.slice(0, 8)}（首个 ${answerItemId?.slice(0, 8) ?? '-'}），丢弃增量`,
              );
            }
          } else {
            // phase=null：缓冲，不在流式中展示（final 由 turn/completed 选定）
          }
          break;
        }

        case 'item/completed': {
          const item = params?.item;
          if (item?.type === 'agentMessage') {
            const it = getItem(item.id);
            it.completed = true;
            // item.text 是该 item 权威最终文本（流式累计可能被压缩/修正）
            if (typeof item.text === 'string') it.text = item.text;
            if (it.phase === 'final_answer' && answerItemId === item.id) {
              finalAnswerText = it.text;
            }
            diag(`item/completed id=${item.id.slice(0, 8)} phase=${it.phase} len=${it.text.length} sha8=${sha8(it.text)}`);
          }
          break;
        }

        case 'turn/completed': {
          const status: string | undefined = params?.turn?.status;
          turnExitCode = status === 'completed' ? 0 : 1;
          if (status !== 'completed') {
            this.logger.warn(`app-server turn 状态=${status ?? '未知'}，按失败处理`);
          }
          // 选最终答案：绝不拼接多个 agentMessage item
          let final = '';
          if (answerItemId) {
            final = agentItems.get(answerItemId)?.text ?? '';
          } else {
            let last: AgentItem | null = null;
            for (const it of agentItems.values()) if (it.completed) last = it;
            final = last?.text ?? '';
          }
          if (final && finalAnswerText && final !== finalAnswerText) {
            this.logger.warn(
              `流式累计与 completed 权威文本不一致（${final.length} vs ${finalAnswerText.length}），以 completed 为准`,
            );
          }
          final = final || finalAnswerText;
          // 权威快照交给 SSE done 事件与落库（前端用赋值替换,不再 ++）
          stream.__finalText = final;
          stream.__answerItemId = answerItemId;
          diag(`turn/completed agentItemCount=${agentItemCount} finalLen=${final.length} sha8=${sha8(final)}`);
          shutdown();
          break;
        }

        case 'error':
          this.logger.error(`app-server error 通知：${params?.error ?? JSON.stringify(params)}`);
          turnExitCode = 1;
          shutdown();
          break;
        default:
          break;
      }
    });

    // 只由子进程真实 close 收尾
    child.on('close', (code) => {
      finalize(turnExitCode ?? (code === 0 ? 0 : code ?? 1));
    });
    child.on('error', (e) => {
      this.logger.error(`app-server 子进程错误：${e.message}`);
      finalize(1);
    });

    // 兜底超时（推理模型长思考也要有上限）
    const timeoutMs = opts.timeout ?? 120_000;
    timer = setTimeout(() => {
      this.logger.warn(`app-server SSE 超时（${timeoutMs}ms），终止子进程`);
      turnExitCode = 1;
      shutdown();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    // 连接断开 → turn/interrupt（带 threadId/turnId）+ SIGTERM → SIGKILL
    const abortHandler = () => {
      stream.__cancelled = true;
      if (threadId && turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => { /* ignore */ });
      }
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, 0);
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
    };
    abort.addEventListener('abort', abortHandler, { once: true });

    // 启动链路：initialize → initialized 通知 → thread/start → turn/start
    (async () => {
      try {
        await client.request('initialize', {
          clientInfo: { name: 'legalos', title: null, version: '0.1.0' },
          capabilities: null,
        });
        client.notify('initialized', {}); // 握手必需，否则后续方法报 Not initialized
        const threadRes = await client.request<any>('thread/start', {
          cwd: workspaceDir,
          model: opts.model ?? null, // 未指定时用配置默认（/etc/codex/config.toml → glm-5-2/baorong）
          ephemeral: true,
          approvalPolicy: 'never',
        });
        threadId = threadRes?.thread?.id ?? threadRes?.threadId;
        if (!threadId) throw new Error('thread/start 未返回 thread.id');
        const turnRes = await client.request<any>('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          approvalPolicy: 'never',
        });
        turnId = turnRes?.turn?.id ?? '';
      } catch (e) {
        this.logger.error(`app-server 启动链路失败：${e instanceof Error ? e.message : e}`);
        turnExitCode = 1;
        shutdown();
      }
    })();

    return { result: stream, done };
  }
}
