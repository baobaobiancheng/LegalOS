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
| `LEGAL_RESEARCH_SEARCH_CACHE_TTL_MS` | 法规/类案精确请求快照 TTL，默认 24 小时 |
| `LEGAL_RESEARCH_LAW_DETAIL_CACHE_TTL_MS` | 法规正文再校验间隔，默认 30 天 |

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

# bcrypt / Prisma / esbuild 的 install-script 白名单已由 api/package.json 统一管理。
# 服务器不要再执行 npm approve-scripts 修改 package.json，否则下次 pull 会产生冲突。

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
| `business` | SEED_BUSINESS_PASSWORD | 业务（田强） |

法务 BP、法务负责人统一使用 CAS 身份，不再提供本地密码账号。部署后通过成员管理预开通，或由员工首次 CAS 登录创建。

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
| dsh AI 回复失败 | 模型凭证、余额或网关配置异常 | `npm run dsh:model-gate`；检查 `DSH_LLM_*`（独立模型）或 `LLM_*`（公司网关） |
| 合同导出无模板 | storage 未复制 | 见"四、合同模板源文件" |
| 钉钉同步"部门不在授权范围" | 通讯录权限未批 | 见"八、钉钉集成上线检查清单" |
| 钉钉建群"群主不在可见性内" | 应用可见范围未含群主 | 同上 |

## 十、百鉴 MCP / dsh Agent PR0 技术闸门

法律检索功能启用前，服务器必须先通过下面两层检查。普通 PR CI 只运行脱敏契约夹具；真实检查只在受控服务器或预发布环境运行。

环境变量至少包括：

```text
AI_EXECUTION_ENABLED=true
LLM_BASE_URL=<公司 OpenAI-compatible 大模型网关 /v1 地址>
LLM_API_KEY=<公司大模型网关 token>
LLM_MODEL=glm-5-2
DSH_HOME=/home/zhenghe.bao/LegalOS/LegalOS/api/.data/dsh
DSH_MODEL_CONTEXT_WINDOW=131072
DSH_MODEL_MAX_OUTPUT_TOKENS=16000
DSH_AGENT_TOOL_CALL_MAX=5
BAIJIAN_MCP_URL=https://mcpgateway.100credit.cn/mcp
BAIJIAN_MCP_APP_KEY=<轮换后的 key>
BAIJIAN_MCP_APP_SECRET=<轮换后的 secret>
LEGAL_RESEARCH_SEARCH_CACHE_TTL_MS=86400000
LEGAL_RESEARCH_LAW_DETAIL_CACHE_TTL_MS=2592000000
```

不要使用 `set -x`，不要把 Secret 直接写进 shell 命令、`.env.example`、日志或 CI 产物。推荐由 systemd、容器 Secret 或 CI Secret 注入。
首次部署先创建 dsh 持久目录，并确保只有 API 运行用户可以访问：

```bash
install -d -m 0700 "$HOME/LegalOS/LegalOS/api/.data/dsh"
```

```bash
cd api

# 1. 官方 MCP TypeScript SDK：initialize + tools/list + 真实查询
npm run baijian:verify -- health
npm run baijian:verify -- law '劳动合同'
npm run baijian:verify -- law-advanced '劳动合同'
npm run baijian:verify -- law-semantic '违法解除劳动合同如何计算赔偿金'
npm run baijian:verify -- case '劳动合同违法解除经济补偿的中国类似案例'

# 2. 嵌入式 dsh Agent：自主规划 query + 单个只读工具 + 权威来源 ID 校验
npm run dsh:model-gate
npm run dsh:baijian-gate -- law '劳动合同解除经济补偿'
npm run dsh:baijian-gate -- case '劳动合同违法解除经济补偿的中国类似案例'
```

PR-B 的 AI 搜法会同时开放关键词、高级、语义、单条法规详情和批量法规详情五个受控工具。批量详情单次最多核验 10 部本轮候选法规；法规搜索命中后必须读取至少一份本轮候选正文，最终回答只能引用已读取详情的 32 位法规 ID；证据校验通过前不向客户端输出模型正文。高级与语义检索同样经过 PR-A 缓存，不新增 Redis 或环境变量。

PR-A 部署必须执行 `20260824150000_add_legal_research_cache` migration，新增权威文档投影、精确请求快照和脱敏成本台账。当前单 API 实例使用进程内 single-flight，不依赖 Redis。同一精确请求在 TTL 内直接复用本地快照；只有显式「刷新权威数据」、缓存缺失或过期时才再调用百鉴。

PR1/PR2 部署还会执行 `20260820190000_add_consultation_research_trace` migration。它只给
`consultation_runs` 增加能力快照、dsh 会话 ID 和有界来源 trace；不依赖 Redis。法务独立检索接口为
`GET /api/legal-research/laws` 与 `GET /api/legal-research/cases`，受登录角色和应用内限流保护。

dsh 在进程内只为本次运行注册 `search_laws` 或 `search_similar_cases` 之一；工具内部复用官方 MCP TypeScript SDK 与 `BaijianResultNormalizer`，模型看不到供应商凭证。每轮事件、checkpoint 和压缩结果写入 `DSH_HOME`，请确保目录持久化且仅 API 运行用户可读写。任何未观察到必需工具结果、出现额外工具、工具报错、有命中却无权威 ID 引用或最终 JSON 无效，都视为闸门失败，不得启用咨询检索 Agent。

迁移期间 `codex:baijian-preflight` 与 `codex:baijian-gate` 仅保留作旧实现诊断，不再是新 dsh 路径的上线条件；因此 dsh 闸门不依赖 Codex CLI、`/etc/codex/requirements.toml` 或 Codex 的模型元数据。等上述两道 dsh Agent 闸门在真实服务器都通过后，再删除旧 Codex Agent 文件与部署配置。

dsh 的会话、checkpoint、token meter、工具结果裁剪和压缩都直接使用上游包，不复制其内部实现。版本由 `package-lock.json` 固定；升级时应在独立提交中统一更新整组 `@deepseek-ai/dsh-*` 包，重新运行 `npm run ci` 以及法规、类案两道真实闸门，禁止只升级其中一个核心包后直接上线。
