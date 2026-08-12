import { Global, Module } from '@nestjs/common';
import { CodexService } from './codex.service';
import { CodexExecutionQueueService } from './codex-execution-queue.service';

/**
 * Codex 全局模块（P1-02）：
 * CodexService 与 CodexExecutionQueueService 必须为全局单例，
 * 否则 ProjectModule / ContractModule 各自实例化会得到多套队列，破坏"全局并发上限 + 同 session 互斥"。
 *
 * 注：CodexAppServerService 已于 2026-08-12 移除——咨询已切直连网关，
 * 合同模块使用 CodexService（exec 模式），app-server 无生产调用者。
 */
@Global()
@Module({
  providers: [CodexService, CodexExecutionQueueService],
  exports: [CodexService, CodexExecutionQueueService],
})
export class CodexModule {}
