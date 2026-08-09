import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

interface CodexOptions {
  model?: string;
  maxTokens?: number;
  timeout?: number;
  /** 隔离会话 ID（如 projectId），确保不同会话互不干扰 */
  sessionId?: string;
}

@Injectable()
export class CodexService {
  private readonly logger = new Logger(CodexService.name);
  private readonly maxConcurrency: number;
  private readonly codexBin: string;
  private readonly baseWorkspace: string;
  /** 服务器硬化模式（CODEX_HARDENED=true）：严格配置 + 环境白名单 + 认证走公司网关；
   *  本地开发保持 false，继续读真实 ~/.codex（auth.json / config.toml） */
  private readonly hardened: boolean;
  private activeCount = 0;
  private pendingQueue: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {
    this.maxConcurrency = Number(this.config.get('CODEX_CONCURRENCY', 50));
    this.hardened = this.config.get('CODEX_HARDENED', 'false') === 'true';
    this.codexBin = this.findCodex();

    // 隔离工作区根目录 — 每次调用创建独立子目录，会话间完全隔离
    this.baseWorkspace = this.config.get('CODEX_WORKSPACE')
      || join(process.cwd(), '.tmp', 'codex-workspaces');
    mkdirSync(this.baseWorkspace, { recursive: true });

    this.logger.log(`Codex CLI 路径：${this.codexBin}`);
    this.logger.log(`Codex 工作区根目录：${this.baseWorkspace}`);
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
  private spawnCodex(args: string[], workspaceDir: string): ChildProcess {
    const env = this.buildSpawnEnv(workspaceDir);
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
    // 认证变量（白名单）：公司网关 token 或 OpenAI key
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    // 企业 CA / 代理（可选）
    if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    if (process.env.HTTP_PROXY) env.HTTP_PROXY = process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
    if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY;
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

  /** 为每次调用创建独立子目录 */
  private ensureWorkspace(sessionId?: string): string {
    const dir = join(this.baseWorkspace, sessionId || randomUUID());
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

  /** 清理会话工作目录 */
  private cleanupWorkspace(dir?: string) {
    if (dir && dir.startsWith(this.baseWorkspace)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  private async acquire(): Promise<void> {
    while (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.pendingQueue.push(resolve));
    }
    this.activeCount++;
  }

  private release(): void {
    this.activeCount--;
    const next = this.pendingQueue.shift();
    if (next) next();
  }

  /** 非流式调用 codex exec */
  async execute(prompt: string, options?: CodexOptions): Promise<string> {
    if (!this.aiEnabled()) throw new Error('AI 执行已禁用（AI_EXECUTION_ENABLED=false）');
    await this.acquire();
    const workspaceDir = this.ensureWorkspace(options?.sessionId);
    try {
      const timeout = options?.timeout ?? 120_000;
      const args = this.buildArgs(options?.model ? ['-m', options.model] : []);
      const result = await this.runCodex(prompt, args, timeout, workspaceDir);
      return result.trim();
    } finally {
      this.cleanupWorkspace(workspaceDir);
      this.release();
    }
  }

  /** SSE 流式调用（支持 timeout，超时终止子进程 → close(code≠0) → 前端收到 error） */
  executeStream(prompt: string, options?: CodexOptions): ChildProcess {
    if (!this.aiEnabled()) {
      this.logger.warn('Codex executeStream 被拦截：AI_EXECUTION_ENABLED=false');
      return this.failedStream();
    }
    const workspaceDir = this.ensureWorkspace(options?.sessionId);
    const args = this.buildArgs(options?.model ? ['-m', options.model] : []);
    const child = this.spawnCodex(args, workspaceDir);

    // 工程评审决策 #7：executeStream 原本忽略 options.timeout，长任务（如合同草稿）
    // 需要按调用方配置超时，超时后终止子进程由调用方 SSE 错误路径兜底
    const timeout = options?.timeout ?? 120_000;
    const timer = setTimeout(() => {
      this.logger.warn(`Codex SSE 超时（${timeout}ms），终止子进程`);
      child.kill('SIGTERM');
    }, timeout);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      this.logger.error(`Codex spawn 失败：${err.message}`);
    });

    child.on('close', () => {
      clearTimeout(timer);
      this.cleanupWorkspace(workspaceDir);
    });

    // stdin write 可能因子进程提前退出而失败
    try { child.stdin!.write(prompt, 'utf-8'); } catch {}
    try { child.stdin!.end(); } catch {}

    return child;
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

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(new Error('Codex execution timed out'));
      }, timeout);

      child.stdout!.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
      child.stderr!.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
        } else {
          const err = Buffer.concat(stderrChunks).toString('utf-8');
          this.logger.error(`Codex 退出 code=${code}：${err.slice(0, 200)}`);
          reject(new Error(`Codex exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      try { child.stdin!.write(prompt, 'utf-8'); } catch {}
      try { child.stdin!.end(); } catch {}
    });
  }

  getStats() {
    return { active: this.activeCount, pending: this.pendingQueue.length, max: this.maxConcurrency };
  }
}
