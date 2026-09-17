# LegalOS 审计日志与 DSH Trace 能力评估报告

> 版本：V0.2.0  
> 初评日期：2026-08-26  
> 实施更新：2026-08-27  
> 结论：统一 `AuditEvent` 和首批平台级埋点已经落地，能够支撑管理员身份变更、工单变更、敏感下载、安全失败和 AI/人工处理关联查询。DSH Trace 仍只承担 AI 执行证据，不能替代业务审计；数据库权限隔离、全量防删除证明和归档策略仍需部署侧完成。

## 0. 本次实施结果

本次已新增：

- `AuditEvent` 统一事件表、迁移、写入服务、HMAC/SHA-256 完整性校验和留存类别；
- `/api/admin/audit-logs` 只读分页查询、`/api/admin/audit-logs/stats` 按 action/outcome/reasonCode 分组统计与 `/api/admin/audit-logs/integrity` 完整性检查；
- 管理员手动绑定/解绑钉钉身份、修改 BP 工作范围，以及通讯录同步引起的自动绑定和部门/角色变更，均记录 actor、before/after、字段差异和 requestId；
- 工单修改、转派、取消、升级人工、法务正式回传的结构化事件；
- 合同附件服务端下载，以及浏览器生成的合同/咨询记录下载前审计；
- 登录失败、JWT/RBAC/对象级授权拒绝及高风险接口失败事件；
- AI Run 的模型版本、工具摘要、输出哈希、DSH Session，以及最终人工回传事件反向关联；启动阶段失败也会落终态，流式 `error/close` 共用一次性终态门避免重复计数。

权限口径：`admin` 可查看全部审计事件和执行完整性检查；`legal_lead` 只可查看 `business`、`ai` 两类事件，不能读取安全登录和管理员身份管理事件。所有查询行为自身记录 `audit.read`。

## 1. 评估问题

本报告回答三个问题：

1. 当前 LegalOS 已记录了什么；
2. 现有记录能否回答“谁在何时、以什么权限、对哪个对象做了什么、结果如何”；
3. DSH Session/Trace 能否单独承担审计日志。

评估范围包括登录、成员管理、咨询/工单、合同、技能审批、法律检索、AI 执行和外部投递。

## 2. 当前埋点盘点

| 现有记录 | 已覆盖 | 主要缺口 |
| --- | --- | --- |
| `LoginAudit` | 成功登录用户、IP、时间 | 无失败登录、退出、刷新/撤销、认证方式、结果、User-Agent、requestId |
| `ProjectEvent` | 工单时间线文本 | 只有自然语言文本，无 actor、action、before/after、结果、requestId、结构化元数据 |
| `SkillReviewLog` | 技能状态迁移、操作者、理由、事件 ID | 覆盖较好，但仍应关联 requestId/correlationId 和发布版本 |
| `RiskAssessmentLog` | 风险等级、路由、命中规则、模型理由和版本 | 偏“决策记录”，缺请求主体、授权结果和统一审计事件关联 |
| `ConsultationRun` | 运行状态、消息、能力、DSH Session、耗时、错误、researchTrace | 适合 AI 运行追踪，不覆盖业务对象修改和管理员操作 |
| `researchTrace` | 工具、查询摘要、证据 ID、限制、供应商状态 | 有界证据轨迹，不是完整 Prompt/工具事件，也缺业务行为语义 |
| `LegalResearchUsage` | 缓存、供应商、耗时、数量、能力 | 适合用量与性能，不足以证明访问权限和用户行为 |
| `ContractGenerationRun` / `ContractReviewRun` | 合同 AI 运行 | 需统一 actor、requestId、输入输出摘要和授权结果 |
| `OutboxEvent` | 外部事件待投递 | 是可靠投递基础，不等同于审计事件 |
| Request ID + 异常日志 | 请求关联和 5xx 排障 | 未将 requestId 系统性写入业务变更记录；日志不是持久审计库 |
| `AuditEvent`（2026-08-27 新增） | actor、action、resource、outcome、before/after 哈希、changes、request/correlation、留存和完整性哈希 | 首批关键链路已接入；数据库账号权限、WORM 归档和跨分区防删除证明待部署 |

实施前没有统一 `AuditEvent`。本次实施后，六类问题的支撑情况如下：

| 问题 | 当前答案 | 事件/字段 |
| --- | --- | --- |
| 哪个管理员绑定/解绑钉钉身份或修改 BP 范围 | 已支持 | `member.bind`、`member.unbind`、`member.bp_scope.change`、`member.directory_profile.change`、`member.directory.sync`，含 actor 和字段差异 |
| 谁修改、转交、取消工单，前后值是什么 | 已支持首批核心命令 | `project.update`、`project.transfer`、`project.cancel`、`project.escalate`、`project.reply` |
| 谁下载合同、附件或咨询记录 | 已支持正常产品入口 | `contract.download`、`attachment.download`、`consultation_record.download` |
| 权限、登录和高风险操作失败次数 | 已支持按 action/outcome/reasonCode 聚合 | `/admin/audit-logs/stats`；`authorization.denied`、`auth.login.failed`、`*.failed` |
| AI 结论如何关联模型、工具和人工处理 | 已支持咨询 Run | `ai.run.*` + `ConsultationRun.modelVersion/toolSummary/outputHash/humanAuditEventId` |
| 是否修改、保留多久、谁能查看 | 部分支持 | HMAC/哈希校验、retentionClass/expiresAt、RBAC；防删除/WORM 待部署 |

结论：**首批平台级审计底座和关键埋点已具备；要达到强合规不可抵赖，还需完成数据库最小权限、不可变归档和正式留存制度。**

## 3. DSH Trace 能力边界

### 3.1 DSH Trace 能提供什么

DSH 的 Session 事件和 telemetry/trace 适合记录 AI 执行过程，例如：

- Session、轮次、模型调用和输出；
- 工具名称、参数、结果和错误；
- 运行耗时、token、取消、重试和关联标识；
- Agent 运行中的中间步骤和最终回答；
- 与 LegalOS `ConsultationRun.dshSessionId`、`researchTrace` 形成关联。

因此，DSH Trace 是回答“AI 为什么产生这个结果、调用过哪些工具”的关键证据层。

### 3.2 为什么不能替代业务审计

| 业务审计要求 | 单独依赖 DSH Trace 的问题 |
| --- | --- |
| 身份与授权 | DSH 知道 Agent 上下文，不天然证明最终认证用户、角色和授权决策 |
| 业务动作语义 | 工具调用不等于“成员解绑”“合同提交审批”等领域动作 |
| 数据变更前后 | Trace 不天然记录数据库事务中规范化的 before/after |
| 成功判定 | 模型或工具返回成功不等于事务提交、Outbox 投递或外部业务码成功 |
| 完整性 | telemetry 通常是 best-effort，接收端需去重，也可能在进程退出时丢失队列事件 |
| 脱敏与最小化 | 原始 Prompt、工具参数和合同正文可能包含敏感信息，不适合直接成为广泛可查的审计库 |
| 留存与不可篡改 | Session 生命周期、删除策略与法律审计留存策略不同 |
| 实体查询 | 审计员按用户、合同、项目、动作、结果查询时，原始 trace 成本高且语义不稳定 |

特别需要注意：完整 DSH Trace 可能比审计事件包含更多敏感数据。应限制访问、设置独立留存周期，并在采集端做脱敏；不能简单把所有 Prompt 和工具结果复制到管理员审计页面。

## 4. 推荐三层模型

```text
第一层：AuditEvent（权威业务审计）
  谁 / 何时 / 对什么 / 做什么 / 授权和结果 / 变更摘要
                         |
                         v
第二层：AIExecution（AI 运行证据）
  dshSessionId / runId / 模型 / 工具摘要 / 证据摘要 / 成本 / 输出哈希
                         |
                         v
第三层：Operational Telemetry（运维观测）
  requestId / OTel trace / 日志 / 指标 / 告警
```

- 第一层是审计权威来源，保存在 LegalOS 数据库并按业务事务写入；
- 第二层解释 AI 行为，保存脱敏摘要和受限 trace 的引用；
- 第三层用于排障和性能监控，不承担长期业务证明责任。

## 5. AuditEvent 数据设计

| 字段 | 说明 |
| --- | --- |
| `id`, `eventId` | 全局唯一；`eventId` 用于重复请求去重 |
| `occurredAt` | 业务动作发生时间，UTC 存储 |
| `actorType`, `actorId`, `actorRole` | 用户、管理员、系统任务或外部服务 |
| `action` | 稳定枚举，如 `member.bind`、`project.transfer`、`contract.download` |
| `resourceType`, `resourceId` | 被操作对象 |
| `projectId` / `tenantScope` | 业务范围和未来租户范围 |
| `source` | `web/api/scheduler/dingtalk/dsh` |
| `outcome` | `success/denied/failed/partial` |
| `reasonCode` | 失败、拒绝或高风险操作的结构化原因 |
| `requestId`, `correlationId` | HTTP、异步链路与跨服务关联 |
| `ipHash`, `userAgentHash` | 最小化终端指纹，不直接扩散明文 |
| `beforeHash`, `afterHash` | 变更前后规范化摘要哈希 |
| `changes` | 字段级差异，只保留允许审计的字段 |
| `metadata` | 有界、Schema 化、脱敏后的补充信息 |
| `eventHash`, `hashVersion` | 当前实现为 HMAC-SHA256（配置密钥时）或 SHA-256 完整性哈希；分区哈希链仍是后续项 |
| `retentionClass` | 登录、安全、业务、AI 等留存类别 |

应用代码当前只暴露 INSERT/SELECT，没有审计事件更新或删除接口；`eventHash` 可检查字段是否被改写。生产数据库仍应把运行账号限制为审计表 INSERT/SELECT，禁止 UPDATE/DELETE。当前事件哈希不能发现整行删除；若需要更强证明，应按日或租户构建哈希链，并定期把分区摘要导出到独立对象存储/WORM 介质。

`AUDIT_HMAC_SECRET` 未配置时服务会明确告警并退化为普通 SHA-256。普通哈希只能发现意外修改，无法抵抗能够同时修改数据并重算哈希的数据库管理员；生产必须配置独立于数据库保存的 HMAC 密钥。`AUDIT_FINGERPRINT_SALT` 用于 IP/User-Agent 指纹，未单独配置时复用 HMAC 密钥；生产至少必须配置两者之一。终端 IP 只使用 Express 按受信代理配置解析后的 `request.ip`，不直接信任客户端 `X-Forwarded-For`。

## 6. 写入时机与一致性

### 6.1 同事务写入

以下高价值动作应在业务事务内同时写入 `AuditEvent`：

- 工单创建、认领、转交、升级人工、回复、取消、状态变更；
- 合同生成请求、提交审查、审查结论、文件删除/下载授权；
- 技能创建、修改、提交、撤回、审批、归档、恢复；
- 成员绑定/解绑、角色变更、BP 工作范围变更；
- 定时任务创建、修改、启停、立即执行、取消、重试；
- 系统配置、模型配置、凭据引用和权限策略变更。

业务事务回滚时，成功审计事件也应回滚；拒绝和失败事件通过独立安全审计写入，`outcome` 明确为 `denied/failed`。

当前实现中，成员绑定/解绑/BP 范围、工单普通更新/转派/取消/人工回传、AI 成功答案与审计事件均在同一 Prisma 事务写入。工单升级用例、登录成功投影和部分 AI 失败路径仍为业务写入后追加审计：升级与失败事件已有记录，但若数据库在两个写入之间故障，可能产生审计缺口，后续应通过统一领域命令上下文或 Outbox 收敛。

### 6.2 异步链路

对于 DSH、钉钉和定时任务，通过 `correlationId` 贯穿：

```text
HTTP requestId
  -> AuditEvent(correlationId)
  -> ConsultationRun / AutomationRun
  -> dshSessionId / traceId
  -> OutboxEvent
  -> providerMessageId
```

外部 HTTP 200 不能自动视为业务成功。供应商适配器必须校验嵌套业务码、结果结构和必要字段，再更新运行和投递状态。

## 7. 事件分类与首期覆盖矩阵

### P0：安全与权限

- `auth.login.success`、`auth.login.failed` 已实现；`auth.logout`、`auth.session.revoked` 待补；
- `member.bind`、`member.unbind`、`member.bp_scope.change` 已实现；通讯录自动绑定、调岗或离岗引起的部门/角色变更记录 `member.directory_profile.change`，批次记录 `member.directory.sync`；
- `authorization.denied` 已由统一异常过滤器覆盖 JWT、RBAC 和对象级 403；
- 管理配置与定时任务变更。

### P0：核心法务业务

- 咨询/工单核心修改、转派、取消、升级和人工回传已实现；创建、认领、每条消息仍可继续细化；
- 合同/咨询记录与附件下载已实现；合同生成、审查、删除仍需继续统一；
- 技能审批全生命周期；
- 法律检索请求、证据门禁结果和人工转交。

### P1：AI 与供应商

- 咨询 AI/DSH 运行开始、完成、取消、失败已实现；
- 模型版本、工具调用摘要、证据 trace、输出哈希已实现；token/成本仍待 DSH telemetry 接入；
- 百鉴、钉钉等供应商业务状态；
- 定时任务运行和投递结果。

### P1：数据访问

- 敏感附件、合同和咨询记录的查看/下载；
- 批量导出、管理员检索和审计日志导出。

普通页面浏览不建议全部记录为业务审计，否则噪声和隐私成本过高；只有敏感资源访问、导出和管理操作进入审计。

## 8. 查询、权限和留存

管理端 API `/admin/audit-logs` 当前支持：

- 时间、操作者、动作、资源、结果、reasonCode、requestId/correlationId 筛选；
- `/admin/audit-logs/stats` 复用相同数据范围和筛选条件，按 action/outcome/reasonCode 返回分组次数；
- 通过 projectId/correlationId/ConsultationRun 关联受限 AI 执行摘要；前端跳转页尚未实现；
- 默认隐藏 Prompt、合同正文、附件内容、凭据和完整工具结果；
- 查询操作产生 `audit.read`；审计日志导出接口尚未实现；
- 不提供编辑或删除按钮。

已按 `security/admin/business/ai` 四类配置留存。对应环境变量为 `AUDIT_RETENTION_SECURITY_DAYS`、`AUDIT_RETENTION_ADMIN_DAYS`、`AUDIT_RETENTION_BUSINESS_DAYS`、`AUDIT_RETENTION_AI_DAYS`。未配置时 `expiresAt=null`，表示技术系统不自行删除；具体年限仍须由法务、信息安全和公司制度共同确认，本报告不假定法定期限。

## 9. 实施方案

### 阶段 A：统一事件底座

1. ✅ 新增 `AuditEvent`、有界 JSON、终端指纹哈希和写入服务；
2. ✅ 将 requestId 注入首批领域命令上下文；
3. 🟡 已覆盖登录、成员手动/自动绑定与目录权限变更、工单核心状态和下载；技能审批仍保留 `SkillReviewLog`，尚未双写 `AuditEvent`；
4. ✅ 已建立 eventId、actor/time、action/outcome/time、resource/time、project/time、request/correlation 和留存索引；
5. ✅ 已增加成员、工单、AI/人工关联和事件完整性单元测试；真实 MySQL 迁移/事务集成仍需在部署环境执行。

### 阶段 B：DSH 关联

1. 🟡 首先扩展 `ConsultationRun`，合同生成/审查 Run 的统一 `AIExecution` 视图仍待实现；
2. ✅ 咨询链路已记录 DSH Session、模型版本、工具摘要、证据 trace 和输出哈希；
3. telemetry receiver 以 `(sessionId, eventSeq)` 去重；
4. 在采集边界完成 Prompt、附件、身份证号、手机号和凭据脱敏；
5. 管理端只展示摘要，需要专项权限才能读取受限 trace。

### 阶段 C：篡改检测与归档

1. 事件分区摘要或哈希链；
2. 独立账号、不可变归档、恢复演练；
3. 留存到期和法律保全流程；
4. 审计导出、访问审计和异常告警。

## 10. 验收标准

- 任意核心状态变更都能查到 actor、action、resource、outcome、requestId 和时间；
- 数据库事务失败时不会出现“成功”的孤立审计记录；
- 同一个 DSH 回答可以从工单追到 `ConsultationRun`、证据摘要和受限 trace；
- 审计页面不泄露合同正文、Prompt、凭据或完整附件；
- 失败登录、权限拒绝、管理员解绑、批量导出均可检索和告警；
- telemetry 丢失不会导致业务审计记录丢失；
- 审计导出和 trace 查看本身也可追踪。

### 10.1 本次验收状态

| 标准 | 状态 | 说明 |
| --- | --- | --- |
| 核心状态变更具备 actor/action/resource/outcome/requestId/time | 通过（首批命令） | 成员、工单核心变更和下载已覆盖 |
| 事务失败不会留下成功孤立审计 | 通过/部分 | 同事务链路通过；升级、登录投影和部分失败路径仍需收敛 |
| DSH 回答可追到 Run、模型、工具、证据和人工处理 | 通过（咨询链路） | `humanAuditEventId` 反向关联人工回传 |
| 审计事件不泄露正文、Prompt、凭据或附件 | 通过 | 正文只留哈希；IP、User-Agent、登录账号只留哈希；JSON 超限只留摘要 |
| 登录失败、权限拒绝、管理员解绑、下载可检索/统计 | 通过 | action/outcome/reasonCode 可组合筛选，`/stats` 返回分组次数 |
| telemetry 丢失不导致业务审计丢失 | 通过（已接业务埋点部分） | 权威事件由 LegalOS DB 写入，不依赖 DSH telemetry |
| 防篡改和防删除 | 部分 | 字段完整性可验；整行删除证明、数据库权限和 WORM 待部署 |

## 11. 最终结论

- 原有专项日志继续保留；统一 `AuditEvent` 已作为业务审计权威入口接入首批关键链路；
- 当前实现已经能够回答本报告开头列出的六类问题中的主体部分，但不是全部生命周期事件都已覆盖；
- DSH Trace 是 AI 行为证据，不是业务审计系统；
- 正确方案仍是“业务 AuditEvent + AI Execution/DSH Trace + 运维 OTel”三层协同；下一步优先完成生产 HMAC/留存配置、数据库最小权限、审计导出、合同/技能/定时任务全生命周期和不可变归档。
