# LegalOS P1-01 至 P1-05 代码改造执行任务书

> 用途：交给 Claude Code 直接执行代码修改。  
> 编写日期：2026-08-09  
> 原始依据：`LegalOS-代码架构与实现复核报告.md` 的 P1-01 至 P1-05。  
> 当前代码基线：`LegalOS/main@2af3f58`。原复核报告基于 `b143128`，执行前必须以当前代码为准。  
> 本任务只覆盖 P1-01 至 P1-05，不顺带处理其他 P1/P2 项。

## 1. 执行目标

一次完成以下五项改造，并保证现有咨询、合同生成、合同审查、法务回复、钉钉建群和 SSE 输出功能继续可用：

1. 建立统一的工单对象级权限策略。
2. 让流式和非流式 Codex 调用共享同一个有界并发队列。
3. 让工单创建的本地数据原子提交，并通过 Outbox 异步执行外部副作用。
4. 删除 `dingtalkChatId='PENDING'` 哨兵，改为可回收的任务租约。
5. 建立合同文档版本和审查运行模型，确保每次审查显式绑定源文档。

改造完成后应达到以下结果：

- 未授权用户无法查看或修改目标工单，所有相关接口使用同一套规则。
- Codex 子进程总数不超过全局上限，同一工单同时最多运行一个 AI 任务。
- 工单、首条消息、事件和 Outbox 要么全部提交，要么全部回滚。
- API 进程在钉钉任务执行期间崩溃后，任务可以自动恢复，不会永久卡住。
- 第二次合同审查不会把上一次风险报告当成合同正文。

## 2. 当前实现复核

| 项目 | 当前状态 | 当前代码证据 | 本次处理 |
|---|---|---|---|
| P1-01 权限策略 | 未完成 | `ProjectService.findOne()` 对未指派或非本人法务分支没有拒绝；`update()`、`transfer()` 未接收操作者；`createMessage()` 未做对象授权 | 完整实现 |
| P1-02 Codex 并发 | 未完成 | `CodexService.execute()` 使用 `acquire/release`，`executeStream()` 直接创建子进程；默认并发仍为 50 | 完整实现 |
| P1-03 事务、幂等、Outbox | 部分完成 | `Project.idempotencyKey`、唯一索引和 P2002 竞争兜底已存在；创建消息、事件和建群仍在事务外 | 保留现有幂等实现，补齐事务和 Outbox |
| P1-04 钉钉任务租约 | 未完成 | `ensureDingTalkGroup()` 把 `dingtalkChatId` 写成 `PENDING`；进程崩溃后无法释放 | 完整替换 |
| P1-05 合同复审源文档 | 未完成 | 合同草稿、修订文本和风险报告都使用 `role='assistant'`；审查按最新 assistant 消息取正文 | 完整实现 |

注意：当前分支已经包含 Codex 安全加固提交。不要回退或削弱以下能力：

- `CODEX_HARDENED`、`AI_EXECUTION_ENABLED`。
- 子进程环境变量白名单。
- `CODEX_HOME` 工作区初始化。
- `--strict-config`、`--ephemeral`、`--ignore-user-config` 等硬化参数。
- Codex 超时后终止子进程和工作区清理。

## 3. 总体实施约束

### 3.1 必须遵守

- 修改前先运行现有测试和构建，记录基线结果。
- Prisma Schema 变更必须生成正式 migration，不允许只运行 `prisma db push`。
- 外部钉钉调用不得放进数据库事务。
- 不得使用 `dingtalkChatId`、其他外部 ID 字段或业务状态字段保存任务锁。
- 不得通过消息 `role` 或 `label` 推断合同文档类型。
- 不得通过单纯的“先查再写”实现并发互斥；必须依赖唯一约束、条件更新或事务。
- 所有 Worker 和队列任务必须支持幂等重试。
- 不删除现有接口，不改变现有成功响应的主要业务字段；确需增加字段时保持向后兼容。
- 不修改前端视觉样式。本任务只允许做维持现有功能所需的最小前端协议适配。
- 不提交 `.env`、密钥、真实合同正文、数据库转储或日志。

### 3.2 推荐目录

在不进行全仓重写的前提下增加以下结构：

```text
api/src/modules/project/
  application/
    create-project.use-case.ts
  domain/
    project-access.policy.ts
    project-access.types.ts
  infrastructure/
    outbox.worker.ts
    outbox.repository.ts

api/src/common/services/
  codex-execution-queue.service.ts

api/src/modules/contract/
  contract-document.service.ts
```

目录名称可根据 NestJS 现有约定微调，但权限、队列、Outbox、合同文档四类职责不得继续堆入 `ProjectService`。

## 4. 实施顺序

必须按以下顺序执行，避免多项改造同时修改同一段代码造成回归：

1. 建立数据库模型和 migration。
2. 实现 `ProjectAccessPolicy` 并接入全部工单接口。
3. 统一 Codex 并发队列和工作区互斥。
4. 将工单创建改成事务并写入 Outbox。
5. 实现带租约的 Outbox Worker，替换钉钉 `PENDING` 哨兵。
6. 迁移合同草稿、修订文本和审查记录到显式模型。
7. 补齐单元测试、MySQL 集成测试和故障恢复测试。
8. 运行完整构建和回归测试。

## 5. P1-01：统一工单对象级权限策略

### 5.1 目标

所有工单详情、消息、更新、回传、取消、转派、合同审查和附件接口都通过同一个 `ProjectAccessPolicy` 判断权限。Controller 的 `@Roles()` 只做角色粗筛，不能替代对象级授权。

### 5.2 权限矩阵

| 动作 | business | legal_bp | legal_lead | admin |
|---|---|---|---|---|
| 查看列表 | 仅自己创建 | 仅指派给自己；未分配工单只显示可认领摘要 | 全部 | 全部 |
| 查看详情/消息/文件 | 仅自己创建 | 仅 `legalBpId` 或 `ownerId` 为自己 | 全部 | 全部 |
| 发送普通消息 | 仅自己创建 | 仅已指派给自己 | 全部 | 全部 |
| 更新状态/风险/结果 | 禁止 | 仅已指派给自己，且字段受动作限制 | 全部 | 全部 |
| 认领未分配工单 | 禁止 | 允许，必须使用原子条件更新 | 允许 | 允许 |
| 转派 | 禁止 | 禁止 | 允许 | 允许 |
| 法务正式回传 | 禁止 | 仅已指派给自己 | 允许 | 允许 |
| 取消 | 仅创建者且未完成 | 禁止 | 允许 | 允许 |
| 合同审查 | 禁止 | 仅已指派给自己 | 允许 | 允许 |
| 上传/下载附件 | 创建者可操作自己的工单 | 仅已指派给自己 | 全部 | 全部 |

如果当前产品明确要求法务 BP 可以互相转派，先在任务结果中列为产品决策，不要默默保留现状。默认按最小权限执行上表。

### 5.3 实现要求

1. 定义显式动作枚举，例如：

   ```ts
   export enum ProjectAction {
     List = 'list',
     Read = 'read',
     SendMessage = 'send-message',
     Update = 'update',
     Claim = 'claim',
     Transfer = 'transfer',
     Reply = 'reply',
     Cancel = 'cancel',
     ReviewContract = 'review-contract',
     ManageFile = 'manage-file',
   }
   ```

2. `ProjectAccessPolicy.assertCan(actor, action, project)` 无权限时统一抛出 `ForbiddenException`。为降低工单 UUID 枚举风险，可以在读取类接口统一返回 404，但项目内必须保持一致。
3. Controller 必须把当前用户的 `id` 和 `role` 传给 Service/use case。禁止 Service 在缺少操作者时执行受保护动作。
4. `ProjectService.findAll()` 必须接收 actor，由服务端生成查询条件；禁止客户端提交任意 `creatorId`、`ownerId` 或 `legalBpId` 绕过范围。
5. `update()` 和 `transfer()` 改为接收 actor，并在写入前调用 Policy。
6. `createMessage()` 必须先鉴权再创建消息。客户端 DTO 中的 `role` 应删除；消息角色由服务端根据 actor 和业务动作派生。AI 消息只能由内部 AI 完成回调创建。
7. `reply()` 必须把“有权回传”和“状态允许回传”同时放进条件更新，防止检查后状态或指派发生变化。
8. `ContractService` 删除私有的重复 `assertAccess()`，改用统一 Policy。
9. 未分配工单认领使用类似以下原子条件：

   ```ts
   updateMany({
     where: { id: projectId, legalBpId: null },
     data: { legalBpId: actor.id, ownerId: actor.id },
   })
   ```

   `count=0` 时重新读取并判断是已被他人认领还是工单不存在。

### 5.4 必测场景

- business A 读取、发消息、上传或下载 business B 的工单，全部失败。
- legal_bp A 读取或修改已指派给 legal_bp B 的工单，全部失败。
- legal_bp 可以查看未分配队列摘要，但不能读取正文、消息或文件；认领成功后才可操作。
- 两个 legal_bp 并发认领同一工单，只有一个成功。
- legal_bp 不能自行转派；legal_lead/admin 可以转派。
- 客户端提交 `role=assistant` 或 `role=legal` 不会创建伪造身份消息。
- 权限失败时数据库没有新增消息、事件或附件元数据。

## 6. P1-02：统一 Codex 有界并发和同工单互斥

### 6.1 目标

`execute()` 和 `executeStream()` 必须共享同一个队列。全局同时运行的 Codex 子进程不得超过 `CODEX_CONCURRENCY`，同一个 `sessionId/projectId` 同时最多运行一个任务。

### 6.2 实现要求

1. 提取 `CodexExecutionQueueService`，队列至少保存：任务 ID、sessionId、入队时间、开始时间、状态、取消信号和启动函数。
2. 配置默认值调整为保守值，建议：

   ```text
   CODEX_CONCURRENCY=4
   CODEX_QUEUE_MAX_SIZE=100
   CODEX_QUEUE_TIMEOUT_MS=120000
   CODEX_PROJECT_CONCURRENCY=1
   ```

   最终默认值应写入配置说明和 `.env.example`，生产值由压测确认，不能继续默认 50。
3. `execute()` 和 `executeStream()` 都必须先入队，获得全局槽位和 session 槽位后才能调用 `spawnCodex()`。
4. 队列满时返回明确的“AI 服务繁忙”错误；排队超时不能启动子进程。
5. `close`、`error`、超时、调用方取消和 spawn 抛错的所有路径都必须且只能释放一次槽位。
6. 用一次性 finalize 函数防止 `error` 与 `close` 双重释放。
7. 同一 `sessionId` 的两个任务不能复用并同时清理同一个工作目录。可以在获得 session 槽位后创建任务级子目录，例如 `<sessionId>/<executionId>`。
8. HTTP/SSE 连接断开后，应取消尚未启动的排队任务；已启动任务先发 `SIGTERM`，宽限期后仍未退出再发 `SIGKILL`。
9. 保持现有 `AI_EXECUTION_ENABLED` Kill Switch、超时、环境白名单及沙箱参数不变。
10. 至少记录以下结构化指标或日志字段：

    - active、queued、queueWaitMs。
    - executionMs、timeout、cancelled。
    - sessionId、executionId、exitCode。
    - 子进程 PID；如监控系统支持，再采集 RSS。

### 6.3 接口兼容要求

允许把 `executeStream()` 改成异步，但必须同步修改全部调用方：

- `ProjectService.triggerAIResponse()`。
- `ContractService.generateDraft()`。
- `ContractService.reviewContract()`。
- 相关 Controller 和 `sendSSE()`。

队列等待失败必须在 SSE 响应开始前返回可识别的 HTTP 错误；已经开始 SSE 后的执行错误继续走现有 SSE error 事件。

### 6.4 必测场景

- 同时提交 `CODEX_CONCURRENCY + 2` 个任务，实际 spawn 数峰值不超过上限。
- 两个不同项目可以在全局额度内并行。
- 同一项目的两个流式任务严格串行，工作区互不删除。
- 一个非流式任务和一个流式任务也共享同一全局上限。
- spawn 失败、超时、SIGTERM、SIGKILL、正常完成都准确归还槽位。
- 队列满和排队超时不会创建子进程。
- 连接中断能取消排队任务或终止已启动任务。
- Kill Switch 关闭时不入队、不 spawn。

## 7. P1-03：工单创建事务、幂等和 Outbox

### 7.1 已完成内容

以下内容已存在，必须保留并补测试，不要重复建立第二套：

- `Project.idempotencyKey`。
- `projects.idempotency_key` 唯一索引。
- 创建前按幂等键查询。
- 并发创建触发 Prisma `P2002` 后返回已存在工单。
- 钉钉 `dedupKey=legalos-${projectId}`。

### 7.2 仍需完成

1. 新增持久化 Outbox 模型。推荐最小字段：

   ```prisma
   enum OutboxStatus {
     pending
     processing
     succeeded
     dead
   }

   model OutboxEvent {
     id            String       @id @default(uuid())
     eventType     String       @map("event_type") @db.VarChar(64)
     aggregateType String       @map("aggregate_type") @db.VarChar(64)
     aggregateId   String       @map("aggregate_id")
     dedupKey      String       @unique @map("dedup_key") @db.VarChar(191)
     payload       Json
     status        OutboxStatus @default(pending)
     attempts      Int          @default(0)
     availableAt   DateTime     @default(now()) @map("available_at")
     claimedAt     DateTime?    @map("claimed_at")
     claimToken    String?      @map("claim_token") @db.VarChar(64)
     lastError     String?      @map("last_error") @db.Text
     completedAt   DateTime?    @map("completed_at")
     createdAt     DateTime     @default(now()) @map("created_at")
     updatedAt     DateTime     @updatedAt @map("updated_at")

     @@index([status, availableAt])
     @@index([aggregateId])
     @@map("outbox_events")
   }
   ```

   字段可调整，但必须保留唯一去重键、重试次数、可执行时间、租约、错误和完成时间。
2. 风险评估、技能解析和 BP 匹配可以在事务前完成；以下本地写入必须在同一个 Prisma 交互式事务中完成：

   - Project。
   - 第一条 ProjectMessage。
   - ProjectEvent。
   - 需要钉钉建群时的 OutboxEvent。

3. 事务提交后立即返回工单，不再在请求中同步调用钉钉。
4. Outbox 的 `dedupKey` 使用稳定业务键，例如 `project:${projectId}:dingtalk-group:create:v1`。
5. 客户端重复提交同一 `idempotencyKey` 时：

   - 只返回同一个 Project。
   - 返回旧 Project 前必须校验其创建者或可信请求来源与当前请求一致；不同用户碰撞同一键时返回 409，不能泄露他人工单。
   - 只有一条首消息和一组初始事件。
   - 只有一个建群 OutboxEvent。
   - 不重复启动 AI 任务。必要时为 AI 执行增加独立 dedupKey。
6. `ContractService.generateDraft()` 新建合同工单时也必须复用相同的事务创建能力，而不是继续手工分步创建。为 `CreateContractDto` 增加可选 `idempotencyKey`，保留旧客户端兼容性。
7. 不要把钉钉网络调用放入 `$transaction()`；数据库事务不能回滚外部系统。

### 7.3 失败语义

- Project、首消息、事件或 Outbox 任一写入失败：整个事务回滚。
- 事务成功、钉钉失败：工单继续存在，Outbox 进入重试，不回滚工单。
- 同一幂等键对应的请求参数不一致时，不应静默返回旧工单。建议保存请求摘要并返回 409；如果本轮不实现摘要，至少记录告警并在结果中说明限制。

### 7.4 必测场景

- 人为让首消息、事件或 Outbox 创建失败，数据库中不存在半成品 Project。
- 20 个并发请求使用同一幂等键，最终只有一个 Project、一条首消息和一个 OutboxEvent。
- 钉钉不可用时创建接口仍成功，任务进入 pending/retry。
- 重复消费同一个 OutboxEvent 不会创建第二个群。
- 合同新建工单与咨询新建工单使用相同事务能力。

## 8. P1-04：替换钉钉 `PENDING` 哨兵为可恢复租约

### 8.1 目标

`dingtalkChatId` 只能保存真实钉钉群 ID 或 `null`。任务状态全部保存在 Outbox/IntegrationTask 中，Worker 崩溃后其他实例可以回收过期任务。

### 8.2 实现要求

1. 删除所有写入或判断 `dingtalkChatId='PENDING'` 的代码。
2. Outbox Worker 使用数据库条件更新认领任务。认领条件至少包括：

   - `status=pending AND availableAt <= now`；或
   - `status=processing AND claimedAt < leaseExpiry`。
3. 认领时原子写入随机 `claimToken`、`claimedAt`、`status=processing` 并增加 attempts。
4. 完成或失败更新必须带 `id + claimToken` 条件，防止旧 Worker 覆盖已被重新认领的任务。
5. 建议配置：

   ```text
   OUTBOX_POLL_INTERVAL_MS=1000
   OUTBOX_LEASE_MS=60000
   OUTBOX_MAX_ATTEMPTS=8
   OUTBOX_BATCH_SIZE=10
   ```

6. 失败按指数退避并加入随机抖动；超过最大次数进入 `dead`，保留 `lastError`，写入不含敏感信息的工单事件并输出告警。
7. 执行建群前先重新读取 Project：

   - 已有真实 `dingtalkChatId`：将任务标记 succeeded，不再建群。
   - 工单已取消：按业务规则标记 succeeded/skipped。
   - legalBpId 已变化：使用最新指派关系生成成员。
8. 调用钉钉时继续传稳定 dedupKey。即使 Worker 在“钉钉成功、数据库未标记成功”之间崩溃，重试也必须返回同一群或能够通过适配器查询恢复。
9. Worker 生命周期由 NestJS 管理，支持优雅停机：停止拉取新任务，等待当前任务到宽限期，未完成任务依赖租约恢复。
10. 提供最小运维查询或管理接口，能够查看 pending、processing、dead 数量以及最近错误。管理接口仅允许 admin/legal_lead。

### 8.3 必测场景

- Worker 认领后、调用钉钉前崩溃，租约到期后另一 Worker 能继续执行。
- 钉钉建群成功但数据库成功标记前崩溃，重试不产生第二个群。
- 两个 Worker 同时轮询，只有一个拿到同一任务。
- 旧 Worker 在租约过期后返回，不会覆盖新 Worker 的处理结果。
- 连续失败达到上限后进入 dead，错误可查询且工单仍可人工处理。
- 数据库中再也不会出现 `dingtalk_chat_id='PENDING'`。

## 9. P1-05：合同文档版本与审查运行模型

### 9.1 目标

合同正文和审查报告使用不同的领域模型。每次审查记录明确的 `sourceDocumentId`，不再查询“最新 assistant 消息”决定审查对象。

### 9.2 数据模型

推荐增加以下模型；命名可调整，但语义不能省略：

```prisma
enum ContractDocumentType {
  draft
  revised
  final
}

enum ContractReviewStatus {
  queued
  running
  succeeded
  failed
  cancelled
}

model ContractDocument {
  id           String               @id @default(uuid())
  projectId    String               @map("project_id")
  project      Project              @relation(fields: [projectId], references: [id], onDelete: Cascade)
  documentType ContractDocumentType @map("document_type")
  version      Int
  content      String               @db.LongText
  sourceFileId String?              @map("source_file_id")
  createdBy    String?              @map("created_by")
  createdAt    DateTime             @default(now()) @map("created_at")

  reviewRuns   ContractReviewRun[]

  @@unique([projectId, version])
  @@index([projectId, documentType, createdAt])
  @@map("contract_documents")
}

model ContractReviewRun {
  id               String               @id @default(uuid())
  projectId        String               @map("project_id")
  project          Project              @relation(fields: [projectId], references: [id], onDelete: Cascade)
  sourceDocumentId String               @map("source_document_id")
  sourceDocument   ContractDocument     @relation(fields: [sourceDocumentId], references: [id], onDelete: Restrict)
  status           ContractReviewStatus @default(queued)
  result           String?              @db.LongText
  skillId          String?              @map("skill_id")
  errorMessage     String?              @map("error_message") @db.Text
  startedAt        DateTime?            @map("started_at")
  completedAt      DateTime?            @map("completed_at")
  createdBy        String               @map("created_by")
  createdAt        DateTime             @default(now()) @map("created_at")

  @@index([projectId, createdAt])
  @@index([sourceDocumentId])
  @@map("contract_review_runs")
}
```

应补齐 `Project` 和必要 User/ContractFile 关系。若 `sourceFileId` 建立外键，需要明确删除策略，避免删除附件后破坏审查审计链。

### 9.3 写入规则

1. AI 合同草稿成功后：

   - 新增 `ContractDocument(type=draft, version=N)`。
   - 可以继续写一条 ProjectMessage 供现有前端展示，但消息不是审查数据源。
2. 上传 revised DOCX 并成功提取文本后：

   - 新增 `ContractDocument(type=revised, version=N, sourceFileId=...)`。
   - 提取失败时不得创建空文档，并向用户返回可理解状态；不能只记录 warning 后让用户误以为可审查。
3. final 文件只有在能提取正文时才建立 `type=final` 文档；否则只保留附件元数据。
4. 版本号必须在事务内或通过唯一约束安全分配。并发上传时发生唯一冲突要重试，不能覆盖旧版本。
5. `reviewContract()`：

   - 接收可选 `sourceDocumentId`。
   - 未提供时由服务端选择当前项目最新可审查 ContractDocument。
   - 提供时验证文档属于当前项目。
   - 创建 `ContractReviewRun(status=queued/running, sourceDocumentId=...)` 后才启动 Codex。
   - prompt 只使用该文档的 content。
   - 成功后把输出写入 ReviewRun.result/status/completedAt，并可同步写 ProjectMessage 供 UI 展示。
   - 失败或取消时写入明确状态和脱敏后的 errorMessage。
6. 风险报告永远只进入 `ContractReviewRun.result`，不能创建为 ContractDocument。
7. 审查响应和 SSE 完成事件增加 `reviewRunId`、`sourceDocumentId`、`sourceVersion`，保留现有 `projectId`。

### 9.4 存量数据迁移

不要在 migration 中把所有 `assistant` 消息都当合同正文。编写可重复执行、支持 `--dry-run` 的回填脚本：

1. 只处理 `Project.kind='contract'`。
2. 排除 `label='AI 风险审查'` 的消息。
3. `label='修订版文本'` 映射为 revised。
4. 其余能够确定为合同草稿的消息映射为 draft；无法可靠判断的记录输出报告，禁止猜测。
5. 同一项目按创建时间分配递增版本号。
6. 重复运行不重复创建，可使用来源消息 ID 的唯一映射字段或迁移记录表。
7. 回填完成后输出：扫描数、创建数、跳过数、歧义数和歧义 ID 列表。

### 9.5 必测场景

- 首次生成草稿后审查，ReviewRun 指向 draft v1。
- 上传修订版后审查，ReviewRun 指向 revised v2。
- 不上传新文档直接第二次审查，仍指向同一份源文档，不会使用上一次风险报告。
- 显式传入其他工单的 sourceDocumentId 时拒绝。
- 两个修订版并发上传时版本号唯一且递增。
- AI 审查失败后 ReviewRun 为 failed，源文档不变。
- 历史 ProjectMessage 仍能在现有详情界面展示。

## 10. 数据库迁移要求

建议拆成两个 migration，便于回滚和排查：

1. `add_outbox_and_integration_state`
2. `add_contract_documents_and_review_runs`

迁移必须满足：

- 新增字段先允许兼容旧数据，不直接删除 `ProjectMessage.role/label`。
- 不删除现有 `idempotency_key` 唯一索引。
- 上线顺序支持先迁移数据库、再发布兼容代码、再执行回填。
- 为 Outbox 轮询条件和合同文档查询建立必要索引。
- 提供回滚说明；回滚不得删除已产生的审查结果，必要时只回滚应用版本，不回滚数据表。

## 11. 测试与验收

### 11.1 必须新增的测试文件

建议至少新增：

```text
api/test/project-access-policy.spec.ts
api/test/project-authorization.integration.spec.ts
api/test/codex-execution-queue.spec.ts
api/test/project-create-transaction.integration.spec.ts
api/test/outbox-worker.integration.spec.ts
api/test/contract-document-version.integration.spec.ts
api/test/contract-review-source.spec.ts
```

单元测试可以 mock Prisma；事务、唯一约束、Worker 竞争和租约恢复必须使用 MySQL 集成测试，不能只靠 mock。

### 11.2 执行命令

```bash
cd LegalOS/api
npm ci
npx prisma format
npx prisma validate
npx prisma generate
npm test
npm run build

cd ../web
npm ci
npm run build
```

如果项目新增集成测试脚本，应在 `api/package.json` 增加明确命令，例如 `test:integration`，并在任务结果中给出所需测试数据库变量。

### 11.3 最终验收门槛

- 现有测试全部通过，不能删除或放宽断言换取通过。
- 新增权限矩阵测试全部通过。
- 并发压测中 Codex 实际子进程峰值不超过配置值，同项目峰值为 1。
- 故障注入后不存在半成品工单。
- Outbox Worker 崩溃恢复测试通过，数据库不存在 `PENDING` 群 ID。
- 两轮以上合同审查均能追溯准确源文档 ID 和版本。
- API 和 Web 生产构建通过。
- Prisma migration 能在空库和包含旧数据的测试库各执行一次。

## 12. Claude Code 执行指令

将本文件交给 Claude Code 后，使用以下要求：

```text
请严格按照《LegalOS P1-01 至 P1-05 代码改造执行任务书》执行。

开始前：
1. 阅读任务书引用的当前实现、Prisma Schema、相关测试和最新 git diff。
2. 运行现有测试与构建，记录基线。
3. 输出拟修改文件清单和实施顺序，但不要等待我逐项确认；发现会改变权限矩阵或外部 API 语义的冲突时再停止询问。

实施时：
1. 按任务书第 4 节顺序完成 P1-01 至 P1-05。
2. 保留当前 Codex 安全加固、Kill Switch、幂等键和钉钉 dedupKey。
3. 不修改 UI 样式，不处理 P1-06 以后或 P2 项。
4. 每完成一个逻辑阶段就运行对应测试；不要通过删除测试、弱化权限或吞掉异常解决失败。
5. 不执行 git push、部署、生产迁移或真实钉钉调用。

完成后：
1. 运行 Prisma 校验、API 全量测试、API build 和 Web build。
2. 输出实际修改文件、migration、测试结果、未解决风险和上线步骤。
3. 按 P1-01 至 P1-05 分项给出“已完成/部分完成/未完成”和证据。
```

## 13. 明确不在本次范围内

- P0 安全问题的重新设计；只要求不得回退已完成的 Codex 加固。
- P1-06 文件上传授权前置和对象存储迁移。
- P1-07/P1-08 通讯录一致性与批处理性能。
- P1-09 技能审核日志表。
- P1-10 统一合同法务升级用例的完整重构；本次只做 P1-01 至 P1-05 所必需的最小复用。
- P1-11 风险分类不可降级规则。
- P1-12 完整 CI 门禁。
- 前端视觉优化和无关重构。

如果实现 P1-01 至 P1-05 必须触碰上述模块，只允许做最小兼容修改，并在最终报告中单独列出原因和影响。
