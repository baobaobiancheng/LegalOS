-- AlterTable
ALTER TABLE `projects` ADD COLUMN `idempotency_key` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `projects_idempotency_key_key` ON `projects`(`idempotency_key`);
