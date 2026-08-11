-- 2026-08-11 手动绑定路径：dingtalk_contacts 快照表加部门列（review 修复）
-- 之前只加了 staging + users,mergeContacts 用 raw SQL 复制时丢失部门 → 手动绑定读不到部门

ALTER TABLE `dingtalk_contacts` ADD COLUMN `department` VARCHAR(128) NULL;
