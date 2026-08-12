-- 2026-08-12 咨询消息客户端幂等键：
-- 前端每个问题生成一个 key（CreateProjectMessageDto.idempotencyKey），
-- 防双重提交 / 网络重试产生重复用户消息与重复 AI 回答。
-- 与 ConsultationRun.userMessageId（消息 id 唯一）配合：先按 clientKey 去重建消息，再按消息 id 认领 run。
ALTER TABLE `project_messages` ADD COLUMN `client_key` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `project_messages_client_key_key` ON `project_messages`(`client_key`);
