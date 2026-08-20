import { Global, Module } from '@nestjs/common';
import { CodexService } from './codex.service';
import { AiExecutionModule } from './ai-execution.module';

/**
 * Codex 全局模块（P1-02）：
 * CodexService 仅保留给尚未迁移的技术闸门；共享队列由 AiExecutionModule 持有。
 *
 * 注：CodexAppServerService 已于 2026-08-12 移除——咨询已切直连网关，
 * 合同模块使用 CodexService（exec 模式），app-server 无生产调用者。
 */
@Global()
@Module({
  imports: [AiExecutionModule],
  providers: [CodexService],
  exports: [CodexService],
})
export class CodexModule {}
