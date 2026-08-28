-- 法务身份统一：
-- 1. 彭宇欣只保留 CAS 账号 yuxin.peng，并继承历史本地 legal_bp 的业务关联和钉钉绑定。
-- 2. 删除演示账号 legal_lead；历史关联优先归并到 CAS 法务负责人 junfang.zhao，
--    若其尚未创建，则归并到现有 admin 应急账号。
-- 3. audit_events 为防篡改哈希链，保留原 actor_id，不修改历史审计正文。

-- ─────────────────────────────────────────────────────────────────────────────
-- 彭宇欣：legal_bp（本地） → yuxin.peng（CAS）
-- ─────────────────────────────────────────────────────────────────────────────
SET @peng_source_id := (
  SELECT `id` FROM `users` WHERE `username` = 'legal_bp' LIMIT 1
);
SET @peng_target_id := (
  SELECT `id`
  FROM `users`
  WHERE (`cas_username` = 'yuxin.peng' OR `username` = 'yuxin.peng')
    AND (`id` <> @peng_source_id OR @peng_source_id IS NULL)
  ORDER BY (`cas_username` = 'yuxin.peng') DESC
  LIMIT 1
);

SET @peng_dingtalk_id := (
  SELECT `dingtalk_user_id` FROM `users` WHERE `id` = @peng_source_id
);
SET @peng_dingtalk_phone := (
  SELECT `dingtalk_phone` FROM `users` WHERE `id` = @peng_source_id
);
SET @peng_avatar_url := (
  SELECT `avatar_url` FROM `users` WHERE `id` = @peng_source_id
);
SET @peng_department := (
  SELECT `department` FROM `users` WHERE `id` = @peng_source_id
);

-- 没有独立 CAS 行时，直接把历史本地行转换成 CAS 身份，保留主键及全部关联。
UPDATE `users`
SET `username` = 'yuxin.peng',
    `cas_username` = 'yuxin.peng',
    `display_name` = '彭宇欣',
    `role` = 'legal_bp',
    `failed_attempts` = 0,
    `locked_until` = NULL
WHERE `id` = @peng_source_id
  AND @peng_target_id IS NULL;

SET @peng_target_id := COALESCE(@peng_target_id, @peng_source_id);

-- 独立 CAS 行已存在时，先释放旧行的唯一钉钉绑定，再合并到 CAS 行。
UPDATE `users`
SET `dingtalk_user_id` = NULL,
    `dingtalk_phone` = NULL,
    `avatar_url` = NULL,
    `department` = NULL
WHERE `id` = @peng_source_id
  AND @peng_target_id IS NOT NULL
  AND @peng_source_id <> @peng_target_id;

UPDATE `users`
SET `cas_username` = 'yuxin.peng',
    `display_name` = '彭宇欣',
    `role` = 'legal_bp',
    `dingtalk_user_id` = COALESCE(`dingtalk_user_id`, @peng_dingtalk_id),
    `dingtalk_phone` = COALESCE(`dingtalk_phone`, @peng_dingtalk_phone),
    `avatar_url` = COALESCE(`avatar_url`, @peng_avatar_url),
    `department` = COALESCE(`department`, @peng_department),
    `failed_attempts` = 0,
    `locked_until` = NULL
WHERE `id` = @peng_target_id;

-- 领域映射先去重复制，再迁移所有强关联业务数据。
INSERT IGNORE INTO `bp_domain_maps` (`id`, `user_id`, `domain`, `created_at`)
SELECT UUID(), @peng_target_id, `domain`, `created_at`
FROM `bp_domain_maps`
WHERE `user_id` = @peng_source_id
  AND @peng_target_id IS NOT NULL
  AND @peng_source_id <> @peng_target_id;

UPDATE `projects` SET `creator_id` = @peng_target_id
WHERE `creator_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `projects` SET `owner_id` = @peng_target_id
WHERE `owner_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `projects` SET `legal_bp_id` = @peng_target_id
WHERE `legal_bp_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `contract_files` SET `uploaded_by` = @peng_target_id
WHERE `uploaded_by` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `skills` SET `creatorId` = @peng_target_id
WHERE `creatorId` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `skills` SET `approvedBy` = @peng_target_id
WHERE `approvedBy` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `login_audits` SET `user_id` = @peng_target_id
WHERE `user_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;

-- 以下字段没有数据库外键，但仍用于页面归属或历史追踪，需要同步身份主键。
UPDATE `consultation_attachments` SET `creator_id` = @peng_target_id
WHERE `creator_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `skill_review_logs` SET `actor_id` = @peng_target_id
WHERE `actor_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `contract_documents` SET `created_by` = @peng_target_id
WHERE `created_by` = @peng_source_id AND @peng_source_id <> @peng_target_id;
UPDATE `contract_review_runs` SET `created_by` = @peng_target_id
WHERE `created_by` = @peng_source_id AND @peng_source_id <> @peng_target_id;

-- 待处理的“新 BP 加入钉钉群”任务在 JSON payload 中保存用户主键，同步改指 CAS 账号。
UPDATE `outbox_events`
SET `payload` = JSON_SET(`payload`, '$.userId', @peng_target_id)
WHERE `event_type` = 'dingtalk.member.add'
  AND `status` IN ('pending', 'processing')
  AND JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.userId')) = @peng_source_id
  AND @peng_target_id IS NOT NULL
  AND @peng_source_id <> @peng_target_id;

-- 本地密码会话全部失效；CAS 会话不受影响。
UPDATE `refresh_tokens`
SET `is_revoked` = TRUE
WHERE `user_id` = @peng_target_id AND `auth_method` = 'password';
DELETE FROM `refresh_tokens`
WHERE `user_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
DELETE FROM `bp_domain_maps`
WHERE `user_id` = @peng_source_id AND @peng_source_id <> @peng_target_id;
DELETE FROM `users`
WHERE `id` = @peng_source_id AND @peng_source_id <> @peng_target_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 删除演示法务负责人账号 legal_lead
-- ─────────────────────────────────────────────────────────────────────────────
SET @lead_source_id := (
  SELECT `id` FROM `users` WHERE `username` = 'legal_lead' LIMIT 1
);
SET @lead_target_id := COALESCE(
  (SELECT `id` FROM `users`
   WHERE `cas_username` = 'junfang.zhao' AND `id` <> @lead_source_id LIMIT 1),
  (SELECT `id` FROM `users`
   WHERE `username` = 'admin' AND `id` <> @lead_source_id LIMIT 1),
  (SELECT `id` FROM `users`
   WHERE `id` <> @lead_source_id AND `role` IN ('admin', 'legal_lead')
   ORDER BY `created_at` ASC LIMIT 1)
);

UPDATE `projects` SET `creator_id` = @lead_target_id
WHERE `creator_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `projects` SET `owner_id` = @lead_target_id
WHERE `owner_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `projects` SET `legal_bp_id` = @lead_target_id
WHERE `legal_bp_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `contract_files` SET `uploaded_by` = @lead_target_id
WHERE `uploaded_by` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `skills` SET `creatorId` = @lead_target_id
WHERE `creatorId` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `skills` SET `approvedBy` = @lead_target_id
WHERE `approvedBy` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `login_audits` SET `user_id` = @lead_target_id
WHERE `user_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `consultation_attachments` SET `creator_id` = @lead_target_id
WHERE `creator_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `skill_review_logs` SET `actor_id` = @lead_target_id
WHERE `actor_id` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `contract_documents` SET `created_by` = @lead_target_id
WHERE `created_by` = @lead_source_id AND @lead_target_id IS NOT NULL;
UPDATE `contract_review_runs` SET `created_by` = @lead_target_id
WHERE `created_by` = @lead_source_id AND @lead_target_id IS NOT NULL;

UPDATE `outbox_events`
SET `payload` = JSON_SET(`payload`, '$.userId', @lead_target_id)
WHERE `event_type` = 'dingtalk.member.add'
  AND `status` IN ('pending', 'processing')
  AND JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.userId')) = @lead_source_id
  AND @lead_target_id IS NOT NULL
  AND @lead_source_id <> @lead_target_id;

DELETE FROM `refresh_tokens` WHERE `user_id` = @lead_source_id;
DELETE FROM `bp_domain_maps` WHERE `user_id` = @lead_source_id;
DELETE FROM `users`
WHERE `id` = @lead_source_id
  AND @lead_target_id IS NOT NULL
  AND @lead_source_id <> @lead_target_id;
