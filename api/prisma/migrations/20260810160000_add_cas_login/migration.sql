-- T1: CAS 统一登录 —— User.casUsername + RefreshToken.authMethod/originalExpiresAt

-- AlterTable `users`: 增加 CAS 绑定唯一列
ALTER TABLE `users` ADD COLUMN `cas_username` VARCHAR(128) NULL;

-- CreateIndex: 一个系统用户最多绑一个 CAS 账号(与 dingtalk_user_id 同约束)
CREATE UNIQUE INDEX `users_cas_username_key` ON `users`(`cas_username`);

-- AlterTable `refresh_tokens`: 会话上限(T6)——authMethod 区分来源,originalExpiresAt 链寿命封顶
ALTER TABLE `refresh_tokens` ADD COLUMN `auth_method` VARCHAR(16) NOT NULL DEFAULT 'password';
ALTER TABLE `refresh_tokens` ADD COLUMN `original_expires_at` DATETIME NULL;

-- 存量种子用户绑定真实 CAS 账号(T3:防重复人,历史数据无缝衔接)
-- ⚠️ 假定 CAS 账号为 firstname.lastname(与 zhenghe.bao 同格式);若实际不同,部署前先改这几行
-- 赵俊芳→admin / 彭宇欣→legal_bp / 田强→business(与钉钉 auto-bind 映射一致)
UPDATE `users` SET `cas_username` = 'junfang.zhao' WHERE `username` = 'admin' AND `cas_username` IS NULL;
UPDATE `users` SET `cas_username` = 'yuxin.peng' WHERE `username` = 'legal_bp' AND `cas_username` IS NULL;
UPDATE `users` SET `cas_username` = 'qiang.tian' WHERE `username` = 'business' AND `cas_username` IS NULL;
