import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  CodexExecutionQueueService,
  CodexExecutionCancelledError,
  CodexQueueBusyError,
} from './codex-execution-queue.service';

/**
 * codex app-server 流式客户端（2026-08-11）：
 * 官方高保真协议（换行分隔 JSON），把模型「思考过程」与「最终内容」分两条流增量输出，
 * 解决 codex exec 普通模式 stdout 整段缓冲导致的：① 前端长静默超时；② 看不到推理过程。
 *
 * 流程：spawn `codex app-server --stdio` → initialize 握手 → thread/start 建会话 →
 *       turn/start 发消息 → 订阅事件：reasoning/…/delta→thinking 流、agentMessage/delta→stdout 流、
 *       turn/completed→close(0)。
 *
 * 返回与 sendSSE 兼容的对象：{ stdout, thinking, on('close'|'error'), __cancelled }。
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
      // 请求响应：{ id, result } 或 { id, error }
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

@Injectable()
export class CodexAppServerService {
  private readonly logger = new Logger(CodexAppServerService.name);
  private readonly codexBin: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: CodexExecutionQueueService,
  ) {
    this.codexBin = this.findCodex();
    this.logger.log(`Codex app-server 路径：${this.codexBin}`);
  }

  private findCodex(): string {
    const envPath = this.config.get('CODEX_PATH');
    if (envPath && existsSync(envPath)) return envPath;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [join(home, '.npm-global', 'bin', 'codex'), 'codex'];
    for (const p of candidates) if (existsSync(p)) return p;
    return 'codex';
  }

  /** 环境白名单（与 CodexService 硬化一致）：只透传认证/代理变量，不透传服务秘密 */
  private buildSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || process.env.USERPROFILE || '',
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

  /**
   * 流式（思考 + 内容双路）。经共享 Codex 队列获得全局/会话槽位；
   * 排队超时/取消在 spawn 前抛错或返回 cancelled 伪流。
   */
  async executeStream(prompt: string, options?: AppServerStreamOptions): Promise<any> {
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
    const child = spawn(this.codexBin, ['app-server', '--stdio'], {
      env: this.buildSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new PassThrough();
    const thinking = new PassThrough();
    const emitter = new EventEmitter();
    const stream: any = Object.assign(emitter, { stdout, thinking });

    let finalized = false;
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => { doneResolve = r; });
    const finalize = (code: number) => {
      if (finalized) return;
      finalized = true;
      stdout.end();
      thinking.end();
      emitter.emit('close', code);
      doneResolve();
    };

    const client = new AppServerClient(child, (method, params) => {
      switch (method) {
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          if (params?.delta) thinking.write(params.delta);
          break;
        case 'item/agentMessage/delta':
          if (params?.delta) stdout.write(params.delta);
          break;
        case 'turn/completed':
          finalize(0);
          break;
        case 'error':
          this.logger.error(`app-server error 通知：${params?.error ?? JSON.stringify(params)}`);
          finalize(1);
          break;
        default:
          break;
      }
    });

    child.on('close', (code) => {
      finalize(code === 0 ? 0 : code ?? 1);
    });
    child.on('error', (e) => {
      this.logger.error(`app-server 子进程错误：${e.message}`);
      finalize(1);
    });

    // 超时终止（推理模型长思考也要兜底）
    const timeoutMs = opts.timeout ?? 120_000;
    const timer = setTimeout(() => {
      this.logger.warn(`app-server SSE 超时（${timeoutMs}ms），终止子进程`);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finalize(1);
    }, timeoutMs);
    timer.unref?.();

    // 连接断开 → turn/interrupt + 宽限期后 SIGKILL
    const abortHandler = () => {
      stream.__cancelled = true;
      try { client.notify('turn/interrupt', {}); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
    };
    abort.addEventListener('abort', abortHandler, { once: true });

    // 启动链路：initialize → thread/start → turn/start（异步，事件随后到达）
    (async () => {
      try {
        await client.request('initialize', {
          clientInfo: { name: 'legalos', title: null, version: '0.1.0' },
          capabilities: null,
        });
        const threadRes = await client.request<any>('thread/start', {
          cwd: process.cwd(),
          model: opts.model ?? null, // 未指定时用配置默认（/etc/codex/config.toml → glm-5-2/baorong）
          ephemeral: true,
          approvalPolicy: 'never',
        });
        const threadId = threadRes?.thread?.id ?? threadRes?.threadId;
        if (!threadId) throw new Error('thread/start 未返回 thread.id');
        await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          approvalPolicy: 'never',
        });
      } catch (e) {
        this.logger.error(`app-server 启动链路失败：${e instanceof Error ? e.message : e}`);
        finalize(1);
      }
    })();

    return { result: stream, done };
  }
}
