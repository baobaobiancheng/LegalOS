import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

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
  private activeCount = 0;
  private pendingQueue: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {
    this.maxConcurrency = Number(this.config.get('CODEX_CONCURRENCY', 50));
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
    if (this.codexBin.endsWith('.cmd')) {
      return spawn('cmd.exe', ['/c', this.codexBin, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        env: { ...process.env, HOME: workspaceDir },
        cwd: workspaceDir,
      });
    }
    return spawn(this.codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      env: { ...process.env, HOME: workspaceDir },
      cwd: workspaceDir,
    });
  }

  /** 为每次调用创建独立子目录 */
  private ensureWorkspace(sessionId?: string): string {
    const dir = join(this.baseWorkspace, sessionId || randomUUID());
    mkdirSync(dir, { recursive: true });

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
    await this.acquire();
    const workspaceDir = this.ensureWorkspace(options?.sessionId);
    try {
      const timeout = options?.timeout ?? 120_000;
      const modelArgs = options?.model ? ['-m', options.model] : [];
      const result = await this.runCodex(prompt, modelArgs, timeout, workspaceDir);
      return result.trim();
    } finally {
      this.cleanupWorkspace(workspaceDir);
      this.release();
    }
  }

  /** SSE 流式调用（支持 timeout，超时终止子进程 → close(code≠0) → 前端收到 error） */
  executeStream(prompt: string, options?: CodexOptions): ChildProcess {
    const workspaceDir = this.ensureWorkspace(options?.sessionId);
    const modelArgs = options?.model ? ['-m', options.model] : [];
    const args = ['exec', '--skip-git-repo-check', ...modelArgs, '-'];
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
    modelArgs: string[],
    timeout: number,
    workspaceDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['exec', '--skip-git-repo-check', ...modelArgs, '-'];
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
