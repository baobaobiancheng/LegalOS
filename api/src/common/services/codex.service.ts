import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, sep } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  AiExecutionQueueService,
  AiExecutionCancelledError,
  AiQueueBusyError,
  AI_CANCEL_GRACE_MS,
} from './ai-execution-queue.service';
import { CodexAgentJsonlParser } from './codex-agent-jsonl.parser';
import {
  AgentCompletion,
  AgentExecutionError,
  AgentExecutionEvent,
  AgentExecutionHandle,
  AgentOutputLimits,
  CodexAgentOptions,
  DEFAULT_AGENT_OUTPUT_LIMITS,
} from './codex-agent.types';

interface CodexOptions {
  model?: string;
  timeout?: number;
  /** 隔离会话 ID（如 projectId），确保不同会话互不干扰；同会话任务严格串行 */
  sessionId?: string;
  /** 排队超时（毫秒），覆盖默认 */
  queueTimeoutMs?: number;
  /** 调用方取消信号（HTTP/SSE 连接断开），取消排队或终止已启动任务 */
  signal?: AbortSignal;
}

@Injectable()
export class CodexService {
  private readonly logger = new Logger(CodexService.name);
  private readonly codexBin: string;
  private readonly baseWorkspace: string;
  private readonly terminationTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();
  /** 服务器硬化模式（CODEX_HARDENED=true）：严格配置 + 环境白名单 + 认证走公司网关；
   *  本地开发保持 false，继续读真实 ~/.codex（auth.json / config.toml） */
  private readonly hardened: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: AiExecutionQueueService,
  ) {
    this.hardened = this.config.get('CODEX_HARDENED', 'false') === 'true';
    this.codexBin = this.findCodex();

    // 隔离工作区根目录 — 每次调用创建 <sessionId>/<executionId> 独立子目录，会话间完全隔离
    this.baseWorkspace = this.config.get('CODEX_WORKSPACE')
      || join(process.cwd(), '.tmp', 'codex-workspaces');
    mkdirSync(this.baseWorkspace, { recursive: true });

    this.logger.log(`Codex CLI 路径：${this.codexBin}`);
    this.logger.log(`Codex 工作区根目录：${this.baseWorkspace}`);
    this.logger.log(
      `Codex 安全模式：硬化=${this.hardened ? '开启' : '关闭'}，AI执行=${this.aiEnabled() ? '允许' : '禁用'}`,
    );
  }

  /** 在常见位置查找 codex 可执行文件 */
  private findCodex(): string {
    const envPath = this.config.get('CODEX_PATH');
    if (envPath && existsSync(envPath)) return envPath;

    const appData = process.env.APPDATA || '';
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [
      join(appData, 'npm', 'codex.cmd'),
      join(home, '.npm-global', 'bin', 'codex'),
      'codex',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return 'codex';
  }

  /** Windows .cmd 用 cmd.exe /c 启动，Unix 直接 spawn */
  private spawnCodex(
    args: string[],
    workspaceDir: string,
    extraEnvironment: Record<string, string> = {},
  ): ChildProcess {
    const env = this.buildSpawnEnv(workspaceDir, extraEnvironment);
    if (this.codexBin.endsWith('.cmd')) {
      return spawn('cmd.exe', ['/c', this.codexBin, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        env,
        cwd: workspaceDir,
      });
    }
    return spawn(this.codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      env,
      cwd: workspaceDir,
    });
  }

  /**
   * 最小环境白名单（P0 安全加固，2026-08-09）——绝不继承全量 process.env，
   * DATABASE_URL / JWT_SECRET / 钉钉凭证等服务秘密一律不透传给 codex。
   * - 本地开发（CODEX_HARDENED=false）：CODEX_HOME 指真实 ~/.codex，读 auth.json/config.toml
   * - 服务器硬化（CODEX_HARDENED=true）：CODEX_HOME 每次调用独立子目录（会话/日志不落盘），
   *   认证走 CODEX_API_KEY（公司网关 token，由受管配置 env_key 读取）
   */
  private buildSpawnEnv(
    workspaceDir: string,
    extraEnvironment: Record<string, string> = {},
  ): NodeJS.ProcessEnv {
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
    // 认证变量（白名单）：公司网关 token 或 OpenAI key
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    // 企业 CA / 代理（可选）
    if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    if (process.env.HTTP_PROXY) env.HTTP_PROXY = process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
    if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY;
    for (const [name, value] of Object.entries(extraEnvironment)) {
      if (!/^BAIJIAN_MCP_[A-Z0-9_]+$/.test(name)) {
        throw new Error(`Codex Agent 环境变量不在白名单：${name}`);
      }
      env[name] = value;
    }
    return env;
  }

  /**
   * codex 启动参数（P0 安全加固）：
   * - 硬化模式：--strict-config（未知配置即报错，防静默失效）/ -a never（无人值守不卡审批）/
   *   -c shell_environment_policy.inherit=none（子进程零继承环境变量，防 printenv 泄密）/
   *   --ephemeral（不持久化会话）/ --ignore-user-config（不加载 CODEX_HOME 用户配置）
   * - 不传 --sandbox：受管权限档案（/etc/codex/requirements.toml）接管沙箱，与 --sandbox 互斥
   */
  private buildArgs(modelArgs: string[]): string[] {
    const hardenedPrefix = [
      '--strict-config',
      '-a',
      'never',
      '-c',
      'shell_environment_policy.inherit=none',
    ];
    const hardenedSuffix = ['--ephemeral', '--ignore-user-config'];
    return [
      ...(this.hardened ? hardenedPrefix : []),
      'exec',
      '--skip-git-repo-check',
      ...(this.hardened ? hardenedSuffix : []),
      ...modelArgs,
      '-',
    ];
  }

  private buildAgentArgs(
    options: CodexAgentOptions,
    schemaPath: string,
    resultPath: string,
  ): string[] {
    const { mcp } = options;
    if (!/^[a-zA-Z0-9_-]+$/.test(mcp.serverName)) {
      throw new Error('MCP serverName 非法');
    }
    if (!/^[a-zA-Z0-9_.:-]+$/.test(mcp.enabledTool)) {
      throw new Error('MCP tool 名称非法');
    }
    const url = new URL(mcp.url);
    if (url.protocol !== 'https:' && this.config.get('NODE_ENV') === 'production') {
      throw new Error('生产环境 MCP URL 必须使用 HTTPS');
    }
    for (const envName of Object.values(mcp.envHttpHeaders)) {
      if (!(envName in mcp.environment)) {
        throw new Error(`MCP 请求头环境变量未提供：${envName}`);
      }
    }

    const serverKey = `mcp_servers.${mcp.serverName}`;
    const headerTable = tomlInlineTable(mcp.envHttpHeaders);
    const agentArgs = [
      '--disable',
      'shell_tool',
      '-c',
      'web_search="disabled"',
      '-c',
      'agents.enabled=false',
      '-c',
      'memories.use_memories=false',
      '-c',
      'memories.generate_memories=false',
      '-c',
      `${serverKey}.url=${tomlString(mcp.url)}`,
      '-c',
      `${serverKey}.env_http_headers=${headerTable}`,
      '-c',
      `${serverKey}.enabled_tools=[${tomlString(mcp.enabledTool)}]`,
      '-c',
      `${serverKey}.required=${mcp.required !== false}`,
      '-c',
      `${serverKey}.default_tools_approval_mode="auto"`,
      '-c',
      `${serverKey}.startup_timeout_sec=${mcp.startupTimeoutSec ?? 15}`,
      '-c',
      `${serverKey}.tool_timeout_sec=${mcp.toolTimeoutSec ?? 60}`,
      '--json',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      resultPath,
    ];
    if (options.model) agentArgs.unshift('-m', options.model);
    return this.buildArgs(agentArgs);
  }

  /** AI Kill Switch：AI_EXECUTION_ENABLED=false / 0 / off 时拦截所有 AI 调用 */
  private aiEnabled(): boolean {
    const v = String(this.config.get('AI_EXECUTION_ENABLED', 'true')).toLowerCase();
    return !['false', '0', 'off', 'no', 'disabled'].includes(v);
  }

  /** AI 禁用时返回伪子进程：不 spawn，立即以 code=1 关闭 → 调用方走既有失败路径（转人工） */
  private failedStream(): ChildProcess {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake = Object.assign(emitter, { stdout, stderr }) as unknown as ChildProcess;
    setImmediate(() => {
      stderr.write('AI 执行已禁用（AI_EXECUTION_ENABLED=false）\n');
      stderr.end();
      stdout.end();
      emitter.emit('close', 1);
    });
    return fake;
  }

  /** 排队中被取消（连接断开）返回的伪子进程：close(code=null)，标记 __cancelled 供调用方跳过落库 */
  private cancelledStream(): ChildProcess {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake = Object.assign(emitter, { stdout, stderr, __cancelled: true }) as unknown as ChildProcess;
    setImmediate(() => {
      stdout.end();
      stderr.end();
      emitter.emit('close', null);
    });
    return fake;
  }

  /** 为每次调用创建 <sessionId>/<executionId> 独立子目录（同会话并发互不干扰） */
  private ensureWorkspace(sessionId?: string, executionId?: string): string {
    const dir = join(
      this.baseWorkspace,
      sessionId ? `${sessionId}/${executionId ?? randomUUID()}` : (executionId ?? randomUUID()),
    );
    mkdirSync(dir, { recursive: true });
    // 硬化模式：CODEX_HOME 指向 dir/.codex，codex 要求该目录必须已存在（2026-08-09 实测）
    if (this.hardened) {
      mkdirSync(join(dir, '.codex'), { recursive: true });
    }

    // 复制合同模板纯文本到工作区 templates/（工程决策 2026-08-03）：
    // Codex 在隔离工作区运行看不到 storage/，prompt 指示其读取工作区内模板文件参照起草
    try {
      const templatesRoot = join(process.cwd(), 'storage', 'contract-templates');
      if (existsSync(templatesRoot)) {
        const targetDir = join(dir, 'templates');
        mkdirSync(targetDir, { recursive: true });
        for (const slug of readdirSync(templatesRoot)) {
          const mdFile = join(templatesRoot, slug, `${slug}.md`);
          if (existsSync(mdFile)) {
            copyFileSync(mdFile, join(targetDir, `${slug}.md`));
          }
        }
      }
    } catch (e) {
      this.logger.warn(`模板文件复制到工作区失败：${(e as Error).message}`);
    }

    return dir;
  }

  /**
   * 清理执行目录，并在最后一个执行结束后回收空 session 父目录。
   * 只使用 rmdirSync 删除空父目录，避免误删同 session 的并发/残留内容；baseWorkspace 本身永不删除。
   */
  private cleanupWorkspace(dir?: string) {
    if (dir && dir.startsWith(this.baseWorkspace)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        const sessionDir = dirname(dir);
        if (sessionDir !== this.baseWorkspace && sessionDir.startsWith(`${this.baseWorkspace}${sep}`)) {
          try { rmdirSync(sessionDir); } catch { /* 非空或已被其他任务使用 */ }
        }
      } catch {}
    }
  }

  /**
   * 统一终止子进程：先给 Codex 一个 SIGTERM 宽限期，仍未退出才 SIGKILL。
   * 非流式任务必须等 close 事件后才 reject，避免队列提前释放槽位。
   */
  private terminateChild(child: ChildProcess, reason: string): void {
    if (child.exitCode !== null && child.exitCode !== undefined) return;

    try { child.kill('SIGTERM'); } catch (e) {
      this.logger.warn(`Codex ${reason} SIGTERM 失败：${(e as Error).message}`);
    }

    if (this.terminationTimers.has(child)) return;
    const grace = setTimeout(() => {
      this.terminationTimers.delete(child);
      if (child.exitCode === null || child.exitCode === undefined) {
        this.logger.warn(`Codex ${reason} 宽限期后仍未退出，强制 SIGKILL`);
        try { child.kill('SIGKILL'); } catch (e) {
          this.logger.warn(`Codex ${reason} SIGKILL 失败：${(e as Error).message}`);
        }
      }
    }, AI_CANCEL_GRACE_MS);
    grace.unref?.();
    this.terminationTimers.set(child, grace);
  }

  private clearTerminationTimer(child: ChildProcess): void {
    const timer = this.terminationTimers.get(child);
    if (timer) {
      clearTimeout(timer);
      this.terminationTimers.delete(child);
    }
  }

  /** 非流式调用 codex exec — 经共享有界队列，排队/超时抛 AI 服务繁忙错误 */
  async execute(prompt: string, options?: CodexOptions): Promise<string> {
    if (!this.aiEnabled()) throw new Error('AI 执行已禁用（AI_EXECUTION_ENABLED=false）');
    const sessionId = options?.sessionId;
    const executionId = randomUUID();
    const workspaceDir = this.ensureWorkspace(sessionId, executionId);
    const args = this.buildArgs(options?.model ? ['-m', options.model] : []);
    const timeout = options?.timeout ?? 120_000;
    try {
      const result = await this.queue.run(
        { sessionId, queueTimeoutMs: options?.queueTimeoutMs, signal: options?.signal },
        () => {
          const runPromise = this.runCodex(prompt, args, timeout, workspaceDir);
          // done 只表示槽位生命周期，不能把同一个 reject 再制造成未处理 Promise。
          return { result: runPromise, done: runPromise.then(() => undefined, () => undefined) };
        },
      );
      return result.trim();
    } catch (e) {
      this.cleanupWorkspace(workspaceDir);
      if (e instanceof AiQueueBusyError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  /**
   * SSE 流式调用（支持 timeout，超时终止子进程 → close(code≠0) → 前端收到 error）。
   * 已改为异步：经共享队列获得全局槽位 + session 槽位后才 spawn；返回 Promise<ChildProcess>。
   * 队列满 / 排队超时在 spawn 前抛 ServiceUnavailableException（SSE 响应开始前返回 HTTP 错误）。
   */
  async executeStream(prompt: string, options?: CodexOptions): Promise<ChildProcess> {
    if (!this.aiEnabled()) {
      this.logger.warn('Codex executeStream 被拦截：AI_EXECUTION_ENABLED=false');
      return this.failedStream();
    }
    const sessionId = options?.sessionId;
    const executionId = randomUUID();
    const workspaceDir = this.ensureWorkspace(sessionId, executionId);
    const args = this.buildArgs(options?.model ? ['-m', options.model] : []);
    const timeout = options?.timeout ?? 120_000;
    try {
      return await this.queue.run(
        { sessionId, queueTimeoutMs: options?.queueTimeoutMs, signal: options?.signal },
        (abort) => this.spawnStreamChild(prompt, args, workspaceDir, timeout, abort),
      );
    } catch (e) {
      this.cleanupWorkspace(workspaceDir);
      if (e instanceof AiExecutionCancelledError) {
        return this.cancelledStream();
      }
      if (e instanceof AiQueueBusyError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  /**
   * Agent 专用执行接口。
   *
   * 与合同兼容路径不同，本接口把 JSONL 事件、权威工具结果和结构化最终结果
   * 都在工作区清理前解析完成。调用方只消费类型化 handle，不直接读取临时文件。
   */
  async executeAgent<T = unknown>(
    prompt: string,
    options: CodexAgentOptions<T>,
  ): Promise<AgentExecutionHandle<T>> {
    if (!this.aiEnabled()) throw new Error('AI 执行已禁用（AI_EXECUTION_ENABLED=false）');
    if (!this.hardened) {
      throw new Error('Codex Agent 仅允许在 CODEX_HARDENED=true 下运行');
    }

    const executionId = randomUUID();
    const workspaceDir = this.ensureWorkspace(options.sessionId, executionId);
    const schemaPath = join(workspaceDir, 'agent-output.schema.json');
    const resultPath = join(workspaceDir, 'agent-result.json');
    writeFileSync(schemaPath, JSON.stringify(options.outputSchema), { encoding: 'utf8', mode: 0o600 });
    const args = this.buildAgentArgs(options, schemaPath, resultPath);
    const limits = this.resolveAgentLimits(options.limits);

    const callerAbort = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) callerAbort.abort();
      else options.signal.addEventListener('abort', () => callerAbort.abort(), { once: true });
    }

    try {
      return await this.queue.run(
        {
          sessionId: options.sessionId,
          queueTimeoutMs: options.queueTimeoutMs,
          signal: callerAbort.signal,
        },
        (queueAbort) => this.spawnAgentChild<T>({
          prompt,
          args,
          executionId,
          workspaceDir,
          resultPath,
          timeout: options.timeout ?? 180_000,
          environment: options.mcp.environment,
          limits,
          validateFinal: options.validateFinal,
          queueAbort,
          callerAbort,
        }),
      );
    } catch (error) {
      this.cleanupWorkspace(workspaceDir);
      if (error instanceof AiQueueBusyError) {
        throw new ServiceUnavailableException(error.message);
      }
      if (error instanceof AiExecutionCancelledError) {
        throw new AgentExecutionError('AGENT_CANCELLED', 'Codex Agent 在启动前已取消');
      }
      throw error;
    }
  }

  private resolveAgentLimits(overrides?: Partial<AgentOutputLimits>): AgentOutputLimits {
    const fromConfig: AgentOutputLimits = {
      stdoutBytes: Number(this.config.get('CODEX_AGENT_STDOUT_MAX_BYTES', DEFAULT_AGENT_OUTPUT_LIMITS.stdoutBytes)),
      stderrBytes: Number(this.config.get('CODEX_AGENT_STDERR_MAX_BYTES', DEFAULT_AGENT_OUTPUT_LIMITS.stderrBytes)),
      jsonlLineBytes: Number(this.config.get('CODEX_AGENT_JSONL_LINE_MAX_BYTES', DEFAULT_AGENT_OUTPUT_LIMITS.jsonlLineBytes)),
      eventCount: Number(this.config.get('CODEX_AGENT_EVENT_MAX', DEFAULT_AGENT_OUTPUT_LIMITS.eventCount)),
      toolResultCount: Number(this.config.get('CODEX_AGENT_TOOL_RESULT_MAX', DEFAULT_AGENT_OUTPUT_LIMITS.toolResultCount)),
      resultFileBytes: Number(this.config.get('CODEX_AGENT_RESULT_FILE_MAX_BYTES', DEFAULT_AGENT_OUTPUT_LIMITS.resultFileBytes)),
    };
    const result = { ...fromConfig, ...overrides };
    for (const [name, value] of Object.entries(result)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Codex Agent 输出上限非法：${name}`);
    }
    return result;
  }

  private spawnAgentChild<T>(params: {
    prompt: string;
    args: string[];
    executionId: string;
    workspaceDir: string;
    resultPath: string;
    timeout: number;
    environment: Record<string, string>;
    limits: AgentOutputLimits;
    validateFinal?: (value: unknown) => T;
    queueAbort: AbortSignal;
    callerAbort: AbortController;
  }): { result: AgentExecutionHandle<T>; done: Promise<void> } {
    const child = this.spawnCodex(params.args, params.workspaceDir, params.environment);
    const eventQueue = new AsyncEventQueue<AgentExecutionEvent>();
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let fatalError: AgentExecutionError | Error | null = null;
    let timedOut = false;
    let finalized = false;

    const parser = new CodexAgentJsonlParser(params.limits, (event) => eventQueue.push(event));
    let completionResolve!: (value: AgentCompletion<T>) => void;
    let completionReject!: (reason: unknown) => void;
    const completion = new Promise<AgentCompletion<T>>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    // 队列槽位必须一直持有到 completion 完成；调用方拿到 handle 后可以立即消费事件。
    const done = completion.then(() => undefined);

    const failAndTerminate = (error: AgentExecutionError | Error) => {
      if (!fatalError) fatalError = error;
      this.terminateChild(child, 'Agent 输出/解析失败');
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      try {
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        failAndTerminate(error as AgentExecutionError);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.byteLength;
      if (stderrBytes > params.limits.stderrBytes) {
        failAndTerminate(new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex stderr 超过上限'));
        return;
      }
      stderrChunks.push(buffer);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      fatalError = new AgentExecutionError('AGENT_TIMEOUT', 'Codex Agent execution timed out');
      this.terminateChild(child, 'Agent 超时');
    }, params.timeout);
    timer.unref?.();

    const finalize = (code: number | null) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      this.clearTerminationTimer(child);

      try {
        parser.finish();
      } catch (error) {
        if (!fatalError) fatalError = error as AgentExecutionError;
      }

      const stderrSummary = Buffer.concat(stderrChunks).toString('utf8').slice(0, 4_000);
      try {
        if (fatalError) throw fatalError;
        if ((child as any).__cancelled || params.queueAbort.aborted) {
          throw new AgentExecutionError('AGENT_CANCELLED', 'Codex Agent 已取消');
        }
        if (timedOut) throw new AgentExecutionError('AGENT_TIMEOUT', 'Codex Agent execution timed out');
        if (code !== 0) {
          throw new AgentExecutionError(
            'AGENT_PROCESS_FAILED',
            `Codex Agent exited with code ${code ?? 'null'}${stderrSummary ? `: ${stderrSummary}` : ''}`,
          );
        }
        if (!existsSync(params.resultPath)) {
          throw new AgentExecutionError('AGENT_RESULT_MISSING', 'Codex Agent 未生成最终结果文件');
        }
        const resultSize = statSync(params.resultPath).size;
        if (resultSize > params.limits.resultFileBytes) {
          throw new AgentExecutionError('AGENT_OUTPUT_LIMIT', 'Codex Agent 最终结果文件超过上限');
        }

        let rawFinal: unknown;
        try {
          rawFinal = JSON.parse(readFileSync(params.resultPath, 'utf8'));
        } catch {
          throw new AgentExecutionError('AGENT_RESULT_INVALID', 'Codex Agent 最终结果不是合法 JSON');
        }
        let final: T;
        try {
          final = params.validateFinal ? params.validateFinal(rawFinal) : rawFinal as T;
        } catch (error) {
          throw new AgentExecutionError(
            'AGENT_RESULT_INVALID',
            `Codex Agent 最终结果未通过校验：${(error as Error).message}`,
          );
        }

        eventQueue.close();
        completionResolve({
          exitCode: code,
          final,
          events: [...parser.events],
          toolResults: [...parser.toolResults],
          stderrSummary,
          truncated: { stderr: false },
        });
      } catch (error) {
        eventQueue.fail(error);
        completionReject(error);
      } finally {
        this.cleanupWorkspace(params.workspaceDir);
      }
    };

    child.on('error', (error) => {
      if (!fatalError) fatalError = error;
      finalize(null);
    });
    child.on('close', (code) => finalize(code));
    params.queueAbort.addEventListener('abort', () => {
      (child as any).__cancelled = true;
      this.terminateChild(child, 'Agent 取消');
    }, { once: true });

    try { child.stdin?.write(params.prompt, 'utf8'); } catch {}
    try { child.stdin?.end(); } catch {}

    return {
      result: {
        executionId: params.executionId,
        process: child,
        events: eventQueue,
        completion,
        cancel: () => params.callerAbort.abort(),
      },
      done,
    };
  }

  /** 流式任务 start：立即 spawn，注册超时终止 / 取消（SIGTERM→SIGKILL） / 工作区清理 */
  private spawnStreamChild(
    prompt: string,
    args: string[],
    workspaceDir: string,
    timeout: number,
    abort: AbortSignal,
  ): { result: ChildProcess; done: Promise<void> } {
    const child = this.spawnCodex(args, workspaceDir);
    const stdoutLimit = this.positiveConfig('CODEX_STDOUT_MAX_BYTES', 4 * 1024 * 1024);
    const stderrLimit = this.positiveConfig('CODEX_STDERR_MAX_BYTES', 256 * 1024);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > stdoutLimit && !(child as any).__outputLimit) {
        (child as any).__outputLimit = true;
        this.terminateChild(child, 'stdout 超限');
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > stderrLimit && !(child as any).__outputLimit) {
        (child as any).__outputLimit = true;
        this.terminateChild(child, 'stderr 超限');
      }
    });

    // 超时终止（工程评审决策 #7：长任务按调用方配置超时，超时 kill → 调用方 SSE 错误路径）
    const timer = setTimeout(() => {
      this.logger.warn(`Codex SSE 超时（${timeout}ms），终止子进程`);
      this.terminateChild(child, 'SSE 超时');
    }, timeout);
    timer.unref?.();

    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => { doneResolve = resolve; });
    // 一次性 finalize：error 与 close 都可能触发，双释放由队列 finalize 守卫兜底
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      this.clearTerminationTimer(child);
      this.cleanupWorkspace(workspaceDir);
      doneResolve();
    };

    child.on('error', (err) => {
      this.logger.error(`Codex spawn 失败：${err.message}`);
      finalize(); // spawn 失败也要释放槽位（部分场景不触发 close）
    });

    child.on('close', (code) => {
      this.logger.log(`Codex SSE 子进程退出 exitCode=${code}`);
      finalize();
    });

    // 连接断开 / 调用方取消：先 SIGTERM，宽限期后仍未退出再 SIGKILL
    abort.addEventListener('abort', () => {
      (child as any).__cancelled = true;
      this.terminateChild(child, '取消');
    });

    // stdin write 可能因子进程提前退出而失败
    try { child.stdin!.write(prompt, 'utf-8'); } catch {}
    try { child.stdin!.end(); } catch {}

    // 便于结构化日志关联（sessionId/executionId 由调用方在 resolve 前后可写，此处仅预留）
    return { result: child, done };
  }

  /** 内部：spawn codex，通过 stdin 传 prompt */
  private runCodex(
    prompt: string,
    args: string[],
    timeout: number,
    workspaceDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnCodex(args, workspaceDir);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      const stdoutLimit = this.positiveConfig('CODEX_STDOUT_MAX_BYTES', 4 * 1024 * 1024);
      const stderrLimit = this.positiveConfig('CODEX_STDERR_MAX_BYTES', 256 * 1024);
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const timer = setTimeout(() => {
        timedOut = true;
        this.terminateChild(child, '非流式超时');
      }, timeout);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.clearTerminationTimer(child);
        this.cleanupWorkspace(workspaceDir);
        fn();
      };

      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > stdoutLimit) {
          outputLimitExceeded = true;
          this.terminateChild(child, '非流式 stdout 超限');
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > stderrLimit) {
          outputLimitExceeded = true;
          this.terminateChild(child, '非流式 stderr 超限');
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('close', (code) => {
        if (outputLimitExceeded) {
          settle(() => reject(new Error('Codex output limit exceeded')));
        } else if (timedOut) {
          settle(() => reject(new Error('Codex execution timed out')));
        } else if (code === 0) {
          settle(() => resolve(Buffer.concat(stdoutChunks).toString('utf-8')));
        } else {
          const err = Buffer.concat(stderrChunks).toString('utf-8');
          this.logger.error(`Codex 退出 code=${code}：${err.slice(0, 200)}`);
          settle(() => reject(new Error(`Codex exited with code ${code}`)));
        }
      });

      child.on('error', (err) => {
        settle(() => reject(err));
      });

      try { child.stdin!.write(prompt, 'utf-8'); } catch {}
      try { child.stdin!.end(); } catch {}
    });
  }

  getStats() {
    return this.queue.getStats();
  }

  private positiveConfig(key: string, fallback: number): number {
    const value = Number(this.config.get(key, fallback));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private ended = false;
  private error: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.buffered.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const buffered = this.buffered.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(',')}}`;
}
