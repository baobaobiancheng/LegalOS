# LegalOS P2-01 至 P2-05 代码改造执行任务书

> 用途：交给 Claude Code 直接执行代码修改。  
> 编写日期：2026-08-09。  
> 原始依据：`LegalOS-代码架构与实现复核报告.md` 的 P2-01 至 P2-05。  
> 已提交代码基线：`LegalOS/main@347a13b`。原复核报告基于更早版本，执行时必须以最新代码为准。  
> 重要说明：本任务书只定义改造范围和验收标准，不代表 P1 遗留已经完成，也不授权部署、推送或修改生产数据。

## 1. 执行目标

本任务覆盖以下五项改造：

1. P2-01：渐进拆分 `ProjectService`，建立清晰的查询、命令、消息、AI 编排、法务升级和外部集成边界。
2. P2-02：建立前端唯一工单状态配置，修复“处理中”遗漏 `待处理`，统一状态标签、分组、样式和动作判断。
3. P2-03：建立可区分加载、空数据和失败的前端错误体系，支持安全重试、请求追踪 ID 和脱敏日志。
4. P2-04：将 DOCX 生成依赖改为点击后加载，降低首屏和关键路由 JavaScript 体积。
5. P2-05：更新 README、部署、架构、权限和状态机文档，并在 CI 中校验本地文档链接。

完成后应达到以下结果：

- `ProjectController` 只处理 HTTP/SSE 协议适配，不承载权限、事务、状态迁移或外部系统编排。
- `ProjectService` 不再是 700 行以上的多职责类；每个应用用例只负责一个明确业务动作。
- 所有前端页面对五种 `ProjectStatus` 都有穷尽处理，`待处理` 出现在“处理中”的统计和筛选中。
- 请求失败不会再伪装成空列表；用户可看到可操作的错误信息、重试入口和请求 ID。
- 首屏和进入咨询/记录页面时不下载 `docx`、`marked` 和 DOCX 转换模块；仅点击 Word 下载后加载。
- README 和部署说明与当前实现一致，不再包含固定弱密码、错误目录、固定 migration/测试数量或不存在的 Swagger 地址。

## 2. 开始前的硬性前置条件

### 2.1 禁止在同一工作区并发修改

编写本文时，`LegalOS` 工作树存在其他任务留下或正在修改的文件，包括但不限于：

```text
api/src/modules/skill/skill.service.ts
api/test/behavior.integration.spec.ts
web/eslint.config.mjs
web/package.json
web/package-lock.json
web/src/components/DownloadMenu.vue
web/src/views/business/RecordsView.vue
web/src/views/legal/ProjectDetailView.vue
```

开始执行前必须运行：

```bash
cd LegalOS
git status --short
git diff --stat
git log -5 --oneline
```

若另一个 Agent 仍在修改当前工作树，必须停止并选择下列方式之一：

- 等待其完成、测试并提交后，再从新提交开始 P2；
- 基于包含全部已确认 P1 成果的提交创建独立 branch/worktree。

禁止覆盖、回退、格式化或顺手修改来源不明的未提交内容。特别是 `DownloadMenu.vue`、`RecordsView.vue` 和 `ProjectService`，执行前必须先确认当前 diff 的所有权。

### 2.2 先处置 P1 遗留，不得用 P2 掩盖

开始前阅读：

```text
产品需求文档/V0.1.0/后期待办/LegalOS-P1改造遗留-待办清单.md
```

至少确认：

- P1-06 上传安全被明确跳过，本任务不得把它伪装成已完成。
- 成员变更尚未全部进入 Outbox。
- 咨询升级尚未全部接入统一 `EscalateProjectToLegalUseCase`。
- MySQL 集成测试、Playwright E2E 和 CI 门禁仍可能不完整。
- P2 代码必须复用现有 `ProjectAccessPolicy`、`CreateProjectUseCase`、`EscalateProjectToLegalUseCase` 和 Outbox，不得建立第二套机制。

如果 P1 遗留正在由另一个任务处理，P2 只能基于该任务完成后的提交开始。P2-01 可以为 P1 遗留提供更清晰的接入点，但不得扩大为“顺便完成全部 P1”。

### 2.3 建立可比较基线

在改代码前记录以下结果，失败也必须如实保存：

```bash
cd LegalOS
npm ci
npm --prefix api ci
npm --prefix web ci

npm run lint
npm run typecheck
npm --prefix api run test:unit
npm --prefix api run test:integration
npm --prefix web run test
npm run build
```

同时记录：

- `api/src/modules/project/project.service.ts` 行数和职责清单。
- `web/dist/assets` 的文件名、原始大小和 gzip 大小。
- 打开登录页、咨询页、我的记录页时实际加载的 JavaScript 请求。
- 点击 Word 下载前后新增的网络请求。
- 当前失败测试、Lint、E2E 占位或环境依赖。

不得通过删除测试、降低阈值、增加 `allow_failure`、`|| true` 或吞掉异常制造“绿色基线”。

## 3. 当前实现复核

| 项目 | 当前状态 | 代码证据 | 本次处理 |
|---|---|---|---|
| P2-01 Service 拆分 | 未完成 | `project.service.ts` 约 727 行，同时负责查询、写入、权限、AI、风险升级、BP 匹配、钉钉和事件 | 渐进拆分，保留协议兼容 |
| P2-02 状态处理 | 未完成 | `RecordsView.vue` 的“处理中”仅包含 `分析中`、`待复核`；计数初始化也遗漏 `待处理` | 建立唯一状态配置和穷尽测试 |
| P2-03 错误体验 | 未完成 | 多个页面存在空 `catch {}`；列表失败后显示“暂无记录” | 统一错误模型、错误态和安全重试 |
| P2-04 DOCX 包体 | 未完成 | `DownloadMenu.vue` 顶层静态导入 `markdown-to-docx`，后者静态导入 `docx` 和 `marked` | 点击后动态导入并增加包体门禁 |
| P2-05 文档一致性 | 未完成 | README 仍称工单/测试为后续，包含固定种子密码和不存在的 Swagger 地址；DEPLOY 有错误目录和固定数量 | 更新文档并增加相对链接校验 |

当前已有成果必须保留：

- `application/create-project.use-case.ts`。
- `application/escalate-project-to-legal.use-case.ts`。
- `domain/project-access.policy.ts` 和 `project-access.types.ts`。
- `infrastructure/outbox.repository.ts` 和 `outbox.worker.ts`。
- Codex 有界队列、硬化配置和子进程环境白名单。
- 合同文档版本、审核运行、风险审计和通讯录同步相关 P1 数据模型。

## 4. 总体实施原则与顺序

### 4.1 必须遵守

- 先写特征测试，再移动代码；拆分类和改变业务行为不得混在同一提交。
- 不删除或重命名现有 API 路由、DTO 字段和主要成功响应字段。
- 不改变现有权限矩阵，不绕过 `ProjectAccessPolicy`。
- 不把钉钉、CRM 或 Codex 外部调用放进数据库事务。
- 不新建平行的状态枚举、权限策略、Outbox 或法务升级流程。
- 不使用 `as any`、空 `catch {}` 或 `console.error` 作为新错误体系的最终实现。
- 不为本任务修改视觉设计；只增加错误态、加载态和下载状态所需的最小 UI。
- 不提交 `.env`、真实合同正文、密钥、数据库转储或含个人信息的日志。
- 本轮原则上不需要 Prisma Schema/migration。若实现过程中发现必须改 Schema，应暂停并单独说明原因、兼容和回滚方案。

### 4.2 推荐实施顺序

1. 固化基线和现有工单行为特征测试。
2. 完成 P2-01 后端职责拆分，但保持 API 行为不变。
3. 完成 P2-02 状态配置，先修正业务端统计，再替换其他页面散落判断。
4. 完成 P2-03 请求 ID、错误规范化、页面错误态和安全重试。
5. 完成 P2-04 DOCX 类型解耦、动态导入和包体门禁。
6. 完成 P2-05 文档更新和文档链接 CI 校验。
7. 执行完整测试、生产构建、浏览器冒烟和前后包体对比。

每项应形成独立、可回滚的提交。禁止一次性重写整个 `project` 模块或全量替换所有 Vue 页面。

## 5. P2-01：拆分 ProjectService，建立应用用例层

### 5.1 目标边界

采用渐进式拆分，不要求为了目录漂亮而引入过度抽象。推荐结构：

```text
api/src/modules/project/
  application/
    create-project.use-case.ts                 # 已有，复用
    update-project.use-case.ts
    claim-project.use-case.ts
    cancel-project.use-case.ts
    transfer-project.use-case.ts
    send-project-message.use-case.ts
    reply-project.use-case.ts
    generate-project-ai-response.use-case.ts
    escalate-project-to-legal.use-case.ts       # 已有，补齐接入但不复制
  queries/
    project-query.service.ts
  domain/
    project-access.policy.ts                    # 已有
    project-access.types.ts                     # 已有
    project-state-machine.ts
  services/
    legal-bp-matcher.service.ts
    project-event.service.ts
  infrastructure/
    outbox.repository.ts                        # 已有
    outbox.worker.ts                            # 已有
  project-application.service.ts                # 可选薄 façade
  project.controller.ts
  project.module.ts
```

目录名可按 NestJS 约定微调，但职责边界必须满足：

- Query 只负责读取、分页、范围过滤和响应投影，不执行外部副作用。
- Use case 负责一个业务动作的流程、权限、事务边界和领域调用。
- Domain 负责权限和状态迁移规则，不依赖 Nest Controller、HTTP、钉钉或 Codex。
- Infrastructure/Adapter 负责 Prisma、Outbox 和外部系统细节。
- Controller 只解析 DTO、当前用户、HTTP 状态和 SSE 连接生命周期。

### 5.2 先补特征测试

移动代码前，为当前公开行为补测试，至少覆盖：

- 创建工单的成功响应、幂等、AI 路由和法务路由。
- `GET /projects` 与 `GET /projects/mine` 的权限范围、分页和分组。
- 查看、更新、认领、取消、转派、发消息和正式回传。
- 业务用户、法务 BP、法务负责人、管理员的对象级权限。
- `分析中 → 已回传/待处理` 的 AI 成功和失败路径。
- 追问从 `llm` 升级到 `legalbp` 时的指派和 Outbox。
- 转派和回传后的事件、通知与 CRM 回写失败策略。
- SSE 断开后取消 Codex 任务，不泄漏队列槽位。

测试应断言可观察结果，不要断言私有方法名或内部调用顺序，以免重构测试阻碍拆分。

### 5.3 Query 拆分

将以下职责移入 `ProjectQueryService`：

- `findAll()`、`findOne()`。
- 服务端权限范围过滤。
- 分页参数和最大 page size 约束。
- Prisma include/select 与敏感字段脱敏。
- 当前 API 需要的列表分组投影。

要求：

1. `actor` 仍是强制参数，查询范围继续来自 `ProjectAccessPolicy.listScope()`。
2. Controller 中的 `status as any`、`kind as any` 必须替换为 DTO 校验和 Prisma 枚举类型。
3. 列表响应字段和现有 `groups` 键保持兼容；若计划废弃服务端分组，先新增版本化字段并保留旧字段，不得直接删除。
4. `extra`、技能 prompt、密码哈希等敏感字段不能进入响应。
5. page、size 对非法值返回 400；size 设置合理上限，防止无界查询。

### 5.4 命令和消息用例拆分

将 `update`、`claim`、`cancel`、`transfer`、`createMessage`、`reply` 分为独立用例。每个用例必须：

1. 接收显式 `ProjectActor`。
2. 调用统一 `ProjectAccessPolicy`。
3. 调用统一状态机验证目标迁移。
4. 对需要原子性的本地数据库写入使用事务或条件更新。
5. 将外部副作用写入 Outbox，或在事务提交后按明确失败策略执行。
6. 写入统一事件，禁止各用例自行拼接不同格式的时间文案。

不得把所有 use case 再注入一个新的 700 行 `ProjectApplicationService`。如果为了兼容 Controller 保留 façade，它只能委派调用，不得重新承载业务实现，目标不超过约 150 行。

### 5.5 建立 ProjectStateMachine

当前 `UpdateProjectDto` 允许调用方直接指定任意五种状态，缺少迁移约束。应建立唯一后端状态机，例如：

```ts
type ProjectTransition =
  | 'ai-completed'
  | 'ai-failed'
  | 'escalated-to-legal'
  | 'legal-replied'
  | 'cancelled'
  | 'reopened-by-authorized-operator'
```

状态机必须基于“业务事件”决定目标状态，而不是让 Controller 直接赋值。实施前根据现有行为和产品规则确认迁移矩阵，最低要求：

- `分析中`：可因 AI 成功进入 `已回传`，因 AI 失败进入 `待处理`，因风险升级进入 `待复核`，或按权限取消。
- `待处理`：可进入人工处理/`待复核`、完成回传或取消；具体动作必须由产品现有行为和特征测试确认。
- `待复核`：可正式回传或取消。
- `已回传`、`已取消`：默认终态，除非存在明确、受权限控制且有审计事件的重开用例。

要求：

- `assertCanTransition(from, event, actor)` 失败返回 409，而不是静默覆盖。
- 风险、route、owner、legalBp 和 status 的联动由用例统一处理。
- `PATCH /projects/:id` 保持兼容时，只允许映射到已定义业务事件；不允许绕过状态机。
- 后端状态机必须有完整矩阵单元测试。

### 5.6 AI、法务升级和外部系统编排

1. 将 `triggerAIResponse()` 和 prompt 构建移到 AI 用例/服务；保留 Codex 队列和 AbortSignal 行为。
2. AI 完成时的消息、结果、状态和事件应使用一个可测试的完成步骤；失败时统一进入 `待处理`，并记录脱敏错误。
3. 咨询首次创建、追问升级、route 更新和合同提交等升级入口最终必须复用已有 `EscalateProjectToLegalUseCase`。若该项仍属于正在执行的 P1-10 遗留，先协调基线，不得在两个分支分别实现。
4. 将 `matchLegalBp()` 提取为独立服务；没有可用 BP 时返回明确结果和可观察事件，不得静默伪造指派。
5. 钉钉建群继续使用现有 Outbox。成员新增是否进入 Outbox属于 P1 遗留，P2-01 只能复用最终方案，不得另建异步通道。
6. CRM/钉钉失败不得回滚已经成功的本地事务；必须有重试、告警或人工处理状态之一。

### 5.7 P2-01 验收

- 所有原有 Project API 的成功状态码、路由和主要响应字段保持兼容。
- `ProjectService` 被移除，或成为不超过约 150 行的纯委派 façade。
- Controller 不直接访问 Prisma、Codex、Outbox、钉钉或 CRM。
- 每个 use case 只负责一个业务动作；项目模块内不再有新的多职责超大类。
- 不再新增 `as any`，现有 Controller 查询参数中的 `as any` 已消除。
- 状态迁移、权限、事务和副作用边界均有测试。
- 单元、集成、构建、Lint 和 TypeScript 检查通过；若 MySQL/E2E 因 P1 遗留无法运行，必须明确报告，不能标记本项全部完成。

## 6. P2-02：统一前端工单状态配置

### 6.1 目标

`ProjectStatus` 只有一个前端业务配置源。页面不得各自维护状态数组、颜色、分组和动作条件。

建议新增：

```text
web/src/domain/project-status.ts
web/src/domain/project-status.spec.ts
```

示例类型：

```ts
export type ProjectStatusGroup = 'processing' | 'completed' | 'cancelled'
export type ProjectStatusAction = 'view' | 'cancel' | 'reply' | 'transfer'

export interface ProjectStatusMeta {
  label: string
  group: ProjectStatusGroup
  tone: 'info' | 'warning' | 'success' | 'neutral'
  terminal: boolean
  actions: readonly ProjectStatusAction[]
}

export const PROJECT_STATUS_META = {
  分析中: {
    label: '分析中', group: 'processing', tone: 'info', terminal: false,
    actions: ['view', 'cancel'],
  },
  待处理: {
    label: '待处理', group: 'processing', tone: 'warning', terminal: false,
    actions: ['view', 'cancel'],
  },
  待复核: {
    label: '待复核', group: 'processing', tone: 'warning', terminal: false,
    actions: ['view', 'cancel', 'reply', 'transfer'],
  },
  已回传: {
    label: '已回传', group: 'completed', tone: 'success', terminal: true,
    actions: ['view'],
  },
  已取消: {
    label: '已取消', group: 'cancelled', tone: 'neutral', terminal: true,
    actions: ['view'],
  },
} satisfies Record<ProjectStatus, ProjectStatusMeta>
```

### 6.2 实现要求

1. `processing` 分组必须至少包含 `分析中`、`待处理`、`待复核`。
2. `RecordsView.vue` 的过滤、统计卡片和空态全部从配置派生，不再手写状态相加。
3. `ProjectsView.vue`、`ProjectDetailView.vue`、`RecordDetailView.vue`、`ContractView.vue` 中散落的状态判断逐步改用统一 helper。
4. 状态动作不能只按状态判断，还必须结合用户角色、route 和服务端权限；前端隐藏按钮仅改善体验，不能替代后端鉴权。
5. CSS 使用稳定 tone/class，例如 `status-info`，避免业务中文值直接参与动态 class 造成遗漏。
6. 新增状态时，`satisfies Record<ProjectStatus, ...>` 必须让 TypeScript 在配置缺失时失败。
7. 需要分支判断时使用穷尽处理或 `assertNever()`，禁止带默认值静默吞掉新状态。
8. 后端 Prisma 枚举仍是协议事实来源；本任务不要求引入 OpenAPI 代码生成，但文档应记录前端类型需与后端同步。

### 6.3 必测场景

- 五种状态各有唯一 label、group、tone、terminal 和动作配置。
- `待处理` 在“处理中”筛选和计数中出现。
- `已回传`、`已取消` 不进入处理中。
- 空数组显示真正空态；网络失败显示错误态而不是空态。
- 增加一个模拟新状态或删除一项配置时，TypeScript/测试失败。
- legal_bp、legal_lead、admin、business 的按钮可见性与当前权限矩阵一致。

## 7. P2-03：统一前端错误状态、重试和请求追踪

### 7.1 错误模型

扩展统一错误响应和 `RequestError`，至少包含：

```ts
interface ApiError {
  error: string
  code: string
  statusCode: number
  requestId?: string
}
```

后端应增加轻量请求 ID 中间件或 interceptor：

- 每个请求由服务端生成不可预测的 request ID。
- 在响应头 `X-Request-ID` 和错误 JSON 中返回同一 ID。
- 日志以该 ID 关联请求，不记录 access token、cookie、合同正文、附件内容或完整用户输入。
- 不直接信任客户端传入的任意长 request ID；若允许透传，必须校验格式和长度，否则重新生成。

`web/src/api/client.ts` 应：

- 从响应头优先读取 request ID，并补充到 `RequestError`。
- 兼容非 JSON、204、网络中断和超时。
- 将用户可见消息与内部诊断信息分离。
- 保留 401 单飞刷新，但不把预期的会话恢复失败显示成全局系统故障。

### 7.2 页面异步状态

新增可复用的 `useAsyncState`/`useRemoteData` 和错误展示组件，统一表示：

```text
idle → loading → success(data)
               ↘ error(error, requestId, retry)
```

要求：

1. loading、error、empty、content 四种状态互斥。
2. GET/幂等读取允许用户重试。
3. POST、回复、取消、转派、上传等非幂等动作不得自动重放；只有在具备 idempotency key 或明确确认后才能重试。
4. 错误组件至少显示简明提示、重试按钮和可复制 request ID；不要向用户暴露堆栈、数据库信息或网关原文。
5. 表单类错误保留用户已输入内容，不因失败清空。
6. SSE 必须区分单条事件 JSON 格式异常、连接断开、服务端错误事件和正常结束。单条坏事件可跳过并记录，连接失败必须提供恢复入口。
7. 下载和上传失败必须有用户可见提示，不能只 `console.error`。

### 7.3 清理 catch 的规则

不得机械地把所有 `catch` 都改成弹窗。逐项分类：

- 列表/详情主数据失败：进入页面错误态。
- 用户触发的写操作失败：显示动作级错误，保留输入，允许安全重试。
- 可选辅助数据失败：保留主流程，但显示降级提示或记录诊断。
- 401 refresh、logout 清理等预期失败：允许安静降级，但代码中要有注释说明，不得隐藏非预期异常。
- SSE 单条 JSON 解析失败：记录 request/session 上下文，不中断其他合法事件。
- 本地预览或可选功能失败：显示功能级提示，不将整个页面伪装为失败。

优先治理：

```text
business/RecordsView.vue
business/RecordDetailView.vue
business/ConsultView.vue
business/ContractView.vue
legal/ProjectsView.vue
legal/ProjectDetailView.vue
admin/MembersView.vue
components/DownloadMenu.vue
```

### 7.4 可观察日志

- 提供统一前端日志 adapter；开发环境可输出 console，生产环境预留接入 Sentry/公司监控的接口，但本任务不强制引入新 SaaS。
- 日志字段采用 allowlist：`requestId`、route 名、错误 code、statusCode、动作名和时间。
- 禁止记录 authorization、cookie、密码、密钥、合同正文、咨询原文、附件内容和完整个人信息。
- 同一错误避免页面、client 和全局 handler 重复上报。

### 7.5 必测场景

- 500、403、404、429、非 JSON 响应、断网和超时均映射到稳定错误模型。
- 列表失败显示错误态，不显示“暂无记录”。
- 点击重试后恢复成功，旧错误清除。
- POST 超时不会被 client 自动重复提交。
- 401 并发请求仍只触发一次 refresh。
- request ID 同时出现在响应头、错误体、服务端日志上下文和前端错误详情。
- 日志快照不含 token、cookie、合同/咨询内容。

## 8. P2-04：DOCX 按点击加载和包体门禁

### 8.1 类型与运行时代码解耦

当前 `ContractDocStyle` 与重型转换实现放在同一模块。先将纯类型移到轻量文件：

```text
web/src/types/contract-export.ts
```

所有调用方使用 `import type` 引用类型。`DownloadMenu.vue` 顶层不得导入 `markdown-to-docx`。

Word 点击处理应采用运行时动态导入：

```ts
const { markdownToDocxBlob } = await import('../utils/markdown-to-docx')
```

该语句只能出现在用户点击 Word 下载后的执行路径。Markdown 下载继续保持轻量同步实现。

### 8.2 下载体验

1. 动态加载和转换期间禁用 Word 按钮并显示明确进度文案。
2. 防止双击触发两次 import/转换/下载。
3. 加载或转换失败时保留下拉菜单，显示可重试错误和 request/error ID（若有）。
4. 组件卸载时不再更新已销毁状态；Blob URL 必须在下载后释放。
5. DOCX 输出内容、文件名、中文字体、页边距、Logo 和现有模板样式保持兼容。
6. 不得通过预加载 DOCX chunk 抵消懒加载效果。

### 8.3 Vite 与门禁

- 动态 import 是必要条件；`manualChunks` 只可用于使 chunk 命名和缓存更稳定，不能替代动态 import。
- 若配置 `manualChunks`，不得把 `docx`/`marked` 放回首屏 vendor 依赖图。
- 增加 `scripts/check-bundle-budget.mjs` 或等效脚本，读取 Vite manifest/build 产物并检查：
  - 初始入口依赖图不包含 `docx`、`marked`、`markdown-to-docx`。
  - DOCX chunk 只作为动态依赖存在。
  - 关键首屏/路由 chunk 不超过报告建议的 500 kB 原始体积；若现有基线已超限，先记录并设置只会收紧、不会放宽的阶段阈值。
- CI 保存构建体积摘要；阈值失败必须使 job 失败，禁止仅打印 warning。

### 8.4 服务端导出的决策门槛

本轮默认只做浏览器动态加载。只有满足以下任一条件，才另立任务评估服务端异步导出：

- 懒加载后 DOCX chunk 在目标办公网络下载仍明显影响使用。
- 大合同转换导致浏览器长时间卡顿或内存异常。
- 需要统一模板、审计、水印、电子签章或可重复生成。

服务端导出会引入队列、文件存储、鉴权、过期清理和下载审计，不得在 P2-04 中未经评审直接扩大范围。

### 8.5 必测场景

- 首次加载登录、咨询、记录列表和记录详情时，不请求 DOCX chunk。
- 打开下载菜单但未点击 Word 时，不请求 DOCX chunk。
- 首次点击 Word 时只加载一次，随后成功下载可打开的 `.docx`。
- 连续双击只生成一个下载任务。
- 动态 chunk 加载失败时显示可重试错误。
- Markdown 下载不触发 DOCX 依赖。
- 生产构建体积报告和前后对比写入任务结果。

## 9. P2-05：更新 README、部署和架构文档

### 9.1 文档目标结构

保持 README 简洁，将详细内容拆到 `docs/`：

```text
README.md
DEPLOY.md
docs/
  ARCHITECTURE.md
  PERMISSIONS.md
  PROJECT-STATE-MACHINE.md
  OPERATIONS.md
```

若仓库已有等价文档，应更新现有文件，不得创建重复来源。

### 9.2 README 必须修正

- 当前已实现模块：认证、三端工作台、工单、合同、附件、技能、成员/通讯录、钉钉、CRM Adapter、Codex、Outbox 和审计。
- 当前真实目录结构、技术栈、Node/MySQL 支持版本和根脚本。
- 使用 `npm ci`/各 workspace 安装、Prisma generate/migrate、开发和构建的准确命令。
- 当前真实 API 地址；未启用 Swagger 时删除 Swagger 链接，不写“后续版本”的假地址。
- 种子账号只列用户名/角色和密码来源，不得出现 `admin123`、`legal123`、`biz123` 等固定密码。
- 不把已实现功能继续列为“下一步”。未来项必须来自当前待办并标注状态。

### 9.3 DEPLOY 必须修正

- clone 后目录应是仓库真实根目录，不得再写 `cd LegalOS/LegalPlatform`。
- Codex 部署说明必须与当前受管配置、网关 provider、`CODEX_API_KEY`、`CODEX_HARDENED` 和最小权限方案一致；不得继续只写 `codex login`。
- 不硬编码“7 个 migration”“74/74 测试”等随代码变化的数量，改为命令和成功判定。
- 清楚区分开发迁移与生产 `prisma migrate deploy`，禁止生产使用 `db push`。
- 说明前端静态资源、API、反向代理、健康检查、进程管理、日志和回滚步骤。
- 说明合同模板/文件存储的备份和恢复责任，不允许仅依赖开发机手工 `scp` 而无运维清单。
- 所有环境变量只写名称、用途和生成方式，不写真实值。

### 9.4 架构、权限和状态机文档

`ARCHITECTURE.md` 至少说明：

- Web → API → Prisma/MySQL 的主链路。
- Codex 有界队列、风险分类、技能注入和安全边界。
- Outbox → 钉钉/外部系统的最终一致性链路。
- 合同文档版本、审查运行和附件存储边界。
- Project 模块的 Controller、application、domain、adapter 分层。

`PERMISSIONS.md` 至少说明四种角色对工单、消息、附件、合同、技能、成员和运维接口的权限矩阵，并注明前端隐藏按钮不能替代后端 Policy。

`PROJECT-STATE-MACHINE.md` 至少说明：

- 五种状态含义。
- 每个业务事件允许的来源状态、目标状态和操作者。
- `route`、risk、owner/legalBp 与 status 的关系。
- 终态、失败恢复、升级和取消规则。

`OPERATIONS.md` 至少说明：

- Outbox pending/processing/dead 的排查与重试。
- Codex 队列、超时和执行禁用开关。
- 钉钉 Mock/真实环境切换。
- migration、备份、回滚和最小权限注意事项。
- 日志脱敏和 request ID 排查流程。

### 9.5 文档 CI 校验

增加无外部服务依赖的相对链接检查脚本，例如：

```text
scripts/check-doc-links.mjs
```

要求：

- 校验 README、DEPLOY 和 `docs/**/*.md` 的相对文件链接存在。
- 校验大小写敏感路径，确保 Linux Runner 可用。
- 忽略代码块和示例 URL，不访问办公网/互联网。
- CI 中作为强制 job 执行。
- 可增加陈旧内容断言，至少禁止固定弱密码、错误目录、固定测试/migration 数量和不存在的 Swagger 链接重新出现。

## 10. 测试与验收矩阵

| 范围 | 自动化要求 | 人工/浏览器验证 |
|---|---|---|
| Project API | 权限、状态迁移、事务、AI 成败、升级、Outbox、SSE 中断 | 四角色完成核心工单流程 |
| 状态配置 | 五状态穷尽、分组、动作、统计 | `待处理` 在处理中可见 |
| 错误体系 | HTTP/网络/SSE/重试/request ID/脱敏日志 | 断网、500、403、超时体验 |
| DOCX | 动态 import、双击保护、输出回归、bundle budget | DevTools 验证点击前不加载 |
| 文档 | 相对链接、陈旧内容规则 | 从空环境按 README/DEPLOY 演练 |

最终至少执行：

```bash
cd LegalOS
npm run lint
npm run typecheck
npm --prefix api run test:unit
npm --prefix api run test:integration
npm --prefix web run test
npm --prefix web run build
npm run build
```

若项目已补齐 Playwright，则必须执行：

```bash
npm --prefix web run test:e2e
```

测试完成后再执行只读检查：

```bash
git status --short
git diff --check
git diff --stat
```

不得因为 P1 遗留造成某命令失败就删除命令。应在执行报告中区分：本次引入回归、已知基线失败、环境缺失和未完成前置任务。

## 11. 调优前后预期效果

| 维度 | 调优前 | 调优后目标 | 验证方式 |
|---|---|---|---|
| ProjectService | 约 727 行，多职责耦合 | 独立 query/use case/domain/adapter；façade ≤约 150 行 | 结构审查、依赖图、测试 |
| 状态一致性 | 页面手写状态，遗漏 `待处理` | 五状态单一配置、编译期穷尽 | TypeScript、单元测试 |
| 列表失败体验 | 失败显示为“暂无记录” | 明确错误态、重试和 request ID | 网络故障测试 |
| 写操作重试 | 异常多被吞掉，行为不明确 | 非幂等动作不自动重放，输入保留 | 请求计数、E2E |
| 前端首屏 | DOCX 转换依赖进入页面块 | 点击 Word 前完全不加载 | Vite manifest、DevTools |
| 关键路由包体 | 构建出现 >500 kB 警告 | 初始关键块达到阶段预算，预算不可倒退 | CI bundle budget |
| 项目文档 | 模块、部署、账号和路径陈旧 | 与当前实现一致，可从空环境复现 | 链接检查、部署演练 |

## 12. 明确不在本任务范围

- 不进行 UI 视觉重设计或替换现有品牌风格。
- 不修改业务功能、权限矩阵或 API 产品语义。
- 不部署到生产，不执行生产 migration，不重启服务。
- 不推送远端、不创建 PR，除非用户另行授权。
- 不引入微服务、CQRS 框架、事件总线或新的状态管理库。
- 不默认实现服务端 DOCX 异步导出。
- 不用 P2 替代 P1-06 上传安全、P1-10 升级收敛或 P1-12 CI/E2E 遗留。
- 不顺带拆分 `ContractService`、`MembersService`、`SkillService`；若发现同类问题，记录后续任务，不扩大本轮改动。

## 13. 交给 Claude Code 的执行指令

可将下面内容与本文一起交给 Claude Code：

```text
请严格执行《LegalOS P2-01 至 P2-05 代码改造执行任务书》：

1. 先阅读原复核报告、两份 P1 执行任务书和 P1 遗留清单。
2. 先检查 git status；若存在其他 Agent 未提交改动，不得覆盖，先停止并报告冲突。
3. 以当前最新提交为准，先跑基线并补特征测试，再做渐进式拆分。
4. 必须复用现有 ProjectAccessPolicy、CreateProjectUseCase、EscalateProjectToLegalUseCase 和 Outbox。
5. 按 P2-01、P2-02、P2-03、P2-04、P2-05 分阶段实现和验证，不做全仓重写。
6. 保持现有 API、权限和 UI 功能兼容；不新增平行状态机、权限策略或异步机制。
7. 不使用空 catch、as any、allow_failure、|| true 或降低阈值掩盖失败。
8. 不修改生产环境、不执行生产 migration、不推送远端。
9. 每完成一项都运行对应测试；最终运行完整 lint、typecheck、unit、integration、web test、build 和可用的 E2E。
10. 最终报告必须包含：改动文件、设计取舍、基线与最终测试、包体前后数据、未解决问题、P1 遗留影响和回滚说明。
```

## 14. 完成判定

只有同时满足以下条件，才能将 P2 标记完成：

- P2-01 至 P2-05 的各项验收标准都有代码、测试或文档证据。
- 当前 P1 未完成项被明确列出，没有被 P2 的绿色结果掩盖。
- 原有工单、咨询、合同、法务回复、附件、钉钉、CRM 和 SSE 主流程无回归。
- `待处理` 的筛选与统计错误已修复。
- 页面主数据错误不再显示为空态，关键错误可通过 request ID 排查。
- 点击 Word 前不加载 DOCX 依赖，CI 能阻止包体预算倒退。
- README/DEPLOY/docs 相互链接有效，且不包含固定秘密、错误路径和陈旧数量。
- 工作树中没有来源不明的覆盖、无关格式化或意外生成物。
