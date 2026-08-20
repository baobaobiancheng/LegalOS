import { Global, Module } from '@nestjs/common';
import { AiExecutionQueueService } from './ai-execution-queue.service';

/** dsh 与遗留 Codex 执行器共享的全局并发/会话互斥基础设施。 */
@Global()
@Module({
  providers: [AiExecutionQueueService],
  exports: [AiExecutionQueueService],
})
export class AiExecutionModule {}
