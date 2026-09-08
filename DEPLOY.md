# LegalOS 部署指南

> 更新：2026-08-31
> 适用于服务器全新部署（git clone 后）。

## 一、前置条件

| 依赖 | 版本/说明 |
|------|----------|
| Node.js | 20.16+（20.x）或 22.3+；推荐 22 LTS（PDF 解析依赖要求） |
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
| `SEED_ADMIN_PASSWORD` / `SEED_BUSINESS_PASSWORD` | 可选的首次初始化密码；仅在账号不存在时生效，须至少 12 位且包含大小写字母、数字和符号；生产建议留空并通过 CAS 预开通 |
| `BAIJIAN_MCP_APP_KEY` | 百鉴 MCP App Key，只进入服务器 Secret，不写入配置文件或命令参数 |
| `BAIJIAN_MCP_APP_SECRET` | 百鉴 MCP App Secret；已在聊天或本地文档暴露的旧值必须先轮换 |
| `LEGAL_RESEARCH_SEARCH_CACHE_TTL_MS` | 法规/类案精确请求快照 TTL，默认 24 小时 |
| `LEGAL_RESEARCH_LAW_DETAIL_CACHE_TTL_MS` | 法规正文再校验间隔，默认 30 天 |
| `CRM_A1_ENABLED` | 是否开放 CRM A1 入站；正式联调设为 `true` |
| `CRM_A1_APP_ID` | CRM 调用方 AppId，必须与双方登记值一致 |
| `CRM_A1_SECRET` | A1 HMAC Secret，由受管 Secret 注入且至少 32 字节 |
| `CRM_A1_ALLOWED_IPS` | CRM 直连源 IP 白名单，生产启用 A1 时必填；不读取 `X-Forwarded-For` |
| `CONTRACT_STORAGE_DIR` | 合同文件持久目录；多实例 API/Worker 必须挂载同一共享卷 |

### 可保持默认

`PORT`（3000）、`ACCESS_TOKEN_TTL`、`REFRESH_TOKEN_TTL_MS`、`CONTRACT_FILE_PARSE_CONCURRENCY`（2，允许 1..4）、`DINGTALK_MOCK`（`false`=真实钉钉，`true`=本地无凭证 Mock）。`CRM_MOCK` 生产必须保持 `false`。

## 四、合同模板源文件（易漏！）

`api/storage/contract-templates/` **被 gitignore**（含 3 套合同模板的 `.docx` 导出文件），
服务器必须手动从本地复制，否则合同导出功能缺模板：

```bash
# 从本地开发机复制
scp -r api/storage/contract-templates user@server:/path/to/LegalOS/api/storage/
```

合同上传和 CRM A1 原文件不能依赖发布目录内的临时磁盘。先创建持久目录，并将绝对路径写入
`CONTRACT_STORAGE_DIR`；API 运行用户必须拥有该目录，多实例必须挂载同一个共享卷：

```bash
# 以运行 PM2/API 的同一账号执行。
install -d -m 0700 /home/zhenghe.bao/LegalOS/shared/contracts
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

# 3. 先确认待执行 migration
npx prisma migrate status

# 4. 应用仓库内全部 migration
npx prisma migrate deploy

# 5. 种子数据（仅首次部署或明确需要刷新种子时执行）
npx prisma db seed
```

升级已有环境时，`20260831113000_add_crm_task_delivery_fields` 会修改 `projects`、
`project_messages`，`20260831170000_add_crm_a1_ingress` 会修改合同文件/文档枚举并创建 nonce 表。
MySQL 5.7 上这些 `ALTER TABLE` 可能重建表或持有元数据锁，不能承诺零停机。部署前必须：

1. 通过 `information_schema.tables` 核对 `projects`、`project_messages`、`contract_files`、`contract_documents` 的行数和数据量。
2. 完成可恢复的数据库备份并验证恢复路径。
3. 在维护窗口停止写流量后执行 `npx prisma migrate deploy`；超大表由 DBA 评估在线 DDL 工具。
4. 迁移后再次执行 `npx prisma migrate status`，确认所有 migration 均为 applied。

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

## 七、CRM A1 上线检查

1. 受管 Secret 已注入 `CRM_A1_APP_ID`、至少 32 字节的 `CRM_A1_SECRET`，命令和日志中不出现明文。
2. `CRM_A1_ALLOWED_IPS` 填写负载均衡之后 API socket 实际看到的 CRM 源 IP；当前实现不信任 `X-Forwarded-For`。
3. `CONTRACT_STORAGE_DIR` 是绝对持久路径、权限为 API 用户可读写，且各 API/Worker 实例共享同一卷。
4. 真实 CRM 回传 Adapter 尚未接入前保持 `CRM_MOCK=false`；失败任务应进入 Outbox 重试/`dead`，不得显示为已送达。
5. CRM 使用测试任务执行一次签名 multipart 建单，再用相同指纹重放；首次应成功，重放应返回同一 `projectId` 且 `duplicated=true`。

服务启动后至少检查：

```bash
# 未带 JWT 访问受保护端点应返回 401；同时证明 API 已监听并经过全局守卫。
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:3000/api/auth/me
pm2 logs legalos-api --lines 100 --nostream
```

## 八、可选种子账号（仅首次初始化）

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | 显式配置的 `SEED_ADMIN_PASSWORD` | 管理员（赵俊芳） |
| `business` | 显式配置的 `SEED_BUSINESS_PASSWORD` | 业务（田强） |

未配置密码时不会创建本地账号，但合同模板等业务种子仍会继续执行。seed 永不修改已存在账号的密码、角色或资料。法务 BP、法务负责人统一使用 CAS 身份，不再提供本地密码账号。部署后通过成员管理预开通，或由员工首次 CAS 登录创建。

## 九、钉钉集成上线检查清单

1. 钉钉后台：应用已授权「**通讯录部门成员读权限**」+ 可选「企业员工手机号信息」
2. 钉钉后台：应用**可见范围**含全员或目标用户（否则建群报"群主不在应用可见性内"）
3. `.env`：`DINGTALK_MOCK=false` + 4 项凭证正确
4. 管理端（admin 登录）→ 成员管理 → **一键同步** → 确认员工按姓名自动绑定

## 十、疑难排查

| 症状 | 原因 | 处理 |
|------|------|------|
| 启动报缺表 | 未跑 `migrate deploy` | `npx prisma migrate deploy` |
| 登录"服务响应异常" | API 进程未启动 | 检查 `:3000` 监听 + 启动日志 |
| dsh AI 回复失败 | 模型凭证、余额或网关配置异常 | `npm run dsh:model-gate`；检查 `DSH_LLM_*`（独立模型）或 `LLM_*`（公司网关） |
| 合同导出无模板 | storage 未复制 | 见"四、合同模板源文件" |
| A1 启动失败 | AppId/Secret/IP 白名单缺失或 Secret 少于 32 字节 | 对照 `.env.example` 和“七、CRM A1 上线检查” |
| A1 返回 `FORBIDDEN_APP` | socket 源 IP 不在白名单，或 AppId 不匹配 | 核对反向代理拓扑与 CRM 出口 IP，不要伪造转发头 |
| 合同文件在另一实例找不到 | `CONTRACT_STORAGE_DIR` 未使用共享持久卷 | 统一挂载路径并校验 API 用户权限 |
| 钉钉同步"部门不在授权范围" | 通讯录权限未批 | 见"九、钉钉集成上线检查清单" |
| 钉钉建群"群主不在可见性内" | 应用可见范围未含群主 | 同上 |

## 十一、百鉴 MCP / dsh Agent PR0 技术闸门

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
install -d -m 0700 /home/zhenghe.bao/LegalOS/LegalOS/api/.data/dsh
```

```bash
cd api

# 1. 官方 MCP TypeScript SDK：initialize + tools/list + 真实查询
npm run baijian:verify -- health
npm run baijian:verify -- law '劳动合同'
npm run baijian:verify -- law-advanced '劳动合同'
npm run baijian:verify -- law-semantic '违法解除劳动合同如何计算赔偿金'
npm run baijian:verify -- case '劳动合同违法解除经济补偿的中国类似案例'

# 2. 嵌入式 dsh Agent：自主规划 query + 受控法规检索与详情读取
npm run dsh:model-gate
npm run dsh:baijian-gate -- law '劳动合同解除经济补偿'
npm run dsh:baijian-gate -- case '劳动合同违法解除经济补偿的中国类似案例'
```

PR-B 的 AI 搜法会同时开放关键词、高级、语义、单条法规详情和批量法规详情五个受控工具。单轮最多执行 2 次法规召回、读取 3 部权威正文，总供应商请求预算为 5 次。服务端只接受本轮候选 ID 对应的已核验详情，最终报告必须通过完整性闸门：结构完整、来源 ID 已核验、展示的法规直接引文可在已读取正文中逐字定位。模型输出不在终态校验前向前端流式透传；解析或证据校验失败时，服务端使用已核验正文生成安全降级报告。高级与语义检索同样经过 PR-A 缓存，不新增 Redis 或环境变量。

PR-A 部署必须执行 `20260824150000_add_legal_research_cache` migration，新增权威文档投影、精确请求快照和脱敏成本台账。当前单 API 实例使用进程内 single-flight，不依赖 Redis。同一精确请求在 TTL 内直接复用本地快照；只有显式「刷新权威数据」、缓存缺失或过期时才再调用百鉴。

PR1/PR2 部署还会执行 `20260820190000_add_consultation_research_trace` migration。它只给
`consultation_runs` 增加能力快照、dsh 会话 ID 和有界来源 trace；不依赖 Redis。法务独立检索接口为
`GET /api/legal-research/laws` 与 `GET /api/legal-research/cases`，受登录角色和应用内限流保护。

dsh 在进程内只为本次运行注册 `search_laws` 或 `search_similar_cases` 之一；工具内部复用官方 MCP TypeScript SDK 与 `BaijianResultNormalizer`，模型看不到供应商凭证。每轮事件、checkpoint 和压缩结果写入 `DSH_HOME`，请确保目录持久化且仅 API 运行用户可读写。法规搜法未产生成功检索结果，或者检索命中后未读取任何权威详情正文，会被运行闸门拦截；最终 JSON 结构无效会进入报告解析降级流程。

迁移期间 `codex:baijian-preflight` 与 `codex:baijian-gate` 仅保留作旧实现诊断，不再是新 dsh 路径的上线条件；因此 dsh 闸门不依赖 Codex CLI、`/etc/codex/requirements.toml` 或 Codex 的模型元数据。等上述两道 dsh Agent 闸门在真实服务器都通过后，再删除旧 Codex Agent 文件与部署配置。

dsh 的会话、checkpoint、token meter、工具结果裁剪和压缩都直接使用上游包，不复制其内部实现。版本由 `package-lock.json` 固定；升级时应在独立提交中统一更新整组 `@deepseek-ai/dsh-*` 包，重新运行 `npm run ci` 以及法规、类案两道真实闸门，禁止只升级其中一个核心包后直接上线。
