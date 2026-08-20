import { Global, Module } from '@nestjs/common';
import { DshService } from './dsh.service';

/**
 * dsh 全局模块（Codex CLI → dsh 迁移 Phase 1/2）：
 * DshService 必须为全局单例——它内部常驻一个 dsh boot() Context，
 * 多实例会导致重复 boot、重复占用会话目录。
 *
 * CodexExecutionQueueService 由 CodexModule 已声明为全局 provider，这里不重复声明，
 * 靠 CodexModule 的 @Global() 保证其先于 DshService 可用。
 */
@Global()
@Module({
  providers: [DshService],
  exports: [DshService],
})
export class DshModule {}
