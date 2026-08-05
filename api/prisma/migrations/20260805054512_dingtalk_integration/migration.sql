-- AlterTable
ALTER TABLE `users` ADD COLUMN `dingtalk_phone` VARCHAR(32) NULL,
    ADD COLUMN `dingtalk_user_id` VARCHAR(128) NULL;

-- CreateTable
CREATE TABLE `bp_domain_maps` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bp_domain_maps_domain_idx`(`domain`),
    UNIQUE INDEX `bp_domain_maps_user_id_domain_key`(`user_id`, `domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dingtalk_contacts` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `mobile` VARCHAR(32) NULL,
    `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `dingtalk_contacts_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bp_domain_maps` ADD CONSTRAINT `bp_domain_maps_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
