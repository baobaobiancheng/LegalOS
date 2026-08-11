-- 2026-08-11 组织架构部门（统一身份映射）：User.department + DingTalkContactStaging.department
-- 钉钉同步按部门拉取写入;CAS 登录用 deptName 更新;CAS_DEPT_MAP 角色映射据此匹配

ALTER TABLE `dingtalk_contact_staging` ADD COLUMN `department` VARCHAR(128) NULL;
ALTER TABLE `users` ADD COLUMN `department` VARCHAR(128) NULL;
