-- 2026-08-12 review 第4轮：
-- 1. extracted_text TEXT(≈65KB) → MEDIUMTEXT：代码允许 50,000 个中文字符(≈150KB)，TEXT 会溢出
-- 2. project_id 加外键 + ON DELETE CASCADE：项目删除后不留法律文档正文残留
ALTER TABLE `consultation_attachments` MODIFY COLUMN `extracted_text` MEDIUMTEXT NULL;

ALTER TABLE `consultation_attachments`
  ADD CONSTRAINT `consultation_attachments_project_id_fk`
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE;
