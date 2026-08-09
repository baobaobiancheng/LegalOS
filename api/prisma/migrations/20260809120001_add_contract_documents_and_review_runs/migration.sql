-- CreateTable: 合同文档版本（P1-05）
CREATE TABLE `contract_documents` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `document_type` ENUM('draft', 'revised', 'final') NOT NULL,
    `version` INTEGER NOT NULL,
    `content` LONGTEXT NOT NULL,
    `source_file_id` VARCHAR(64) NULL,
    `created_by` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `contract_documents_project_id_version_key`(`project_id`, `version`),
    INDEX `contract_documents_project_id_document_type_created_at_idx`(`project_id`, `document_type`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: 合同审查运行（P1-05）
CREATE TABLE `contract_review_runs` (
    `id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `source_document_id` VARCHAR(191) NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    `result` LONGTEXT NULL,
    `skill_id` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contract_review_runs_project_id_created_at_idx`(`project_id`, `created_at`),
    INDEX `contract_review_runs_source_document_id_idx`(`source_document_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contract_review_runs` ADD CONSTRAINT `contract_review_runs_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contract_review_runs` ADD CONSTRAINT `contract_review_runs_source_document_id_fkey` FOREIGN KEY (`source_document_id`) REFERENCES `contract_documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
