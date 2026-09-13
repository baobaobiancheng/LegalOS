# 法务AI平台 · Legal Workbench

> v0.0.1 — 统一登录与权限管理 + 三端 Apple 风格 UI

## 架构

```
LegalOS/
├── api/                     # NestJS 后端 (TypeScript)
│   ├── prisma/              # 数据模型 + 迁移 + 种子
│   └── src/
│       ├── modules/auth/    # 认证模块（JWT + RBAC）
│       ├── common/          # 守卫 / 装饰器 / 过滤器
│       └── prisma/          # 数据库服务
├── web/                     # Vue 3 前端 (TypeScript)
│   └── src/
│       ├── views/           # 页面（按端分组）
│       ├── stores/          # Pinia 状态
│       ├── router/          # 路由 + 守卫
│       └── api/             # HTTP 客户端（JWT 注入 + refresh 拦截）
└── package.json             # 工作区脚本
```

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + Pinia + Vue Router 4 + 纯 CSS (Apple 风格) |
| 后端 | NestJS + Prisma + passport-jwt + bcrypt |
| 数据库 | MySQL 8.0 |
| 认证 | JWT 双 Token（accessToken 15min 内存 + refreshToken 24h httpOnly cookie） |

## 快速启动

### 1. 环境准备

- Node.js 24 LTS（最低支持 22.19，CI 使用 24）
- MySQL 8.0+
- 复制 `api/.env.example` → `api/.env`，修改数据库密码

### DSH 运行时

嵌入式 DSH 固定为 `0.1.5-rc.2`，使用官方类型和最小只读法律工具配置，不加载 Shell、文件写入、浏览器或子代理插件。会话投影、压缩、持久化和工具超时由原生插件负责，LegalOS 负责业务鉴权、并发队列和检索证据校验。

- 新会话使用 `legalos-0.1.5-rc.2-` 前缀，日志保存在 `$DSH_HOME/sessions-0.1.5-rc.2`；未配置 `DSH_HOME` 时基目录为 `api/.tmp/dsh-home`。
- 不兼容、不迁移旧 DSH 日志；旧业务记录可继续查看，追问时按业务上下文启动新版执行会话。旧文件不删除。
- 正文按成功提交的 `assistant/message` 发布，失败或放弃的生成尝试不拼接进答案；工具进度实时发布。终态在持久化与 Agent 释放完成后才发出。
- 本次 DSH 升级无需数据库迁移，生产 Node 24 可直接使用。CRM 未启用时无需增加 CRM 配置。
- 离线运行时验收：在 `api` 目录执行 `npm run build && npm run dsh:runtime-gate`，覆盖真实 CJS 启动、只读工具调用、结果元数据和 JSONL 冷恢复；使用本机 HTTP 测试模型，不需要凭证或数据库。
- 真实模型验收：配置现有 `DSH_LLM_*` 或 `LLM_*` 后执行 `npm run dsh:model-gate`；百鉴链路另执行 `npm run dsh:baijian-gate`。

### 2. 创建数据库

```sql
CREATE DATABASE legal_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 安装 + 迁移 + 种子

```bash
# 安装根依赖
npm install

# 安装前后端依赖 + 数据库迁移 + 种子用户
npm run setup
```

### 4. 启动

```bash
# 开发模式（前后端同时启动）
npm run dev

# 仅后端（生产）
npm run build && npm start
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:3000
- API 文档：当前未启用 Swagger（无固定地址；接口契约以 `api/src/modules/**/dto` 为准）

## 种子账号

| 用户名 | 密码 | 角色 | 首页 |
|--------|------|------|------|
| `admin` | 见 `api/.env` 的 `SEED_ADMIN_PASSWORD` | 管理员 | /admin/dashboard |
| `business` | 见 `api/.env` 的 `SEED_BUSINESS_PASSWORD` | 业务人员 | /business/consult |

法务 BP、法务负责人不再创建本地种子账号，由管理员预开通或员工首次通过 CAS 登录创建。

## API 端点

```
POST   /api/auth/login     # 登录（速率限制 5/分钟）
POST   /api/auth/refresh   # 刷新 accessToken
GET    /api/auth/me         # 当前用户
POST   /api/auth/logout     # 退出
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | MySQL 连接串 | — |
| `JWT_SECRET` | JWT 签名密钥 | — |
| `PORT` | API 端口 | `3000` |
| `WEB_ORIGIN` | 前端地址 (CORS) | `http://localhost:5173` |
| `CONTRACT_TEMPLATE_STORAGE_DIR` | 审定合同模板目录；每个启用模板须有 `{slug}/{slug}.md` | `api/storage/contract-templates`（从 API 工作目录解析） |

### 合同生成与历史记录

- 合同起草由服务端读取审定模板正文并传给 DSH，不依赖模型文件工具。缺失、空白、超长或已停用模板会明确拒绝生成；部署时须同步模板目录，不得用未经确认的正文替代。
- 生成失败或取消后可用原请求键重试；同一键更改模板或要素返回 409。同一工单同时只运行一条生成任务，迟到结果不能覆盖新尝试或人工办结结果。
- `GET /api/projects/:id` 默认返回最新 200 条消息和 100 条事件，各自按时间正序展示。响应 `history.beforeMessageId` / `beforeEventId` 非空时，可作为同名查询参数加载更早记录；游标只在所属工单内有效。三个对话入口均提供“加载更早记录”。

### 审计完整性与摘要

`AUDIT_HMAC_SECRET` 配置后只认证 `hmac-sha256-v1` 事件；既有普通 SHA-256 事件仍可查询，但不作为 HMAC 完整性认证通过的记录。切换密钥或首次启用 HMAC 前应明确历史核验范围，不要批量重签历史事件来伪造其原始可信性。

已停止生成无查询/核验用途的失败原因哈希、法律检索审计查询哈希和法规正文缓存哈希；使用运行 ID、原因码及原有缓存键关联。保留密码/刷新令牌保护、CRM 签名与幂等、缓存键和审计完整性所需哈希。兼容现有数据库列，不新增删除列迁移。

### 本地用 DeepSeek 验证 dsh

在 `api/.env` 中设置独立的 `DSH_LLM_*`，不会覆盖咨询直连路径使用的 `LLM_*` 公司网关：

```text
DSH_LLM_PROVIDER=deepseek
DSH_LLM_BASE_URL=https://api.deepseek.com
DSH_LLM_API_KEY=<本地 DeepSeek API Key>
DSH_LLM_MODEL=deepseek-v4-pro
DSH_MODEL_CONTEXT_WINDOW=1000000
DSH_MODEL_MAX_OUTPUT_TOKENS=16000
```

配置 Key 后可先运行 `cd api && npm run dsh:model-gate`，再从合同生成/审查入口测试完整 dsh 流程。法律咨询入口当前仍使用原有 `ConsultationChatService`，会在 PR1 接入 dsh 检索 Agent。

## 下一步

- [ ] 工单/项目管理模块（Phase 2）
- [ ] Swagger API 文档 + openapi-typescript 类型同步
- [ ] 自动化测试（vitest + supertest）
- [ ] 钉钉 / CRM Adapter 真实对接
