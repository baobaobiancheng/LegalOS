-- 2026-08-11 种子账号固定为测试账号（三端测试固定角色,不参与组织同步）
-- 之前迁移把 junfang.zhao/yuxin.peng/qiang.tian 绑到种子 admin/legal_bp/business,
-- 组织映射把种子 admin 降级成 legal_lead → 平台无人有 admin。
-- 修复:恢复种子角色 + 解除 CAS/钉钉绑定（真实员工 CAS 登录将建独立用户,按组织映射给角色）。

UPDATE `users` SET role='admin',    cas_username=NULL, dingtalk_user_id=NULL, department=NULL
  WHERE username='admin'    AND cas_username='junfang.zhao';
UPDATE `users` SET role='legal_bp', cas_username=NULL, dingtalk_user_id=NULL, department=NULL
  WHERE username='legal_bp' AND cas_username='yuxin.peng';
UPDATE `users` SET role='business', cas_username=NULL, dingtalk_user_id=NULL, department=NULL
  WHERE username='business' AND cas_username='qiang.tian';
