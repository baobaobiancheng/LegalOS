-- 2026-08-12 咨询附件：multipart 上传 → 后端提取正文 → 注入模型上下文。
ALTER TABLE `project_messages` ADD COLUMN `attachment_ids` JSON NULL;

CREATE TABLE `consultation_attachments` (
    `id` VARCHAR(191) NOT NULL,
    `creator_id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NULL,
    `file_name` VARCHAR(191) NOT NULL,
    `file_size` INT NOT NULL,
    `mime_type` VARCHAR(191) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ready',
    `extracted_text` TEXT NULL,
    `extracted_chars` INT NOT NULL DEFAULT 0,
    `warning` VARCHAR(256) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consultation_attachments_creator_id_idx`(`creator_id`),
    INDEX `consultation_attachments_project_id_idx`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
