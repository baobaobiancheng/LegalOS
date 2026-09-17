# 法务 AI 平台（Legal Workbench）技术架构方案

> 版本：V2.0 | 日期：2026-07-30 | 状态：待评审

---

## 一、架构总览

### 1.1 核心原则

| 原则 | 说明 |
|------|------|
| **全栈 TypeScript** | AI 能力通过 Codex CLI 调用，后端无需 Python，前后端语言统一 |
| **表单优先** | 前端框架选择以表单开发效率为第一优先级 |
| **渐进上线** | 工单闭环 + 钉钉打通 + Skill 库先上，数字分身和知识库后上 |
| **单体起步** | NestJS 模块化单体，目录结构天然支持后续拆微服务 |
| **外部能力代理** | 知识库（v0.2.0）、数字分身（v0.2.0）、LLM 均为外部系统，本平台只做配置管理和 API 代理 |

### 1.2 技术选型

| 层 | 选型 | 选型理由 |
|----|------|----------|
| 前端 | **Vue 3.4 + Element Plus** | 60% 页面是表单型，Vue 表单代码量是 React 的 1/3 |
| 后端 | **NestJS + TypeScript** | 装饰器声明式 RBAC（Guards）、切面审计（Interceptors）、模块化开箱即用 |
| ORM | **Prisma** | TypeScript 原生，NestJS 一等公民，迁移比 TypeORM 简洁 |
| 数据库 | **MySQL 8.0** | 标准 CRUD + 简单聚合，JSON 类型够用，国内运维成熟 |
| AI 引擎 | **Codex CLI** (`codex exec`) | 已验证 v0.146.0，模型 gpt-5.6-luna，LLM/DOCX 处理统一走 CLI |
| 类型共享 | **NestJS 自动生成 OpenAPI** | 后端 Swagger module → 前端 `openapi-typescript` |


---

## 二、系统架构全景

```
┌─────────────────────────────────────────────────────────────────┐
│                         Nginx :80/:443                          │
│             静态资源 (/assets/*) + API 反向代理 (/api/*)          │
└───────────────┬─────────────────────────────┬───────────────────┘
                │                             │
       /assets/*                             │
                ▼                             │
┌──────────────────────┐                      │
│   Vue 3 SPA（三端）   │                      │
│                      │                      │
│  Element Plus 组件    │                      │
│  Pinia 客户端状态      │                      │
│  Vue Router 路由守卫   │                      │
│  ECharts 数据看板      │                      │
└──────────────────────┘                      │
                                              │
                ┌─────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────┐
│                      NestJS :3000                                │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ AuthModule │  │ProjectModule│  │ SkillModule│  │AdminModule│ │
│  │ · 登录     │  │ · 工单CRUD │  │ · 技能列表 │  │ · 用户管理 │ │
│  │ · JWT签发  │  │ · 状态机   │  │ · 技能匹配 │  │ · 基础看板 │ │
│  │ · RBAC守卫 │  │ · 消息流   │  │             │  │ · 定时任务 │ │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘ │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────────┐ │
│  │ LegalModule│  │BusinessMod │  │ CodexService               │ │
│  │ · 法规检索 │  │ · 法律咨询 │  │ · codex exec 统一调用       │ │
│  │ · NPC 集成 │  │ · 合同助手 │  │ · prompt 模板管理           │ │
│  └────────────┘  └────────────┘  │ · 流式输出 (SSE)            │ │
│                                  └────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ v0.2.0 模块（暂不开发）：KnowledgeModule / TwinModule       │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 中间件（全局）                                               │ │
│  │  · RolesGuard（RBAC 装饰器）                                 │ │
│  │  · AuditInterceptor（审计日志切面）                           │ │
│  │  · HttpExceptionFilter（统一错误响应）                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 外部集成（Adapter 模式）                                     │ │
│  │  · 钉钉 Webhook → 拉群/消息通知（v0.0.1）                    │ │
│  │  · CRM REST API → 客户/商机上下文（v0.0.1）                  │ │
│  │  · 知识库 API → HTTP 代理转发（v0.2.0）                     │ │
│  │  · 李帅数字分身 API → HTTP 代理转发（v0.2.0）               │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬───────────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
    ┌──────────┐      ┌──────────────┐      ┌──────────┐
    │ MySQL 8  │      │  Codex CLI   │      │ 外部系统  │
    │ :3306    │      │  codex exec  │      │ 知识库    │
    └──────────┘      │  gpt-5.6-luna│      │ 数字分身  │
                      └──────────────┘      │ 钉钉/CRM  │
                                            └──────────┘
```

---

## 三、前端架构详设

### 3.1 技术栈

| 层面 | 选择 | 说明 |
|------|------|------|
| 框架 | Vue 3.4 Composition API `<script setup>` | 原生 TS，比 Options API 更灵活 |
| 构建 | Vite 6 | 已是最优解 |
| UI 组件库 | **Element Plus 2.9** | 表单/穿梭框/上传/表格全部内置 |
| 状态管理 | **Pinia** | Vue 官方 store，比 Vuex 轻 50% |
| 路由 | **Vue Router 4** | 三端 route groups + 导航守卫 |
| 服务端缓存 | **TanStack Query (Vue)** | API 缓存 + 乐观更新 + SSE 流式数据 |
| 图表 | **ECharts 6** | 数据看板 |
| 类型 | `openapi-typescript` 自动生成 | 后端 Swagger → 前端 `.d.ts` |

### 3.2 项目结构

```
legal-workbench-web/
├── src/
│   ├── api/
│   │   ├── schema.d.ts       # openapi-typescript 自动生成
│   │   └── client.ts         # fetch 封装 + JWT 注入
│   ├── router/
│   │   ├── index.ts          # 路由定义
│   │   └── guards.ts         # roleGuard
│   ├── stores/               # Pinia
│   │   ├── auth.ts
│   │   └── projects.ts
│   ├── views/                # 页面（按端分组）
│   │   ├── auth/LoginView.vue
│   │   ├── legal/            # 法务端 7 个页面
│   │   ├── business/         # 业务端 3 个页面
│   │   └── admin/            # 管理端 4 个页面
│   ├── components/           # 共享组件
│   └── styles/               # Element Plus 主题变量
```

### 3.3 三端路由

| 路由 | 角色 | 页面 |
|------|------|------|
| `/login` | 所有人 | 统一登录 |
| `/legal/projects` | 法务 | 工单列表（首页） |
| `/legal/projects/:id` | 法务 | 工单对话详情 |
| `/legal/research` | 法务 | 法规检索 |
| `/legal/skills` | 法务 | 技能库 |
| `/legal/knowledge` | 法务 | 知识库（代理外部） |
| `/legal/knowledge/insights` | 法务 | 知识沉淀 |
| `/legal/twin-studio` | 法务 | 数字分身配置 |
| `/business/consult` | 业务 | 法律咨询（首页） |
| `/business/contract` | 业务 | 合同助手 |
| `/business/records` | 业务 | 我的记录 |
| `/admin/dashboard` | 管理员 | 数据看板（首页） |
| `/admin/users` | 管理员 | 用户管理 |
| `/admin/automations` | 管理员 | 定时任务 |
| `/admin/templates` | 管理员 | 合同模板管理 |

---

## 四、后端架构详设

### 4.1 项目结构

```
legal-workbench-api/
├── package.json
├── tsconfig.json
├── nest-cli.json
├── prisma/
│   ├── schema.prisma         # 数据模型
│   └── migrations/           # 迁移脚本
│
├── src/
│   ├── main.ts               # NestFactory + Swagger + ValidationPipe
│   │
│   ├── common/               # 共享基础设施
│   │   ├── guards/
│   │   │   └── roles.guard.ts          # @Roles('admin') 装饰器 + Guard
│   │   ├── interceptors/
│   │   │   └── audit.interceptor.ts    # 操作审计切面
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts
│   │   └── decorators/
│   │       ├── roles.decorator.ts      # @Roles()
│   │       └── current-user.decorator.ts # @CurrentUser()
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts    # POST /login, /refresh, GET /me
│   │   │   ├── auth.service.ts       # JWT 签发/验证
│   │   │   └── dto/                  # LoginDto, TokenResponseDto
│   │   │
│   │   ├── project/
│   │   │   ├── project.module.ts
│   │   │   ├── project.controller.ts # CRUD + 转派 + 取消
│   │   │   ├── project.service.ts    # 状态机 + 路由规则
│   │   │   ├── message.controller.ts # 消息流 (SSE)
│   │   │   └── dto/
│   │   │
│   │   ├── legal/
│   │   │   ├── legal.module.ts
│   │   │   ├── legal.controller.ts   # POST /research
│   │   │   └── legal.service.ts      # NPC 检索 + codex exec
│   │   │
│   │   ├── business/
│   │   │   ├── business.module.ts
│   │   │   ├── business.controller.ts # POST /consult, /contract
│   │   │   └── business.service.ts    # 风险判定 + codex exec + 外部代理
│   │   │
│   │   ├── knowledge/
│   │   │   ├── knowledge.module.ts
│   │   │   ├── knowledge.controller.ts # CRUD（代理外部知识库 API）
│   │   │   └── knowledge.service.ts    # API 转发 + 本地脱敏
│   │   │
│   │   ├── admin/
│   │   │   ├── admin.module.ts
│   │   │   ├── admin.controller.ts     # 用户管理 + 看板 + 审计日志
│   │   │   ├── admin.service.ts
│   │   │   └── automation.service.ts   # 定时任务引擎
│   │   │
│   │   └── codex/
│   │       ├── codex.module.ts
│   │       ├── codex.service.ts        # child_process.exec('codex exec ...')
│   │       └── prompts/                # prompt 模板文件 (*.md)
│   │
│   └── prisma/
│       ├── prisma.module.ts            # 全局 PrismaService
│       └── prisma.service.ts
```

### 4.2 NestJS 模块依赖图

```
AppModule
  ├── PrismaModule (global)
  ├── AuthModule
  ├── ProjectModule → PrismaModule, CodexModule
  ├── LegalModule   → CodexModule
  ├── BusinessModule → CodexModule, KnowledgeModule
  ├── KnowledgeModule → PrismaModule  (本地配置 + 外部 API 代理)
  ├── AdminModule   → PrismaModule
  └── CodexModule   → (无依赖，纯 child_process)
```

### 4.3 核心 API 设计

```
# ── 认证 ──
POST   /api/auth/login             # { username, password } → { accessToken, refreshToken }
POST   /api/auth/refresh           # { refreshToken } → { accessToken }
GET    /api/auth/me                # 当前用户 + 角色 + 菜单权限

# ── 工单 ──
GET    /api/projects               # 列表 (?status=&kind=&page=&size=)
POST   /api/projects               # 创建
GET    /api/projects/:id           # 详情
PATCH  /api/projects/:id           # 更新（状态/转派/风险）
POST   /api/projects/:id/messages  # 发送消息 → SSE 流式响应
POST   /api/projects/:id/cancel    # 取消工单

# ── 法规检索 ──
POST   /api/legal/research         # { query } → { answer, sources[] }

# ── 业务咨询 ──
POST   /api/business/consult       # { query, twinProfileId } → SSE 流式

# ── 合同助手 ──
POST   /api/business/contract      # { templateId, requirements } → projectId

# ── 知识库（代理转发） ──
GET    /api/knowledge              # → 外部知识库 API
POST   /api/knowledge              # → 外部知识库 API（含本地脱敏）

# ── 数字分身（配置管理） ──
GET    /api/twin-profiles
PUT    /api/twin-profiles/:id      # 更新配置（版本+1）
POST   /api/twin-profiles/:id/test # 试运行 → codex exec

# ── 管理端 ──
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:id
GET    /api/admin/dashboard        # 看板数据聚合
GET    /api/admin/audit-logs       # 操作审计
GET    /api/admin/automations      # 定时任务
```

### 4.4 RBAC 权限模型

```typescript
// 角色枚举
enum Role {
  LEGAL_BP     = 'legal_bp',      // 法务 BP：工单处理 + 法规检索 + 技能库 + 知识库
  LEGAL_LEAD   = 'legal_lead',    // 法务负责人：法务 BP 权限 + 数字分身配置 + 知识审核
  BUSINESS     = 'business',       // 业务人员：法律咨询 + 合同助手 + 我的记录
  ADMIN        = 'admin',          // 管理员：用户管理 + 看板 + 定时任务
}

// 声明式权限控制
@Controller('projects')
export class ProjectController {
  @Get()
  @Roles(Role.LEGAL_BP, Role.LEGAL_LEAD)   // 法务端可查看工单列表
  async list(@CurrentUser() user: User) {}

  @Patch(':id')
  @Roles(Role.LEGAL_BP, Role.LEGAL_LEAD)   // 法务端可更新工单
  async update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {}

  @Post(':id/transfer')
  @Roles(Role.LEGAL_LEAD)                   // 只有法务负责人可以转派
  async transfer(@Param('id') id: string, @Body() dto: TransferDto) {}
}
```

### 4.5 Codex CLI 调用设计

> **⚠️ 并发实测结论**：使用第三方中转 API 无官方速率限制。本机 14 核 / 16GB 实测 30 并发全过（102s），单个进程消耗约 15-30MB。`max_threads = 6` 配置仅影响单会话内部子 Agent，外部 `codex exec` 多进程不受此限。并发上限完全取决于机器资源，本机预估可支撑 50-100 并发。**生产务必加信号量控制，避免高峰期耗尽内存。**

```typescript
// src/modules/codex/codex.service.ts
import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const execAsync = promisify(exec)

@Injectable()
export class CodexService {
  private semaphore: Promise<void>[] = []
  private maxConcurrency: number

  constructor(private config: ConfigService) {
    // CODEX_CONCURRENCY 环境变量控制最大并发，默认 20
    this.maxConcurrency = Number(this.config.get('CODEX_CONCURRENCY', 20))
  }

  /** 获取信号量许可，积压时排队等待 */
  private async acquire(): Promise<void> {
    while (this.semaphore.length >= this.maxConcurrency) {
      await Promise.race(this.semaphore)
    }
    const promise = new Promise<void>((resolve) => {
      this.semaphore.push(promise as any)
      // 这里用简化写法，生产建议用 p-limit 或 async-mutex
    })
  }

  private release(): void {
    this.semaphore.shift()
  }

  async execute(prompt: string, options?: { model?: string }) {
    await this.acquire()
    try {
      const modelFlag = options?.model ? `-m ${options.model}` : ''
      const { stdout } = await execAsync(
        `codex exec --skip-git-repo-check ${modelFlag} "${prompt}"`,
        { maxBuffer: 1024 * 1024, timeout: 120_000 }
      )
      return stdout
    } finally {
      this.release()
    }
  }

  /** SSE 流式调用 */
  executeStream(prompt: string, model?: string): ChildProcess {
    const modelFlag = model ? `-m ${model}` : ''
    return spawn('codex', ['exec', '--skip-git-repo-check', modelFlag, prompt])
  }
}
```

```bash
# .env 配置
CODEX_CONCURRENCY=20   # 根据机器资源调整，建议不超过内存(MB) / 30
```

---

## 五、数据库设计

### 5.1 Prisma Schema（MySQL 8.0）

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum Role {
  legal_bp
  legal_lead
  business
  admin
}

enum ProjectKind {
  consult
  contract
  research
  draft
}

enum ProjectStatus {
  分析中
  待处理
  待复核
  已回传
  已取消
}

enum RiskLevel {
  P0
  P1
  P2
}

model User {
  id            String   @id @default(uuid())
  username      String   @unique @db.VarChar(64)
  passwordHash  String   @map("password_hash") @db.VarChar(256)
  displayName   String   @map("display_name") @db.VarChar(128)
  role          Role
  department    String?  @db.VarChar(128)
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  projects      Project[]        @relation("ProjectOwner")
  legalProjects Project[]        @relation("LegalBP")
  knowledgeItems KnowledgeItem[]
  twinProfiles  TwinProfile[]
  auditLogs     AuditLog[]
  satisfactionRatings SatisfactionRating[]

  @@map("users")
}

model Project {
  id                  String        @id @default(uuid())
  kind                ProjectKind
  title               String        @db.VarChar(256)
  status              ProjectStatus @default(分析中)
  risk                RiskLevel     @default(P2)
  route               String        @default("legal") @db.VarChar(32)
  source              String        @default("LegalOS") @db.VarChar(32)
  owner               User          @relation("ProjectOwner", fields: [ownerId], references: [id])
  ownerId             String        @map("owner_id")
  legalBp             User?         @relation("LegalBP", fields: [legalBpId], references: [id])
  legalBpId           String?       @map("legal_bp_id")
  creator             User          @relation(fields: [creatorId], references: [id])
  creatorId           String        @map("creator_id")
  requesterName       String?       @map("requester_name") @db.VarChar(128)
  requesterDepartment String?       @map("requester_department") @db.VarChar(128)
  skill               String?       @db.VarChar(128)
  knowledgeScope      String        @default("enterprise") @map("knowledge_scope") @db.VarChar(32)
  model               String?       @db.VarChar(128)
  deliveryMode        String?       @map("delivery_mode") @db.VarChar(32)
  twinProfileVersion  Int?          @map("twin_profile_version")
  twinReview          String?       @map("twin_review") @db.VarChar(32)
  twinReviewNote      String?       @map("twin_review_note") @db.Text
  learningStatus      String?       @default("未沉淀") @map("learning_status") @db.VarChar(32)
  crmReference        String?       @map("crm_reference") @db.VarChar(256)
  createdAt           DateTime      @default(now()) @map("created_at")
  updatedAt           DateTime      @updatedAt @map("updated_at")

  messages      ProjectMessage[]
  attachments   Attachment[]
  satisfactionRatings SatisfactionRating[]

  @@map("projects")
}

model ProjectMessage {
  id        String    @id @default(uuid())
  project   Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  projectId String    @map("project_id")
  role      String    @db.VarChar(32)   // inbound, user, assistant, legal, event
  text      String    @db.Text
  label     String?   @db.VarChar(256)
  createdAt DateTime  @default(now()) @map("created_at")

  @@map("project_messages")
}
```

### 5.2 ER 关系

```
users ──┬── projects (creator)
        ├── projects (owner)
        ├── projects (legal_bp)
        ├── knowledge_items
        ├── twin_profiles
        ├── audit_logs
        └── satisfaction_ratings

projects ──┬── project_messages (1:N)
           ├── attachments (1:N)
           └── satisfaction_ratings (1:N)
```

---

## 六、部署架构

### 6.1 单机部署

```yaml
# docker-compose.yml（开发/测试环境）
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: legal_workbench
    ports: ["3306:3306"]
    volumes:
      - mysql_data:/var/lib/mysql

  api:
    build: .
    ports: ["3000:3000"]
    depends_on: [mysql]
    environment:
      DATABASE_URL: mysql://root:${DB_ROOT_PASSWORD}@mysql:3306/legal_workbench
      JWT_SECRET: ${JWT_SECRET}
```

```bash
# 启动命令
pnpm prisma migrate deploy   # 数据库迁移
pnpm prisma generate          # 生成 Prisma Client
pnpm build                    # 编译 NestJS
node dist/main.js             # 启动
```

### 6.2 Nginx 配置

```nginx
server {
    listen 80;
    server_name legal.example.com;

    # Vue 3 静态资源
    location /assets/ {
        root /opt/legal-workbench/web/dist;
        expires 30d;
    }

    # NestJS API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;  # SSE 流式需要关闭缓冲
    }

    # SPA fallback
    location / {
        root /opt/legal-workbench/web/dist;
        try_files $uri /index.html;
    }
}
```

---

## 七、AI 调用链路

```
业务人员提问
  │
  ▼
Vue 3 → POST /api/business/consult  (SSE)
  │
  ▼
NestJS BusinessService
  ├── 1. 风险判定（关键词匹配）
  ├── 2. 外部知识库 API 检索（如已对接）
  └── 3. CodexService.execute(prompt)
        │
        ▼
      child_process.exec('codex exec ...')
        │  prompt 中包含：
        │  · 业务咨询 instruction
        │  · 用户问题
        │  · 数字分身配置（名称/人设/口径/授权范围）
        │  · 知识库检索结果
        │  · 对话历史
        │
        ▼
      Codex CLI (gpt-5.6-luna) → 流式输出
        │
        ▼
      SSE → 前端逐字渲染
```

---

## 八、迁移路径

| 阶段 | 周期 | 内容 |
|------|------|------|
| **Phase 1：骨架** | 2 周 | NestJS 项目 + Prisma + MySQL + JWT 认证 + Vue 3 + Element Plus + 三端路由 + 登录页 |
| **Phase 2：核心** | 3 周 | 工单 CRUD + 状态机 + 业务咨询 SSE + 法规检索 + Codex CLI 集成 |
| **Phase 3：增强** | 2 周 | 数字分身配置 + 合同助手 + 定时任务 + 数据看板 + 审计日志 |
| **Phase 4：对接** | 2 周 | 知识库 API 代理 + 李帅分身 API + 钉钉 Webhook + CRM 对接 |
| **Phase 5：交付** | 1 周 | 性能优化 + 安全加固 + 文档 |

---

## 九、与当前代码的关系

| 当前资产 | 处理 |
|----------|------|
| React App.tsx（386 行） | 废弃，Vue 3 重写。业务逻辑参考 |
| Express server/（~300 行） | 废弃，NestJS 重写。AI Pipeline 和状态机逻辑参考 |
| 产品需求文档 | 保留，Phase 规划输入 |
| Codex CLI v0.146.0 | ✅ 已验证可用，直接集成 |
