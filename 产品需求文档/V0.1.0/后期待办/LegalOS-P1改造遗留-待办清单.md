# LegalOS P1-01 至 P1-05 改造遗留 — 待办清单

> 来源：`28ee367`(P1-01..05) 代码评审(`/review`)遗留项 + 上线动作
> 最近复核日期：2026-08-10

## 一、评审遗留(代码级,P2,可上线后补)

- [x] **转派成员变更改走 Outbox**（2026-08-10）：`ProjectService.onLegalBpChanged` 写入 `dingtalk.member.add`，由 `OutboxWorker` 重读工单/用户后执行并带成员快照条件更新；不再请求内直接调用 `dingtalk.addMember`。
- [x] **Outbox Worker 配置注入**（2026-08-10）：事件文案的 Mock 判断改由 `ConfigService` 注入，不再在 Worker 处理中直读 `process.env.DINGTALK_MOCK`。
- [ ] **MySQL 集成测试未在当前环境闭环**：独立配置现可发现 2 个文件、9 个用例；本轮因未设置 `TEST_DATABASE_URL` 全部 skip。需在 CI/测试库补跑事务、唯一约束、Outbox 租约和合同版本用例。

## 二、上线动作(服务器,未执行)

- [ ] `git pull` 至 `28ee367`
- [ ] `cd api && npx prisma migrate deploy`(应用两个新 migration:`add_outbox_and_integration_state`、`add_contract_documents_and_review_runs`)
- [ ] `npm run build && pm2 restart legalos-api`
- [ ] 回填旧合同数据:`npx ts-node prisma/backfill-contract-documents.ts --dry-run` → 确认后实际执行(支持重复执行)
- [ ] 验证:新建 legalbp 工单 → Outbox Worker 异步建群(不再同步/不再 PENDING 哨兵);`admin/outbox` 运维接口可查状态

## 三、待网关/环境

- [ ] 网关审批后重跑 `codex review`(办公网连不上 api.openai.com,首次 Codex 评审超时)
- [ ] 权限矩阵产品确认:当前默认**法务 BP 不能互相转派、不能改未指派工单**;若产品要求放开需调整 `ProjectAccessPolicy`

---

# LegalOS P1-07 至 P1-12 改造遗留 — 待办清单

> 来源：`a287db9`(P1-07..12,跳过 P1-06)
> 记录日期：2026-08-09

## 四、P1-12 CI 遗留（代码门禁已补，首次 Runner 验收未完成）

- [x] ~~web 前端脚本~~ → **已完成**：web package.json 加 typecheck/test/test:e2e/lint；Playwright 依赖、配置和登录冒烟用例已建立，`npm test` 与 lint/typecheck/build 通过；本机 Chromium 下载/监听受环境限制，需 CI 首次执行。
- [x] ~~**ESLint 未实际跑通**~~ → **已完成(2026-08-09,commit 347a13b)**:api `npm run lint` 0 告警全绿(修了 2 个 require 错误 + 18 个未用变量警告;配置加 vars/caughtErrors ignore pattern)。CI `test:lint` 可正常门禁。
- [x] ~~web 的 eslint 配置~~ → **已完成(509d19d)**:vue flat config(修 .vue parser 顺序)+ web lint 0 告警。
- [x] ~~API MySQL 集成测试~~ → **部分完成(509d19d)**:本地已建 `legalos_test` 库 + 11 迁移全应用;**9/9 集成测试通过**(P1-03 事务原子/幂等、P1-10 升级、P1-11 规则、P1-09 审核、P1-07 自动绑定 + 3 唯一约束)。**仍缺**:通讯录失败批次不失效、合同多轮审查源文档绑定、上传授权(随 P1-06 跳)等行为用例。
- [x] ~~**E2E/Playwright 代码骨架缺失**~~ → **代码已完成**：`.gitlab-ci.yml` 安装 Chromium 后执行 `npm --prefix web run test:e2e`，已移除 `allow_failure`；尚缺 Runner 实际成功输出。
- [x] ~~audit 门禁~~ → **已完成(9758511)**:去掉 `|| true`,high/critical 漏洞使 Pipeline 失败。

## 五、P1-10 遗留（统一升级用例代码已完成）

- [x] ~~**升级 use-case 未全量接入**~~ → **已完成（2026-08-10）**：咨询首判、咨询追问升级、PATCH `llm→legalbp` 和合同 `submitReview` 均复用 `EscalateProjectToLegalUseCase`；仍需真实 MySQL 并发和钉钉环境验收。

## 六、上线动作(服务器,未执行)

- [ ] `git pull` 至 `a287db9`
- [ ] **迁移前先跑重复绑定检查**:`mysql legal_platform < api/prisma/check-duplicate-dingtalk-binding.sql`(只读),确认 `users.dingtalk_user_id` 无重复后再 `migrate deploy`(唯一索引才能建上)
- [ ] `cd api && npx prisma migrate deploy`(应用 `20260809130000_add_dingtalk_sync_skill_audit_risk_log`)
- [ ] `npm run build && pm2 restart legalos-api`
- [ ] 技能审计回填:`npx ts-node prisma/backfill-skill-review-logs.ts --dry-run` → 确认后执行(幂等)
- [ ] 验证:通讯录同步失败/不完整时旧快照不被失效;bind 撞唯一返回 409;合同 submitReview 不再发到 `contract-review` 假群
