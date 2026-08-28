-- 仅保存钉钉返回的 HTTPS 头像 URL，不落库图片二进制文件。
ALTER TABLE `users`
    ADD COLUMN `avatar_url` TEXT NULL;

ALTER TABLE `dingtalk_contacts`
    ADD COLUMN `avatar_url` TEXT NULL;

ALTER TABLE `dingtalk_contact_staging`
    ADD COLUMN `avatar_url` TEXT NULL;
