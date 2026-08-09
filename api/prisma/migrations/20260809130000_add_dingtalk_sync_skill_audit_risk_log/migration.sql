-- P1-07: 用户钉钉绑定唯一约束(一个系统用户最多绑一个联系人)
-- 注意:若存量 users.dingtalk_user_id 已有重复,本索引会失败。上线前先跑
-- `prisma/check-duplicate-dingtalk-binding.sql`(只读)确认无重复后再 deploy。
ALTER TABLE `users` ADD UNIQUE INDEX `users_dingtalk_user_id_key`(`dingtalk_user_id`);

-- P1-07: 通讯录软失效(不再硬删除)+ 姓名索引
ALTER TABLE `dingtalk_contacts`
    ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `last_seen_batch_id` VARCHAR(64) NULL,
    ADD COLUMN `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD INDEX `dingtalk_contacts_name_idx`(`name`);

-- P1-07/08: 同步批次表
CREATE TABLE `dingtalk_sync_batches` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('running', 'complete', 'failed') NOT NULL DEFAULT 'running',
    `contact_count` INTEGER NOT NULL DEFAULT 0,
    `department_count` INTEGER NOT NULL DEFAULT 0,
    `truncated` BOOLEAN NOT NULL DEFAULT false,
    `error_message` TEXT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `dingtalk_sync_batches_status_started_at_idx`(`status`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- P1-08: 同步 staging 表
CREATE TABLE `dingtalk_contact_staging` (
    `id` VARCHAR(191) NOT NULL,
    `batch_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(128) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `mobile` VARCHAR(32) NULL,

    UNIQUE INDEX `dingtalk_contact_staging_batch_id_user_id_key`(`batch_id`, `user_id`),
    INDEX `dingtalk_contact_staging_batch_id_name_idx`(`batch_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- P1-09: 技能审核日志表
CREATE TABLE `skill_review_logs` (
    `id` VARCHAR(191) NOT NULL,
    `event_id` VARCHAR(64) NOT NULL,
    `skill_id` VARCHAR(191) NOT NULL,
    `action` ENUM('submit', 'withdraw', 'approve', 'reject', 'archive', 'restore') NOT NULL,
    `from_state` VARCHAR(32) NOT NULL,
    `to_state` VARCHAR(32) NOT NULL,
    `actor_id` VARCHAR(191) NOT NULL,
    `reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `skill_review_logs_event_id_key`(`event_id`),
    INDEX `skill_review_logs_skill_id_created_at_idx`(`skill_id`, `created_at`),
    INDEX `skill_review_logs_actor_id_created_at_idx`(`actor_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- P1-11: 风险分类审计表
CREATE TABLE `risk_assessment_logs` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `final_risk` VARCHAR(8) NOT NULL,
    `route` VARCHAR(16) NOT NULL,
    `domain` VARCHAR(64) NULL,
    `rule_floor` VARCHAR(8) NULL,
    `matched_rule_ids` JSON NOT NULL,
    `model_risk` VARCHAR(8) NULL,
    `model_reason` TEXT NULL,
    `classifier_version` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `risk_assessment_logs_project_id_created_at_idx`(`project_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `dingtalk_contact_staging` ADD CONSTRAINT `dingtalk_contact_staging_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `dingtalk_sync_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `skill_review_logs` ADD CONSTRAINT `skill_review_logs_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
