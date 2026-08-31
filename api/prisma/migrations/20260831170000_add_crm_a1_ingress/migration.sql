-- CRM A1 入站防重放 nonce：同一 AppId 下 nonce 仅能成功占用一次。
CREATE TABLE `crm_inbound_nonces` (
  `id` VARCHAR(191) NOT NULL,
  `app_id` VARCHAR(64) NOT NULL,
  `nonce` VARCHAR(128) NOT NULL,
  `request_timestamp` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `crm_inbound_nonces_app_id_nonce_key`(`app_id`, `nonce`),
  INDEX `crm_inbound_nonces_expires_at_idx`(`expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CRM 原始文件合并成一个可审查 source 文档，与法务修订版/定稿分离。
ALTER TABLE `contract_documents`
  MODIFY COLUMN `document_type` ENUM('draft', 'revised', 'final', 'source') NOT NULL;

-- 原有 revised/final 数据可直接保留，新增 CRM 原始文件类型由数据库约束。
ALTER TABLE `contract_files`
  MODIFY COLUMN `kind` ENUM('source', 'attachment', 'main_contract', 'revised', 'final') NOT NULL;
