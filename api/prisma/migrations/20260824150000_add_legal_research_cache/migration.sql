CREATE TABLE `legal_source_documents` (
  `id` VARCHAR(191) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `external_id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `title` VARCHAR(512) NOT NULL,
  `metadata` JSON NOT NULL,
  `content` JSON NULL,
  `content_hash` CHAR(64) NULL,
  `content_verified_at` DATETIME(3) NULL,
  `fetched_at` DATETIME(3) NOT NULL,
  `last_verified_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `legal_source_documents_source_external_id_key` (`source`, `external_id`),
  INDEX `legal_source_documents_kind_last_verified_at_idx` (`kind`, `last_verified_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `legal_search_snapshots` (
  `id` VARCHAR(191) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `capability` VARCHAR(32) NOT NULL,
  `tool_name` VARCHAR(64) NOT NULL,
  `payload` JSON NOT NULL,
  `fetched_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `legal_search_snapshots_request_hash_key` (`request_hash`),
  INDEX `legal_search_snapshots_capability_expires_at_idx` (`capability`, `expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `legal_research_usage` (
  `id` VARCHAR(191) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `capability` VARCHAR(32) NOT NULL,
  `tool_name` VARCHAR(64) NOT NULL,
  `cache_status` VARCHAR(16) NOT NULL,
  `supplier_called` BOOLEAN NOT NULL,
  `record_count` INTEGER NOT NULL DEFAULT 0,
  `duration_ms` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `legal_research_usage_capability_created_at_idx` (`capability`, `created_at`),
  INDEX `legal_research_usage_request_hash_created_at_idx` (`request_hash`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
