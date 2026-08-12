import { Global, Module } from '@nestjs/common';
import { ConsultationChatService } from './consultation-chat.service';

/**
 * 咨询直连网关全局模块（2026-08-12）：
 * ConsultationChatService 供 ProjectModule 等多处复用，@Global 避免重复实例化。
 */
@Global()
@Module({
  providers: [ConsultationChatService],
  exports: [ConsultationChatService],
})
export class ConsultationChatModule {}
