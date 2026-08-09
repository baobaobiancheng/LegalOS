import { Global, Module } from '@nestjs/common';
import { CodexService } from './codex.service';
import { CodexExecutionQueueService } from './codex-execution-queue.service';

/**
 * Codex 全局模块（P1-02）：
 * CodexService 与 CodexExecutionQueueService 必须为全局单例，否则 ProjectModule /
 * ContractModule 各自实例化会得到多套队列，破坏"全局并发上限 + 同 session 互斥"。
 */
@Global()
@Module({
  providers: [CodexService, CodexExecutionQueueService],
  exports: [CodexService, CodexExecutionQueueService],
})
export class CodexModule {}
