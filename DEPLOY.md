# LegalPlatform 部署指南

> 生成：2026-08-05
> 适用于服务器全新部署（git clone 后）。

## 一、前置条件

| 依赖 | 版本/说明 |
|------|----------|
| Node.js | ≥ 18（含 fetch） |
| MySQL | ≥ 5.7，建议 8.0（utf8mb4） |
| Codex CLI | AI 服务底层（`npm install -g @openai/codex` + `codex login`） |

## 二、获取代码

```bash
git clone http://git.100credit.cn/zhenghe.bao/LegalOS.git
cd LegalOS/LegalPlatform
```

## 三、配置 .env（关键，全部要重新填）

`.env` 不随代码提交（gitignore 保护），**所有非默认值需在服务器手动配置**。
参考 `api/.env.example`，复制为 `api/.env`：

```bash
cp api/.env.example api/.env
```

### 必须重新配置的项

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 服务器 MySQL 连接串，如 `mysql://user:pass@host:3306/legal_platform` |
| `JWT_SECRET` | **必须换强随机串**（生产不要用示例值）——生成：`openssl rand -base64 32` |
| `WEB_ORIGIN` | 前端访问地址（CORS 白名单），如 `https://legal.example.com` |
| `DINGTALK_APP_KEY` | 钉钉企业内部应用 Client ID |
| `DINGTALK_APP_SECRET` | 钉钉 Client Secret |
| `DINGTALK_AGENT_ID` | 钉钉 AgentId |
| `DINGTALK_ROBOT_CODE` | 钉钉机器人 Code |
| `SEED_ADMIN_PASSWORD` 等 4 个 | 种子账号初始密码（首次 `db seed` 生效，之后改密码不走 seed） |

### 可保持默认

`PORT`（3000）、`ACCESS_TOKEN_TTL`、`REFRESH_TOKEN_TTL_MS`、`DINGTALK_MOCK`（`false`=真实钉钉，`true`=本地无凭证 Mock）。

## 四、合同模板源文件（易漏！）

`api/storage/contract-templates/` **被 gitignore**（含 3 套合同模板的 `.docx` 导出文件），
服务器必须手动从本地复制，否则合同导出功能缺模板：

```bash
# 从本地开发机复制
scp -r api/storage/contract-templates user@server:/path/to/LegalPlatform/api/storage/
```

## 五、安装 + 数据库

```bash
cd LegalPlatform/api
npm install

# 1. 建库（migrate 只建表不建库）
mysql -u root -p -e "CREATE DATABASE legal_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. 生成 Prisma Client
npx prisma generate

# 3. 应用全部 migration 建表（7 个，含技能库/钉钉）
npx prisma migrate deploy

# 4. 种子数据（账号/技能/BP 领域映射）
npx prisma db seed
```

## 六、构建 + 验证 + 启动

```bash
# 验证
npm run build
npm test                      # 应 74/74 通过

# 后端启动（api/ 目录）
npm run start:prod

# 前端（web/ 目录，若同机部署）
cd ../web && npm install && npm run build
# 产物在 web/dist/，由 Nginx 等托管；前端 API 地址需配代理到 :3000
```

## 七、种子账号（`db seed` 后）

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | `.env` SEED_ADMIN_PASSWORD | 管理员（赵俊芳） |
| `legal_bp` | SEED_LEGAL_BP_PASSWORD | 法务 BP（彭宇欣） |
| `legal_lead` | SEED_LEGAL_LEAD_PASSWORD | 法务负责人 |
| `business` | SEED_BUSINESS_PASSWORD | 业务（田强） |

## 八、钉钉集成上线检查清单

1. 钉钉后台：应用已授权「**通讯录部门成员读权限**」+ 可选「企业员工手机号信息」
2. 钉钉后台：应用**可见范围**含全员或目标用户（否则建群报"群主不在应用可见性内"）
3. `.env`：`DINGTALK_MOCK=false` + 4 项凭证正确
4. 管理端（admin 登录）→ 成员管理 → **一键同步** → 确认员工按姓名自动绑定

## 九、疑难排查

| 症状 | 原因 | 处理 |
|------|------|------|
| 启动报缺表 | 未跑 `migrate deploy` | `npx prisma migrate deploy` |
| 登录"服务响应异常" | API 进程未启动 | 检查 `:3000` 监听 + 启动日志 |
| AI 回复失败 | 服务器无 codex CLI/认证 | `npm i -g @openai/codex` + `codex login` |
| 合同导出无模板 | storage 未复制 | 见"四、合同模板源文件" |
| 钉钉同步"部门不在授权范围" | 通讯录权限未批 | 见"八、钉钉集成上线检查清单" |
| 钉钉建群"群主不在可见性内" | 应用可见范围未含群主 | 同上 |
