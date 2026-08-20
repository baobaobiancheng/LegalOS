import { Global, Module } from '@nestjs/common';
import { CodexService } from './codex.service';
import { AiExecutionModule } from './ai-execution.module';

/**
 * Codex 全局模块（P1-02）：
 * CodexService 仅保留给尚未迁移的技术闸门；共享队列由 AiExecutionModule 持有。
 *
 * 注：CodexAppServerService 已于 2026-08-12 移除；咨询使用直连网关，合同使用
 * DshService。CodexService 已无生产业务调用者，等 dsh 真实闸门通过后整模块删除。
 */
@Global()
@Module({
  imports: [AiExecutionModule],
  providers: [CodexService],
  exports: [CodexService],
})
export class CodexModule {}
