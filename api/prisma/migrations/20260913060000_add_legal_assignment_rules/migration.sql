ALTER TABLE `dingtalk_contacts` ADD COLUMN `department_ids` JSON NULL;
ALTER TABLE `dingtalk_contact_staging` ADD COLUMN `department_ids` JSON NULL;

CREATE TABLE `dingtalk_departments` (
  `id` VARCHAR(32) NOT NULL,
  `parent_id` VARCHAR(32) NULL,
  `name` VARCHAR(128) NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  INDEX `dingtalk_departments_parent_id_idx` (`parent_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `legal_assignment_rules` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `description` TEXT NOT NULL,
  `department_id` VARCHAR(32) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `include_descendants` BOOLEAN NOT NULL DEFAULT true,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  INDEX `legal_assignment_rules_department_id_idx` (`department_id`),
  INDEX `legal_assignment_rules_user_id_idx` (`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `legal_assignment_rules` ADD CONSTRAINT `legal_assignment_rules_department_id_fkey`
  FOREIGN KEY (`department_id`) REFERENCES `dingtalk_departments` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `legal_assignment_rules` ADD CONSTRAINT `legal_assignment_rules_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
