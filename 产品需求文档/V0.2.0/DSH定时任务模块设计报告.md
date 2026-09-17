# LegalOS DSH 定时任务模块设计报告

> 版本：V0.2.0  
> 日期：2026-08-26  
> 结论：DSH 原生 Schedule 适合“当前会话中的提醒”，不适合作为 LegalOS 企业定时任务的唯一调度器。LegalOS 应建设数据库驱动的调度控制面，将 DSH 作为受控的 AI 执行引擎。

## 1. 目标与范围

定时任务模块要支持以下业务：

- 每周生成法务运营周报，并投递给指定法务 BP；
- 每日扫描待处理咨询、合同审查和超时工单，发送确定性提醒；
- 根据合同到期日、续签日等业务日期生成提醒；
- 定期拉取法规更新，在完成去重和证据校验后生成摘要；
- 管理员可以启停任务、立即执行、查看历史、重试失败任务和追踪产物；
- 每一次运行都可审计、可限权、可重放，且不会因为页面或会话关闭而丢失。

首期不开放任意 Prompt、任意脚本或任意工具配置。任务必须来自已审核模板，工具范围由平台白名单控制。

## 2. DSH 原生 Schedule 能力评估

### 2.1 已具备能力

当前仓库中的 `deepseek-harness_副本/packages/schedule/schedule` 提供以下稳定工具：

- `schedule_create`：创建一次性延时、绝对时间或固定间隔提醒；
- `schedule_list`：列出当前会话的活动提醒；
- `schedule_delete`：删除当前会话中的提醒；
- 提醒状态写入 Session 事件日志，进程重建后可折叠恢复；
- `at` 支持显式时区，`every_seconds` 最短为 300 秒；
- 到期时通过 Agent maintenance/follow-up 机制重新进入原会话。

官方示例和工具目录：

- [DeepSeek Harness Schedule Web 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/web-schedule/README.md)
- [DeepSeek Harness 工具目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)
- [DeepSeek Harness Packages](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)

### 2.2 不能直接满足 LegalOS 的边界

| 边界 | DSH 原生行为 | 对 LegalOS 的影响 |
| --- | --- | --- |
| 生命周期 | `session-local`，原 Session 必须保持 live | 页面、会话或进程未恢复时，任务不能准时执行 |
| 冷会话 | 不执行；重新打开后才处理 overdue | 无法承担企业级后台任务 SLA |
| 调度规则 | 支持延时、绝对时间、固定间隔；无 Cron/日历规则 | “每周一 09:00”“每月最后一个工作日”需平台实现 |
| 通知 | 无外部通知通道 | 不能直接投递钉钉、站内信或邮件 |
| 执行语义 | dispatch 表示 follow-up 已入队，不等于业务结果成功 | 不能作为业务完成回执 |
| 补偿 | 固定间隔跳过错过的周期，不逐次回放 | 不适合需要明确补跑策略的监管/报表任务 |
| 隔离 | 绑定原对话上下文 | 无法天然保证定时任务的最小权限与数据隔离 |

因此，DSH 原生 Schedule 可以保留为“用户在咨询会话中创建个人提醒”的能力，但后台运营任务必须由 LegalOS 自有调度器负责。

## 3. 推荐总体架构

```text
管理端 / 业务事件
        |
        v
Automation API -----> AutomationJob（任务定义）
        |                         |
        |                         v
        |                Scheduler Dispatcher
        |                  抢占租约 / 计算下次时间
        |                         |
        v                         v
立即执行 ----------------> AutomationRun（运行实例）
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
        Deterministic Worker                DSH Execution Adapter
       查询、聚合、超时判断             隔离 Session + 工具白名单
                 |                                 |
                 +---------------+-----------------+
                                 v
                       Artifact / OutboxEvent
                                 |
                   钉钉 / 站内信 / 下载中心
```

设计原则：

1. **调度与 AI 执行分离**：调度器决定“何时、执行哪一个模板”，DSH 只处理需要语言理解或生成的步骤。
2. **确定性优先**：待办扫描、日期判断、收件人选择、数据聚合使用普通服务；只有摘要、分类、文字生成才调用模型。
3. **运行实例先落库**：每次到期先创建唯一运行记录，再执行外部副作用。
4. **效果幂等而非承诺 exactly-once**：允许运行被重试，但通过幂等键和 Outbox 防止重复通知或重复产物。
5. **无人值守最小权限**：每类模板拥有固定工具白名单、数据范围、token/时间/调用次数预算。

## 4. 数据模型

### 4.1 AutomationJob

| 字段 | 用途 |
| --- | --- |
| `id`, `name`, `description` | 任务标识与说明 |
| `type` | `weekly_report`、`pending_reminder`、`contract_expiry`、`law_update` |
| `scheduleType` | `cron` 或 `business_event` |
| `cronExpression`, `timeZone` | 日历规则与显式时区，默认 `Asia/Shanghai` |
| `enabled` | 是否参与调度 |
| `misfirePolicy` | `skip`、`latest`、`catchup_one` |
| `concurrencyPolicy` | `forbid`、`queue_one`、`allow`；首期默认 `forbid` |
| `templateId`, `templateVersion` | 已审核的任务模板及版本 |
| `toolPolicy` | 白名单工具、数据域、调用次数和超时 |
| `recipientPolicy` | 法务 BP、部门、创建人或固定群组规则 |
| `nextRunAt`, `lastRunAt` | 调度游标 |
| `leaseOwner`, `leaseExpiresAt` | 多实例抢占租约 |
| `createdBy`, `updatedBy` | 管理审计字段 |

### 4.2 AutomationRun

| 字段 | 用途 |
| --- | --- |
| `id`, `jobId`, `scheduledAt` | 一次运行的业务身份 |
| `idempotencyKey` | `jobId + scheduledAt` 唯一索引 |
| `status` | `queued/running/succeeded/partial/failed/cancelled/dead` |
| `attempt`, `maxAttempts` | 有界重试 |
| `startedAt`, `completedAt`, `heartbeatAt` | 生命周期与卡死检测 |
| `dshSessionId`, `traceId` | 与 DSH/链路追踪关联 |
| `inputDigest`, `outputDigest` | 脱敏后的输入输出摘要哈希 |
| `artifactId` | 周报或法规摘要产物 |
| `errorCode`, `errorSummary` | 结构化失败信息 |
| `metrics` | token、工具调用数、耗时、供应商调用统计 |

### 4.3 AutomationDelivery

将通知投递从任务执行中拆开：`runId`、`channel`、`recipient`、`dedupeKey`、`status`、`attempt`、`providerMessageId`、`deliveredAt`。通过现有 `OutboxEvent` 投递，并给 `dedupeKey` 建唯一索引。

## 5. 调度与执行流程

### 5.1 创建或修改任务

1. 管理员选择任务模板、周期、时区、接收范围；
2. API 校验 Cron 表达式、最小执行间隔、接收人数量和工具策略；
3. 计算并保存 `nextRunAt`，记录业务审计事件；
4. 调度器不直接信任自然语言时间，所有时间统一转换为 UTC 存储并保留时区。

### 5.2 到期抢占

1. Worker 使用数据库事务查询 `enabled=true AND nextRunAt<=now` 的任务；
2. 使用 `FOR UPDATE SKIP LOCKED` 或带版本号的条件更新取得短租约；
3. 创建具有唯一幂等键的 `AutomationRun`；
4. 根据 `misfirePolicy` 只补一次、只执行最新一次或跳过；首期禁止无限 catch-up；
5. 立即计算下一次触发时间并提交事务，防止长任务阻塞调度游标。

### 5.3 DSH 执行适配

每次运行创建独立的短生命周期 DSH Session，不复用用户咨询会话。系统输入仅包含：

- 已审核模板及固定系统约束；
- 确定性 Worker 生成的最小化结构数据；
- 任务专属工具白名单；
- 时间、token、工具调用次数和输出大小预算；
- `runId`、`requestId` 和审计关联标识。

DSH 输出必须经过结构校验、敏感信息扫描和证据校验后才能形成产物。法规更新类任务必须复用百鉴法律检索网关，不允许模型把未验证的外部内容当作法律依据。

### 5.4 失败、重试和补偿

- 可重试：网络超时、限流、供应商 5xx、租约中断；采用指数退避和随机抖动；
- 不可重试：模板失效、权限不足、结构校验失败、证据门禁失败；直接进入 `dead` 并通知管理员；
- Worker 崩溃：`heartbeatAt` 超时后由回收器重新排队；
- 通知失败：只重试 `AutomationDelivery`，不重新生成报告；
- 人工“重试”生成新的 attempt，但沿用原 `scheduledAt` 和幂等业务身份。

## 6. 首期任务模板

### 6.1 待处理提醒

无需调用模型。直接查询超时工单，按负责人聚合，通过 Outbox 投递。该任务可最先上线，用于验证调度可靠性。

### 6.2 法务运营周报

1. SQL/服务层确定性聚合咨询量、风险等级、响应时长、转交率和未结项；
2. 将结构化指标交给 DSH 生成摘要和重点事项；
3. 报告生成后做数字一致性校验；
4. 保存不可变快照，再投递链接，不在消息中发送敏感全文。

### 6.3 法规更新摘要

1. 使用供应商更新时间或本地快照差异获取候选法规；
2. 去重并保存来源、效力状态和正文哈希；
3. DSH 仅对已验证的候选集做分类和摘要；
4. 证据不足时标记 `partial`，不得生成“已确认变更”的肯定结论。

## 7. 管理端模块

路由建议：

- `/admin/schedules`：任务列表、状态、下一次执行、最近结果；
- `/admin/schedules/new`：从模板创建任务；
- `/admin/schedules/:id`：配置版本、运行历史、立即执行、启停；
- `/admin/schedule-runs/:id`：运行阶段、工具摘要、产物、投递记录、关联审计。

权限建议：管理员可配置；法务负责人可查看业务范围内运行结果；普通用户只接收与自己相关的产物。任何人都不能在 UI 中直接编辑系统 Prompt 或凭据。

## 8. 安全与治理

- 凭据只通过 `credentialRef` 引用，不进入 Prompt、事件日志或数据库 JSON；
- 定时 DSH Session 默认无 shell、文件系统任意写入和任意网络访问；
- 工具参数做 Schema 校验，供应商返回同时校验 transport 状态与业务状态；
- Prompt、合同全文、附件正文不进入业务审计事件，只记录受限 trace 引用和摘要哈希；
- 每次模板发布生成不可变版本，正在运行的任务继续使用创建时锁定的版本；
- 任务创建、修改、启停、立即执行、取消、重试、投递都生成审计事件。

## 9. 实施阶段与验收

### 阶段 A：可靠调度底座

- Prisma 模型、Dispatcher、租约、运行状态机、Outbox；
- 上线“待处理提醒”，不接模型；
- 验收：多实例无重复投递，进程重启可恢复，时区/DST/错过执行策略测试通过。

### 阶段 B：DSH 执行适配

- 隔离 Session、模板版本、工具白名单、预算、结构化输出；
- 上线“法务运营周报”；
- 验收：数据数字一致、超时可取消、失败可定位、重试不重复投递。

### 阶段 C：法规更新与治理

- 百鉴证据门禁、部分成功状态、人工复核、产物留存；
- 上线法规更新摘要；
- 验收：每条结论可回溯来源，证据不足时不会输出确定性结论。

## 10. 最终决策

不采用“仅安装第三方 Cron 插件并让 DSH 自行长期运行”的方案。DeepSeek Harness 官方仓库仍标注为 developer preview，存在破坏性变更可能；第三方 `dsh-cron`、`dsh-plugin-automations` 等项目可用于参考交互和实现方式，但不能替代 LegalOS 的可靠性、权限和审计边界。[DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)

推荐边界如下：

- **个人会话提醒**：可使用 DSH 原生 Schedule；
- **企业后台定时任务**：LegalOS 数据库调度器负责；
- **需要语言生成的步骤**：由受控 DSH Session 执行；
- **通知、幂等、审计和产物**：由 LegalOS 平台负责。

