-- CreateTable
CREATE TABLE `projects` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('consult', 'contract', 'research', 'draft') NOT NULL,
    `title` VARCHAR(256) NOT NULL,
    `status` ENUM('分析中', '待处理', '待复核', '已回传', '已取消') NOT NULL DEFAULT '分析中',
    `risk` ENUM('P0', 'P1', 'P2') NOT NULL DEFAULT 'P2',
    `route` VARCHAR(32) NOT NULL DEFAULT 'legalbp',
    `is_failed` BOOLEAN NOT NULL DEFAULT false,
    `skill_id` VARCHAR(64) NULL,
    `skill_name` VARCHAR(128) NULL,
    `model` VARCHAR(128) NULL,
    `delivery_mode` VARCHAR(32) NULL,
    `result` TEXT NULL,
    `creator_id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `legal_bp_id` VARCHAR(191) NULL,
    `requester_name` VARCHAR(128) NULL,
    `requester_department` VARCHAR(128) NULL,
    `crm_reference` VARCHAR(256) NULL,
    `crm_customer` VARCHAR(256) NULL,
    `crm_opportunity` VARCHAR(256) NULL,
    `dingtalk_chat_id` VARCHAR(256) NULL,
    `dingtalk_members` VARCHAR(1024) NULL,
    `weekly_report_label` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `projects_creator_id_idx`(`creator_id`),
    INDEX `projects_owner_id_idx`(`owner_id`),
    INDEX `projects_status_idx`(`status`),
    INDEX `projects_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_messages` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `role` VARCHAR(32) NOT NULL,
    `text` TEXT NOT NULL,
    `label` VARCHAR(256) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `project_messages_project_id_idx`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_events` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `text` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `project_events_project_id_idx`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_creator_id_fkey` FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_legal_bp_id_fkey` FOREIGN KEY (`legal_bp_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_messages` ADD CONSTRAINT `project_messages_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_events` ADD CONSTRAINT `project_events_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
