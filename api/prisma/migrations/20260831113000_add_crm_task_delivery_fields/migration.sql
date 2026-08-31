-- CRM 审核任务主键与交付状态：
-- source_app_id + crm_task_id 区分一次审核任务，contract_no 仅作为合同业务号。
-- 内部审核完成后独立跟踪 CRM 交付，避免将失败误报为“已送达”。
ALTER TABLE `projects`
  ADD COLUMN `source_app_id` VARCHAR(64) NULL,
  ADD COLUMN `crm_task_id` VARCHAR(128) NULL,
  ADD COLUMN `contract_no` VARCHAR(128) NULL,
  ADD COLUMN `crm_payload_sha256` CHAR(64) NULL,
  ADD COLUMN `crm_file_manifest_sha256` CHAR(64) NULL,
  ADD COLUMN `review_status` ENUM('review_completed') NULL,
  ADD COLUMN `review_completed_at` DATETIME(3) NULL,
  ADD COLUMN `crm_delivery_status` ENUM('pending', 'sending', 'delivered', 'failed', 'dead') NULL,
  ADD COLUMN `crm_delivery_updated_at` DATETIME(3) NULL,
  ADD COLUMN `crm_delivered_at` DATETIME(3) NULL,
  ADD COLUMN `crm_delivery_last_error` TEXT NULL,
  ADD COLUMN `crm_delivery_file_id` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `projects_source_app_id_crm_task_id_key`
  ON `projects`(`source_app_id`, `crm_task_id`);

-- PDF/TXT/MD/DOCX 解析后的合同正文可超过 TEXT 的 64KB 上限。
ALTER TABLE `project_messages`
  MODIFY COLUMN `text` LONGTEXT NOT NULL;
