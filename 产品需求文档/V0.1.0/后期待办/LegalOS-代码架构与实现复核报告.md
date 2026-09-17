# LegalOS 代码架构与实现复核报告

> 初次复核日期：2026-08-07  
> P1 实施后复核日期：2026-08-09  
> P2 实施后复核日期：2026-08-09  
> P1 遗留继续改造日期：2026-08-10  
> 初次代码快照：`LegalOS/main@b143128`  
> P1 实施后复核快照：`LegalOS/main@3b87e76`  
> P2 实施后复核快照：`LegalOS/main@1661142`  
> P1 遗留继续改造基线：`LegalOS@75c1c65` + 当前工作区未提交改造  
> 复核方式：报告缺口逐项回溯、代码修改、针对性回归、Lint、类型检查、单元测试、前端测试、生产构建、Prisma 校验、集成测试发现规则检查
> 说明：本轮已修改 P1 相关业务代码、测试、CI 和报告；未修改 UI 业务功能。真实 MySQL、真实钉钉故障恢复和浏览器下载受当前环境限制，单独标注为未验证。
> 展示规则：已完全闭环的改造项从当前整改清单、对比表和详细章节移除；仅保留仍有实现、环境验收或治理缺口的项目。

## 1. 结论摘要

当前系统已形成可运行的 NestJS + Prisma + MySQL 后端和 Vue 3 前端，业务咨询、合同协作、技能库、成员管理及钉钉集成都有实际实现。在 P2 快照基础上，本轮验证 API 单元测试 147/147、前端测试 20/20、Lint、类型检查、Prisma 校验和生产构建均通过，较初次复核的 78 个 API 测试有明显提升。前端 Chromium 冒烟尚未完成：开发服务器可启动，但当前机器未安装 Playwright Chromium 可执行文件。

P1 改造已经实质改善 Codex 并发、合同生成幂等、上传落盘边界、钉钉任务可靠性、通讯录性能和技能审计。本轮已完成 Codex session 父目录回收、合同生成运行锁/版本竞争及真实 HTTP + 临时 MySQL 验证；上述已闭环项目均不再列入当前整改清单。当前仅保留 CI Runner/Chromium E2E 门禁和 P0 安全配置。

P2 五项均有代码或文档提交，但同样不能判定为整体完成。本轮结论为：P2-02 和 P2-04 的原始核心问题已解决但验收未完全收口；P2-01、P2-05 仍部分完成；P2-03 列出的代码缺口已收口，但浏览器级错误态/SSE 验收仍未完成。`ProjectService` 从约 727 行降至 646 行，只抽出查询、状态矩阵和认领代表用例；统一状态配置和错误态仍需继续扩大到更多业务动作；文档门禁虽然通过，但 README、部署文档和缺失的架构/权限/状态机/运维文档仍与任务书目标存在明显差距。

本轮前四项高优先级缺口已完成代码修正：

1. Outbox Worker 已改为单一 `while` + `pollOnce` + 间隔等待，成员变更已改为 Outbox。
2. Codex 非流式成功/异常/超时都会在 close/error 后清理，超时/取消统一 SIGTERM → 宽限期 → SIGKILL。
3. 通讯录 staging 完整校验后，正式 merge、软失效、自动绑定和批次完成已放入同一事务。
4. 集成测试改用独立 Vitest 配置；Playwright 依赖、配置、冒烟用例和阻断式 CI 脚本已补齐。

当前最优先的验证项：当前 P1-01 的 GitLab Runner/Chromium E2E，以及 P0 的 Codex OS 级隔离和生产配置 Fail Fast。

在进入更大范围试用或生产前，仍有 2 类未关闭的 P0 问题；原工单消息越权漏洞已通过对象级权限和服务端身份派生修复：

1. Codex 虽已使用环境白名单，但仍处理用户提供的咨询、合同与技能内容；在缺少可证明的 OS 级工具、文件和网络隔离时，仍存在提示词注入后读取工作区或受管配置可见文件的高风险边界。
2. 配置没有启动时强校验，种子脚本保留固定弱密码兜底；错误部署可能直接形成已知账号密码或无效安全配置。

综合判断：功能完成度较高，但安全边界、领域一致性与异步任务可靠性仍偏原型化。建议先完成 P0 加固，再扩展生产流量和外部系统对接。

## 2. 当前架构概览

```text
Vue 3 / Pinia / Vue Router
          │ REST + SSE
          ▼
NestJS Controller + Guards
          │
          ├─ AuthService
          ├─ ProjectService ── LLMRiskService ── Codex CLI 子进程
          ├─ ContractService ──────────────────── Codex CLI 子进程
          ├─ SkillService
          └─ MembersService ── DingTalk Adapter
          │
          ▼
Prisma Client ── MySQL
          │
          └─ 本地磁盘合同附件 / 合同模板
```

主要优点：

- 模块边界已按认证、工单、合同、技能、成员拆分。
- 全局认证、角色守卫和限流已经建立。
- Prisma Schema 对核心业务对象、关联和部分索引有明确建模。
- 关键状态变更中已使用部分条件更新与事务，说明代码已开始考虑并发竞争。
- 钉钉适配器具备递归部门同步、分页、去重、过滤、有限并发和重试测试。

主要结构性短板：

- P2 已抽出 `ProjectQueryService`、`ProjectStateMachine` 和 `ClaimProjectUseCase`，但 `ProjectService` 仍有 646 行，继续承担创建、更新、取消、转派、消息、AI、BP 匹配、钉钉和 CRM 编排。
- 合同流程绕开 `ProjectService.create()` 自行创建工单，导致权限、事件、指派、建群和幂等逻辑出现两套实现。
- `ProjectMessage.role/label` 被同时用于用户消息、合同正文、AI 答复和风险审查，缺少稳定的领域类型。
- 钉钉建群和成员变更已引入 Outbox、租约、重试和 dead 状态；CRM 回写等其他外部副作用仍依赖请求内调用或进程内回调，可靠性机制尚未完全统一。

## 3. 优先级定义

| 优先级 | 定义 | 建议时限 |
|---|---|---|
| P0 | 可导致秘密泄露、越权、身份伪造或生产安全配置失效 | 上线前，0–3 天 |
| P1 | 可导致数据错误、任务卡死、重复工单、资源耗尽或关键链路不可靠 | 1–2 个迭代 |
| P2 | 可维护性、性能体验、测试覆盖和文档问题 | 2–4 个迭代 |

## 4. P0：上线前必须处理

### P0-01 Codex 执行边界可泄露服务端秘密

置信度：10/10

证据：

- `api/src/common/services/codex.service.ts:99-123` 已改为显式环境白名单，不再把 API 进程的全部环境变量传给 Codex；但硬化模式仍允许认证 token、代理和 CA 路径进入子进程。
- `api/src/modules/project/project.service.ts:533-559` 将咨询文本直接拼入 Codex 提示词。
- `api/src/modules/contract/contract.service.ts:453-478` 将合同文本直接拼入审查提示词。
- `api/src/modules/contract/contract.service.ts:319-327` 会把上传 DOCX 提取文本写入消息，再进入审查链路。
- 合同起草提示还明确要求 Codex 使用文件读取工具读取模板（`contract.service.ts:446-449`），说明该执行器并非单纯文本模型调用。

影响：环境变量白名单降低了 `DATABASE_URL`、`JWT_SECRET` 和钉钉凭证被直接继承的风险，但恶意咨询、合同条款或技能提示词仍可能利用 Codex 工具读取其工作区、受管配置可见文件或访问允许的网络出口。仅修改 `HOME`、`cwd` 和环境白名单不构成操作系统级隔离。

建议：

- 首选将不可信内容送入无工具权限的模型 API；如果必须运行 Codex CLI，使用独立低权限 Worker、容器或沙箱。
- 继续收窄子进程环境和网络代理白名单；生产环境必须使用独立低权限 Worker、容器或受管沙箱，并验证工具、文件和网络均按拒绝优先生效。
- 禁止不可信任务使用 Shell、任意文件读取和网络工具；模板由服务端读取后作为受控上下文传入。
- 对模型输出使用结构化 Schema 校验，并限制输出大小、执行时间和网络出口。
- 增加“提示词注入读取环境变量/文件”的对抗性测试。

### P0-02 工单消息越权和身份伪造（核心漏洞已修复）

当前状态：**核心漏洞已修复，不再作为未关闭 P0 计数**。置信度：9/10。

改造前证据：

- `api/src/modules/project/project.controller.ts:89-98` 允许业务、法务 BP 和法务负责人调用消息接口。
- `api/src/modules/project/dto/create-project.dto.ts:44-54` 允许客户端提交 `user`、`assistant` 或 `legal` 角色。
- `api/src/modules/project/project.service.ts:345-358` 仅确认工单存在，未验证当前用户与工单的创建、归属或指派关系；`currentUserId` 没有用于授权，并直接保存客户端提供的角色。

当前实现：`ProjectService.createMessage()` 已调用 `ProjectAccessPolicy`，消息角色由服务端根据 actor 派生；客户端 DTO 不再接受 role。跨工单写入和伪造 assistant/legal 的主漏洞已经关闭。

剩余工作：鉴权检查后到消息插入之间仍有转派竞争窗口；缺真实 HTTP + MySQL 的 IDOR/伪造请求测试；消息模型仍建议增加 `authorId`、`messageType`、`source`。

### P0-03 生产配置未 Fail Fast，种子账号存在固定弱密码兜底

置信度：10/10

证据：

- `api/src/app.module.ts:14-17` 载入配置但没有环境变量 Schema 校验。
- `api/src/modules/auth/auth.module.ts:12-18` 直接读取 `JWT_SECRET`，没有最小长度或生产环境必填校验。
- `api/prisma/seed.ts:10-32` 在密码变量缺失时回退到 `admin123`、`legal123`、`biz123`。
- `api/.env.example:15-19` 同样展示这些固定密码，容易被直接复制到部署环境。

影响：部署遗漏变量时可能使用公开已知密码，或以无效/弱 JWT 密钥启动。法律业务系统一旦外网或办公网可达，风险不可接受。

建议：使用 Joi/Zod 等配置 Schema 在启动时校验生产必填项、密钥长度和禁止值；生产 Seed 缺少密码时直接失败；初始密码随机生成并要求首次登录修改；将 Seed 操作与常规部署分离。

## 5. P1：实施后代码复核

### 5.1 完成度总表

| 项目 | 当前判定 | 已实现的核心提升 | 仍需处理 |
|---|---|---|---|
| P1-01 CI/测试 | 本地门禁通过，Runner/E2E 未闭环 | 临时 MySQL 集成测试 2 文件/9 用例全通过，文档校验通过；Playwright 已接入阻断式 CI | GitLab Runner 首次流水线和真实 Chromium Playwright E2E 仍需执行 |

### P1-01 CI 与关键测试

状态：**本地临时 MySQL 和文档门禁通过，Runner/Chromium 未闭环**。置信度：9/10。

改造前：无 GitLab CI；根脚本没有统一 lint、typecheck、integration、E2E 和 audit。

改造后：

- `.gitlab-ci.yml` 已包含 Prisma、Lint、类型检查、API 单测、MySQL、API/Web 构建、E2E 和依赖审计阶段。
- 本轮实测 API 单元测试 17 个文件、147/147；前端单测 8/8，Lint、类型检查、Prisma validate/format 和生产构建均通过。
- 增加 2 个 MySQL 集成测试文件，共定义 9 个事务/唯一约束/行为用例。
- `api/vitest.integration.config.ts` 已固定 include，临时 MySQL 实际执行 2 个文件/9 个用例并全部通过；Web 已加入 Playwright 依赖、配置和登录冒烟用例，CI 改为安装 Chromium 后执行且不再 `allow_failure`。

实际提升：代码质量和构建回归已从人工命令提升为可配置 CI；测试数量和覆盖面较初次复核明显增加。

当前验证缺口：GitLab Runner 尚未完成首次真实流水线；Chromium Playwright 冒烟脚本仍未启动。CI 配置已从“静默跳过”改为失败阻断，需在 Runner 上完成首次真实执行。

## 6. P2：实施后代码复核

### 6.1 完成度总表

| 项目 | 当前判定 | 已实现的核心提升 | 仍需处理 |
|---|---|---|---|
| P2-01 ProjectService 拆分 | 部分完成 | 抽出查询服务、状态矩阵和认领代表用例；Service 从约 727 行降至 646 行 | 其余命令/消息/AI/外部编排未拆；Controller 仍有 `as any` 和无界分页；状态机不是事件驱动且只接入 PATCH |
| P2-02 统一状态配置 | 核心问题已修，接入未完成 | 五种状态有类型完备配置；“待处理”已进入业务端处理中统计和筛选 | 其他页面未使用配置；CSS、按钮动作和状态展示仍散落硬编码 |
| P2-03 错误态与请求 ID | 代码改造完成，浏览器验收待补 | 普通 JSON、FormData、SSE 共用 API 错误层；安全 GET 单飞刷新、POST 不重放、200 非 JSON、超时、请求 ID、脱敏日志和目标页面错误态已覆盖 | Chromium 浏览器冒烟/真实断流交互尚未执行；需补组件/E2E 断言验证页面展示与复制请求 ID |
| P2-04 DOCX 懒加载 | 核心问题已修，门禁未完成 | DOCX 转换改为点击后动态导入；类型解耦；双击保护和失败重试可见 | 未实现包体预算门禁和组件测试；当前仍有 689.59 kB 的 DownloadMenu 块警告 |
| P2-05 文档一致性 | 部分完成 | 删除固定种子密码、假 Swagger 和主要错误目录；新增 CI 文档检查 | README 仍把已完成模块/测试列为下一步；DEPLOY 仍硬编码 migration 数；缺 4 份要求的专项文档；检查规则未覆盖这些陈旧内容 |

### P2-01 拆分 ProjectService 与状态机

状态：**部分完成，仅达到渐进拆分前三步**。置信度：10/10。

改造前：`ProjectService` 约 727 行，查询、命令、权限、状态、AI、BP 匹配、钉钉和 CRM 编排集中在一个类中；PATCH 可直接设置任意状态。

改造后：

- `project-query.service.ts:25-87` 接管列表、详情、权限范围和响应脱敏。
- `project-state-machine.ts:14-25` 定义五种状态的目标状态矩阵，PATCH 非法迁移返回 409；5 个矩阵测试通过。
- `claim-project.use-case.ts:17-46` 抽出认领代表用例；`ProjectService` 从约 727 行降至 646 行。

实际提升：查询职责已经形成独立边界，终态经 PATCH 重开被阻止，认领流程具备独立用例入口；重构后 API 单测、类型检查和构建均通过。

剩余问题：

- `[P2] (confidence: 10/10) project.service.ts` — 仍有 646 行，create/update/cancel/transfer/createMessage/reply/AI/BP/钉钉/CRM 均留在原类，远未达到任务书中“移除或不超过约 150 行纯 façade”的验收标准。
- `[P2] (confidence: 10/10) project.controller.ts:44-54,64-73` — `status/kind` 仍以 `as any` 传入，page/size 没有 DTO 枚举、正整数和最大值校验；`size` 可被提交为异常值或超大值，与 Query 拆分验收要求相反。
- `[P2] (confidence: 10/10) project-state-machine.ts:14-25, project.service.ts:193-206` — 状态机按目标状态而非业务事件建模，只在通用 PATCH 中调用；取消、追问升级、正式回传、AI 成功/失败仍直接赋值，不能称为“唯一后端状态机”，也没有统一校验 status/route/risk/owner 的联动。
- `[P2] (confidence: 9/10) claim-project.use-case.ts:22-37` — 认领更新和事件插入不在同一事务；事件失败时工单已经被认领但没有审计事件，不满足用例本地写入原子性要求。
- 新增测试只覆盖状态迁移矩阵，没有覆盖 Query 参数边界、认领事务失败、公开 API 兼容和其余命令迁移。

### P2-02 统一前端工单状态配置

状态：**原始统计缺陷已修复，唯一配置接入未完成**。置信度：10/10。

改造前：业务记录页手写状态统计，“处理中”遗漏 AI 失败后的 `待处理`。

改造后：`project-status.ts:19-49` 以 `satisfies Record<ProjectStatus, ProjectStatusMeta>` 定义五种状态的 label/group/tone/terminal/actions；`RecordsView.vue:247-273` 从配置派生处理中筛选和计数；4 个状态配置测试通过。

实际提升：`分析中`、`待处理`、`待复核` 现在都会进入“处理中”，原始用户可见缺陷已修复；新增后端状态而遗漏配置时可由 TypeScript 发现。

剩余问题：

- 全仓只有 `RecordsView.vue` 使用该配置，`ProjectsView.vue:274-293` 仍维护手写分组和 tabs，详情页等仍直接拼接中文状态 CSS class。
- `RecordsView.vue:203` 自身也继续使用 `'status-' + r.status`，没有使用已实现的稳定 `statusClass()`；配置中的 label、tone、terminal 和 actions 尚未真正成为页面唯一来源。
- 未覆盖不同角色下动作按钮可见性，也没有组件级测试证明新增状态会在所有页面正确呈现。

### P2-03 统一错误状态、重试和请求追踪

状态：**代码改造完成，浏览器级验收待补**。置信度：9/10。

改造前：页面大量空 `catch {}`，列表失败会被显示成空数据，前后端没有稳定请求 ID。

改造后：

- `request-id.interceptor.ts:12-24` 生成或校验透传请求 ID，并写响应头；`http-exception.filter.ts:20-56` 将同一 ID 写入错误体和服务端错误日志。
- `web/src/api/client.ts` 统一普通 JSON/FormData 请求：超时、网络错误、200 非 JSON、403/404/429、请求 ID 和 `RequestError` 均进入同一错误路径；只有 GET/HEAD/OPTIONS 允许 401 单飞刷新，POST 等副作用请求不自动重放。
- `web/src/api/sse.ts` 统一 SSE：校验 event-stream、响应 request ID、坏 JSON 事件、无 terminal 事件的意外断流；Consult、Contract、RecordDetail、ProjectDetail 的流式/写操作均已迁移。
- `useRemoteData.ts`、`ErrorState.vue` 已接入 Records、法务 Projects、Consult、Contract、RecordDetail、ProjectDetail、Members、Skills 等目标页面；新增 `logger.ts` 只输出元数据并对 token/body 等字段脱敏。
- 4 个后端请求 ID 测试与 20 个前端测试通过，覆盖 403/404/429、200 非 JSON、超时、401 单飞刷新、POST 不重放、SSE 坏事件和异常断流。

实际提升：业务记录和法务工单列表不再把服务故障伪装成“暂无记录”；普通请求、文件上传、SSE 流和写操作均能保留 request ID 并显示可重试错误。过期会话只对安全读请求单飞刷新，写请求不会被隐式重放；后端未知异常不向用户返回内部细节，前端日志不会输出 token、body 或响应 payload。

剩余问题：

- `[P2] (confidence: 10/10) web/src/api/sse.ts` — 代码已要求 SSE 必须收到 `done` 或 `error` terminal 事件；仍需在真实 Chromium/浏览器断网或服务端主动断流场景验证页面能稳定显示错误态、保留 request ID 且不会遗留“正在生成”。
- `[P2] (confidence: 9/10) web/src/components/ErrorState.vue` — 组件已覆盖目标页面，但目前只有 composable/API 单元测试，没有组件级断言验证 403/429、复制 request ID、重试后 loading→success 的真实渲染状态。
- `[P2] (confidence: 8/10) web` — 当前 Chromium 可执行文件未安装，E2E 冒烟未能执行；安装浏览器后应补真实 API 失败、SSE 坏事件和连接断开验收。

### P2-04 DOCX 点击加载和包体

状态：**核心懒加载完成，包体与自动化验收未收口**。置信度：10/10。

改造前：DOCX/marked 转换依赖与下载组件进入同一约 1,137.53 kB JavaScript 块。

改造后：`DownloadMenu.vue:25-42` 仅在点击 Word 后动态 import 转换器，类型移至轻量 `contract-export.ts`；转换期间禁用按钮、阻止双击，失败时保留下拉菜单和重试提示。

实际提升：本轮构建将 DOCX 转换实现拆成独立 `markdown-to-docx` 446.66 kB 块，原 DownloadMenu 相关 JavaScript 块降至 689.59 kB，较 1,137.53 kB 约减少 39.4%；未点击 Word 时不再由静态 import 直接执行 DOCX 转换模块。两块合计约 1,136.25 kB，说明收益来自延迟加载而不是依赖总代码量下降。

剩余问题：

- 构建仍对 689.59 kB 的 DownloadMenu 块发出超过 500 kB 警告，任务书要求的关键块目标尚未达到。
- 未增加 `check-bundle-budget`、Vite manifest 检查或 CI 强制阈值，因此后续可无提示地把 DOCX 依赖重新带回初始依赖图。
- 没有组件/浏览器测试验证“打开菜单不加载、点击只加载一次、失败重试、Markdown 不触发 DOCX、生成文件可打开”。组件卸载期间的异步完成也未做状态保护。

### P2-05 README、部署与架构文档

状态：**部分完成，门禁存在但覆盖面明显不足**。置信度：10/10。

改造后已删除 README 固定弱密码和假 Swagger 地址，修正主要目录名与 Codex 受管配置说明；`scripts/check-doc-links.mjs` 被接入 GitLab validate 阶段，本轮执行返回“2 个文件通过”。

实际提升：最危险的可复制弱密码和明显错误启动路径已从主文档移除；基础相对链接和少量陈旧文本现在可阻断 CI。

剩余问题：

- `[P2] (confidence: 10/10) README.md:3-21,98-103` — 版本/架构仍只描述早期认证骨架，并继续把工单模块和自动化测试列为“下一步”，与当前实现直接矛盾。
- `[P2] (confidence: 10/10) DEPLOY.md:69` — 仍写“7 个 migration”；检查脚本只匹配字面值 `7 个 migration`，没有识别当前中文句式，因此门禁绿色但内容仍陈旧。
- 任务书要求的 `docs/ARCHITECTURE.md`、`PERMISSIONS.md`、`PROJECT-STATE-MACHINE.md`、`OPERATIONS.md` 均未创建；检查脚本在 docs 目录不存在时直接跳过，所以“2 个文件通过”不能代表文档体系完成。
- README 仍主要使用 `npm install/setup`，没有完整列出现有模块、根质量脚本、Outbox、Codex 安全边界和生产运维入口；DEPLOY 也缺健康检查、进程管理、回滚及文件备份恢复清单。

## 7. P1/P2 调优前后实际效果与剩余差距

| 维度 | 调优前 | 当前实际提升 | 尚未达到的目标 / 验证缺口 |
|---|---|---|---|
| 消息身份可信度 | 客户端可声明 `assistant/legal` | DTO 已删除角色输入，服务端按 actor 派生消息角色 | 需以伪造请求 E2E 验证所有入口，补充稳定的 `authorId/messageType/source` 领域字段 |
| P1-01 交付门禁 | 主要依赖本地人工构建和测试 | Lint、类型检查、构建、Prisma、API 单测和前端测试均通过；临时 MySQL integration 2 文件/9 用例全通过，文档门禁通过 | GitLab Runner 首次执行和真实 Chromium E2E 仍待验收 |
| Project 模块职责 | 约 727 行 Service 集中查询与全部业务编排 | 查询、状态矩阵和认领用例已抽出，Service 降至 646 行 | 大部分命令/AI/外部编排仍未拆，状态机未成为唯一入口，分页 DTO 未收口 |
| 前端状态一致性 | “处理中”遗漏 `待处理`，页面各自判断 | 业务记录页统计/筛选已从类型完备配置派生 | 其他页面和 CSS/动作仍硬编码，尚非唯一配置源 |
| 前端错误体验 | 主数据失败常被显示为空数据，无请求 ID；SSE/raw fetch 各自处理 | 普通请求、上传、SSE 统一错误层；目标页面有错误态、request ID、重试；20 个前端边界测试通过 | Chromium/组件级真实渲染与断流验收待补，安装 Playwright 浏览器后执行 |
| DOCX 加载 | 下载相关块约 1,137.53 kB | 转换器拆为点击后 446.66 kB 动态块，DownloadMenu 相关块降至 689.59 kB，约下降 39.4% | 两块总量几乎未降且前者仍超 500 kB；没有 bundle budget 和浏览器验收门禁 |
| 文档一致性 | 固定弱密码、假 Swagger、错误目录和过时功能描述 | 删除最危险错误并增加基础 CI 文档检查 | 门禁只检查 2 个文件且漏检现存陈旧内容；架构/权限/状态机/运维文档未建立 |

## 8. 建议实施路线

### 阶段 A：安全止血（P0，0–3 天）

1. 暂停让不可信内容直接驱动具备工具权限的 Codex；先落地环境变量白名单和低权限运行账户。
2. 对已完成的消息对象授权和服务端角色派生补真实 HTTP + MySQL 越权回归，并收口转派竞争窗口。
3. 增加生产配置 Schema，移除 Seed 固定密码兜底。
4. 明确并固化工单权限矩阵。

验收标准：注入文本无法读取任何服务秘密；跨工单写入全部返回 403/404；生产缺少关键配置时进程拒绝启动。

### 阶段 B：一致性与可靠性（P1，1–2 个迭代）

已完成主要骨架：`ProjectAccessPolicy`、Codex 有界队列、创建事务与幂等键、合同生成运行锁/版本记录、Outbox/租约、合同文档与审查运行、绑定唯一性及基础 CI。

本轮已完成上述主要代码改造，并对可执行项进行了临时 MySQL、真实 HTTP 和故障注入验证：

1. Outbox Worker 已完成单循环、启动/停止、租约回收、写回失败保留 pending 和成员 Outbox 重试验证。
2. Codex 流式/非流式统一超时与取消回收；真实故障注入确认 SIGTERM 后最终 SIGKILL，执行目录和空 session 父目录均回收。
3. 合同生成已增加独立运行记录；真实 HTTP 并发确认同一请求只启动 1 条合同流，处理中/已完成状态复用，不同要素并发生成版本 1/2。
4. 通讯录事务回滚、上传 staging 授权时序、批量基准、统一法务升级和技能审计均已完成真实临时 MySQL 验证，不再列为当前项。
5. 当前仅剩 CI Runner 首次真实执行和 Chromium E2E；本地临时 MySQL 2 文件/9 用例、单元/构建门禁和文档校验已通过。

下一轮优先收口：P1-01 Runner/Chromium，然后处理 P0 OS 级隔离和生产配置 Fail Fast。

验收标准：P1-01 在 GitLab Runner 中实际执行，真实 MySQL 集成测试和 E2E 均失败阻断合并；P0 安全边界具备可复现的拒绝优先证据。

### 阶段 C：架构与体验（P2，2–4 个迭代）

已完成第一轮骨架：Query/状态矩阵/认领用例、前端状态配置、统一请求/SSE 错误层、DOCX 动态导入、基础文档门禁。

下一轮应继续：

1. 将 update/cancel/transfer/message/reply/AI 编排继续拆为用例，并把状态迁移改为业务事件驱动的唯一入口。
2. 为列表参数建立 DTO 与最大分页限制，移除 Controller `as any`，补 Query/API 特征测试。
3. 将状态配置继续接入法务列表、详情、咨询、合同、成员等页面，统一 SSE 和写操作错误策略；P2-03 本轮代码已完成，下一步转为浏览器验收。
4. 安装 Chromium 后补组件/E2E 错误态、复制 request ID、401 刷新与 SSE 断流测试。
5. 增加 bundle budget 强门禁并继续压缩 689.59 kB 块；补 DOCX 浏览器测试。
6. 重写 README/DEPLOY 的陈旧段落，补齐架构、权限、状态机和运维文档，并扩展文档断言。

## 9. 测试与验证结果

| 检查项 | 结果 | 备注 |
|---|---|---|
| `npm run lint` | 通过 | API 与 Web 分别执行 lint 成功；当前仓库根目录没有统一 lint 脚本 |
| `npm run typecheck` | 通过 | API 与 Web 分别执行类型检查成功 |
| `npm run build` | 通过 | API 与 Web 分别构建成功；当前 `DownloadMenu` 块 689.59 kB、动态 DOCX 块 446.66 kB，前者仍超过 Vite 500 kB 建议值 |
| `npm --prefix api run test:unit` | 通过 | 17 个测试文件，147/147 测试通过 |
| `npm --prefix web run test` | 通过 | 4 个测试文件，20/20 测试通过；包含 API client、SSE、远程数据状态和状态配置 |
| `npx prisma validate` / `format --check` | 通过 | Schema 有效；Prisma 提示 package.json 配置方式后续将弃用 |
| `prisma migrate deploy` | 通过 | 在临时 MySQL 空库从零应用 12 个 migration，包含合同生成运行表，完成后已清理临时库 |
| `npm --prefix api run test:integration` | 真实通过 | 临时 MySQL 执行 2 个文件、9/9 个用例通过；测试库在验证结束后清理 |
| P1 临时 MySQL/真实 HTTP/故障注入 | 通过 | 已实测 Codex SIGKILL/队列槽位/父目录回收、普通咨询并发幂等、合同同请求单流、处理中/已完成复用、不同要素版本 1/2、Outbox lease/写回失败/成员重试、通讯录与技能事务回滚、法务升级并发及上传授权时序 |
| `npm --prefix web run test:e2e` | 未完成 | WebServer 已在授权环境启动；Playwright 报 Chromium 可执行文件不存在，尚未执行登录冒烟断言 |
| `node scripts/check-doc-links.mjs` | 通过但覆盖不足 | README、DEPLOY 两个文件校验通过；docs 专项文档不存在，规则仍未覆盖陈旧内容 |
| `git diff --check` | 通过 | 当前工作区差异未发现空白错误 |
| CI 配置 | 已补齐，待 Runner 首次执行 | integration 使用独立配置；E2E 安装 Chromium 后执行且不再 `allow_failure`；本轮未在 GitLab Runner 上执行 |
| 真实钉钉建群与消息验证 | 未执行 | 会产生外部群和消息，本轮只读复核未获授权执行 |
| 生产压测与外部系统验证 | 部分执行 | 通讯录 1500/5000 人临时 MySQL 基准和多项本地故障注入已完成；真实钉钉、GitLab Runner、Chromium E2E、生产压测仍未执行 |

## 10. P1/P2 完成度结论与交付建议

- 当前 P1 仅保留重新编号后的 P1-01（CI Runner/Chromium E2E）；Codex 父目录回收、合同生成流幂等/版本竞争、Outbox 恢复、上传时序、通讯录性能、法务升级和技能审计均已从当前整改清单移除。
- P1-01 尚不能关闭：GitLab Runner 首次流水线和 Chromium E2E 仍无真实执行证据。
- 下一步应以 `LegalOS-P1改造遗留-待办清单.md` 为验收入口，逐项补充真实环境命令、测试输出和失败恢复证据；已完全闭环的条目不再重复执行。
- P2-02、P2-04 可关闭原始核心缺陷，但应保留“全页面状态接入”和“包体门禁/浏览器测试”余项；P2-03 的本轮代码缺口已关闭，但不应在 Chromium/组件级验收完成前宣称整体交付完成；P2-01、P2-05 仍未完成。
- 交付给后续代码执行 Agent 时，应要求每项同时提交：实现代码、针对本报告缺陷的回归测试、可复现命令及测试输出；不得仅以单元测试总数或 CI 配置文件存在作为完成证据。

## 11. 建议优先跟踪的指标

- 安全：越权拦截次数、AI 注入测试通过率、Worker 敏感变量暴露数。
- AI：活跃/排队任务数、P95 排队时间、超时率、异常退出率、单任务成本。
- 工单：幂等冲突数、半成品工单数、状态停留时长、待处理超时数。
- 钉钉：建群成功率、重试次数、租约过期回收数、通知失败率。
- 合同：审查源文档版本正确率、复审失败率、孤儿文件数。
- 通讯录：同步总量、完整性校验、自动绑定/歧义数、批处理耗时。
- 前端：关键路由资源体积、首屏加载时间、接口错误展示率。

## 12. 总体建议

本项目目前不需要立即进行“大规模重写”。本轮已通过统一 Policy、应用用例、Outbox、队列、生成运行记录、状态模型和前端错误层完成关键一致性验证；下一步只需完成当前 P1-01 的 GitLab Runner/Chromium E2E 门禁，并补 P2-03 的浏览器级错误态/SSE 断流验收。P0 的 OS 级 Codex 隔离和生产配置 Fail Fast 仍应优先于扩大流量，随后再继续 ProjectService 用例拆分和文档完整性。这样能保持现有功能和页面行为不变，同时把已投入的改造转化为可验证、可运维的生产能力。
