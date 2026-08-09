-- P1-07 上线前重复绑定检查(只读,不修改任何数据)
-- 用法: mysql legal_platform < prisma/check-duplicate-dingtalk-binding.sql
-- 若输出非空,说明 users.dingtalk_user_id 存在重复绑定,必须先由管理员确认保留哪个用户,
-- 清理后再执行 `prisma migrate deploy`(唯一索引才能建上)。
SELECT
    u1.id AS system_user_id,
    u1.display_name,
    u1.dingtalk_user_id
FROM users u1
JOIN (
    SELECT dingtalk_user_id, COUNT(*) AS cnt
    FROM users
    WHERE dingtalk_user_id IS NOT NULL
    GROUP BY dingtalk_user_id
    HAVING COUNT(*) > 1
) dup ON dup.dingtalk_user_id = u1.dingtalk_user_id
ORDER BY u1.dingtalk_user_id, u1.id;
