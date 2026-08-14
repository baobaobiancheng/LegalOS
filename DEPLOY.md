# LegalOS 部署指南

> 生成：2026-08-05
> 适用于服务器全新部署（git clone 后）。

## 一、前置条件

| 依赖 | 版本/说明 |
|------|----------|
| Node.js | ≥ 18（含 fetch） |
| MySQL | ≥ 5.7，建议 8.0（utf8mb4） |
| Codex CLI | AI 服务底层；法律检索 Agent 首期锁定 `0.146.0`，需受管配置(`/etc/codex/*.toml`) + `CODEX_API_KEY`（网关 token） |

## 二、获取代码

```bash
git clone http://git.100credit.cn/zhenghe.bao/LegalOS.git
cd LegalOS
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
| `BAIJIAN_MCP_APP_KEY` | 百鉴 MCP App Key，只进入服务器 Secret，不写入配置文件或命令参数 |
| `BAIJIAN_MCP_APP_SECRET` | 百鉴 MCP App Secret；已在聊天或本地文档暴露的旧值必须先轮换 |

### 可保持默认

`PORT`（3000）、`ACCESS_TOKEN_TTL`、`REFRESH_TOKEN_TTL_MS`、`DINGTALK_MOCK`（`false`=真实钉钉，`true`=本地无凭证 Mock）。

## 四、合同模板源文件（易漏！）

`api/storage/contract-templates/` **被 gitignore**（含 3 套合同模板的 `.docx` 导出文件），
服务器必须手动从本地复制，否则合同导出功能缺模板：

```bash
# 从本地开发机复制
scp -r api/storage/contract-templates user@server:/path/to/LegalOS/api/storage/
```

## 五、安装 + 数据库

```bash
# mv162p170 固定路径
cd ~/LegalOS/LegalOS/api

# 该服务器使用 npm install，不使用 npm ci。
npm install

# 安装后批准 bcrypt / Prisma / esbuild 所需的原生构建脚本；
# 审批会持久化，后续安装可直接复用。不要用 JSON 内容覆盖 .npmrc。
npm approve-scripts bcrypt @prisma/client @prisma/engines prisma esbuild

# 1. 建库（migrate 只建表不建库）
mysql -u root -p -e "CREATE DATABASE legal_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. 每次部署都重新生成 Prisma Client
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
npm test                      # 全部单测通过(数量随代码变化,以 vitest 输出为准)

# 后端由 PM2 托管（api/ 目录）
pm2 restart legalos-api
pm2 list | grep legalos-api

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
| AI 回复失败 | 服务器无 codex CLI/认证 | `npm i -g @openai/codex` + 配 `CODEX_API_KEY` 与 `/etc/codex` 受管配置 |
| 合同导出无模板 | storage 未复制 | 见"四、合同模板源文件" |
| 钉钉同步"部门不在授权范围" | 通讯录权限未批 | 见"八、钉钉集成上线检查清单" |
| 钉钉建群"群主不在可见性内" | 应用可见范围未含群主 | 同上 |

## 十、百鉴 MCP / Codex Agent PR0 技术闸门

法律检索功能启用前，服务器必须先通过下面两层检查。普通 PR CI 只运行脱敏契约夹具；真实检查只在受控服务器或预发布环境运行。

环境变量至少包括：

```text
CODEX_HARDENED=true
AI_EXECUTION_ENABLED=true
CODEX_API_KEY=<公司大模型网关 token>
BAIJIAN_MCP_URL=https://mcpgateway.100credit.cn/mcp
BAIJIAN_MCP_APP_KEY=<轮换后的 key>
BAIJIAN_MCP_APP_SECRET=<轮换后的 secret>
```

不要使用 `set -x`，不要把 Secret 直接写进 shell 命令、`.env.example`、日志或 CI 产物。推荐由 systemd、容器 Secret 或 CI Secret 注入。
先安装仓库中锁定版本的受管策略：

```bash
sudo install -D -o root -g root -m 0644 \
  deploy/codex/requirements.toml.example \
  /etc/codex/requirements.toml
```

```bash
cd api

# 0. CLI 版本、Secret 存在性、受管策略内容与文件权限
npm run codex:baijian-preflight

# 1. 官方 MCP TypeScript SDK：initialize + tools/list + 可选真实查询
npm run baijian:verify -- health
npm run baijian:verify -- law '劳动合同'
npm run baijian:verify -- case '劳动合同违法解除经济补偿的中国类似案例'

# 2. Codex Agent：受管策略 + 单工具白名单 + required MCP + JSONL/结构化结果
npm run codex:baijian-gate -- law '劳动合同解除经济补偿'
npm run codex:baijian-gate -- case '劳动合同违法解除经济补偿的中国类似案例'
```

如需验证推理平台提供的候选 Agent 模型名，只覆盖本次命令，不要修改系统默认模型：

```bash
CODEX_AGENT_MODEL='glm-5.2' npm run codex:baijian-gate -- law '劳动合同解除经济补偿'
CODEX_AGENT_MODEL='glm-5.2' npm run codex:baijian-gate -- case '劳动合同违法解除经济补偿的中国类似案例'
```

先将 `deploy/codex/requirements.toml.example` 以 root 安装为 `/etc/codex/requirements.toml`，建议权限 `0644` 或更严格；不要在服务器上手工重写策略。策略使用 `legalos_ai` 只读权限档案，仅允许读取本次工作区；不在系统层全局关闭 shell，因为现有合同起草需要用它只读读取 `templates/*.md`。法律检索 Agent 会在单次命令行中用 `--disable shell_tool` 关闭 shell。`CODEX_MANAGED_REQUIREMENTS_PATH` 只覆盖预检脚本的检查路径，真实 Agent 闸门固定验证 Codex CLI 实际加载的 `/etc/codex/requirements.toml`。Agent 命令行只配置 `env_http_headers` 的环境变量名称，不包含凭证值；每次运行只把 `lawstar_data_professional_query` 或 `ldh_search` 之一放入 `enabled_tools`，并设置 `required=true`。任何未观察到必需工具结果、出现额外工具、坏 JSONL、结果文件缺失、有命中却无权威 ID 引用，或受管策略缺失都视为闸门失败，不得启用咨询 Agent。
