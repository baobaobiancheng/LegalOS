-- CreateTable: 事务 Outbox（P1-03/P1-04）
CREATE TABLE `outbox_events` (
    `id` VARCHAR(191) NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    `aggregate_type` VARCHAR(64) NOT NULL,
    `aggregate_id` VARCHAR(191) NOT NULL,
    `dedup_key` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('pending', 'processing', 'succeeded', 'dead') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimed_at` DATETIME(3) NULL,
    `claim_token` VARCHAR(64) NULL,
    `last_error` TEXT NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `project_id` VARCHAR(191) NULL,

    INDEX `outbox_events_status_available_at_idx`(`status`, `available_at`),
    INDEX `outbox_events_aggregate_id_idx`(`aggregate_id`),
    INDEX `outbox_events_project_id_idx`(`project_id`),
    UNIQUE INDEX `outbox_events_dedup_key_key`(`dedup_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `outbox_events` ADD CONSTRAINT `outbox_events_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
