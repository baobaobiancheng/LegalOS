-- 2026-08-11 统计卡持久化：同步批次记录自动绑定数，前端切页/刷新后可从最近成功批次恢复统计。
ALTER TABLE `dingtalk_sync_batches`
    ADD COLUMN `auto_bound_count` INTEGER NOT NULL DEFAULT 0;
