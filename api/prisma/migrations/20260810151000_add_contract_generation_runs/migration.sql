-- CreateTable: 合同生成运行（合同流级幂等与版本竞争）
CREATE TABLE `contract_generation_runs` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `request_key` VARCHAR(191) NOT NULL,
    `template_slug` VARCHAR(64) NOT NULL,
    `elements_hash` VARCHAR(64) NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    `document_id` VARCHAR(191) NULL,
    `error_message` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `contract_generation_runs_request_key_key`(`request_key`),
    UNIQUE INDEX `contract_generation_runs_document_id_key`(`document_id`),
    INDEX `contract_generation_runs_project_id_created_at_idx`(`project_id`, `created_at`),
    INDEX `contract_generation_runs_project_id_status_idx`(`project_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `contract_generation_runs` ADD CONSTRAINT `contract_generation_runs_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contract_generation_runs` ADD CONSTRAINT `contract_generation_runs_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `contract_documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
