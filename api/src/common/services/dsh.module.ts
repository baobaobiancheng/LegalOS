import { Global, Module } from '@nestjs/common';
import { DshService } from './dsh.service';
import { DshBaijianToolsService } from './dsh-baijian-tools.service';
import { BaijianModule } from '../baijian/baijian.module';
import { AiExecutionModule } from './ai-execution.module';

/**
 * dsh 全局模块（Codex CLI → dsh 迁移 Phase 1/2）：
 * DshService 必须为全局单例——它内部常驻一个 dsh boot() Context，
 * 多实例会导致重复 boot、重复占用会话目录。
 *
 * 共享并发与会话互斥由 AiExecutionModule 提供，不再依赖 CodexModule。
 */
@Global()
@Module({
  imports: [AiExecutionModule, BaijianModule],
  providers: [DshService, DshBaijianToolsService],
  exports: [DshService],
})
export class DshModule {}
