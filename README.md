# 法务AI平台 · Legal Workbench

> v0.0.1 — 统一登录与权限管理 + 三端 Apple 风格 UI

## 架构

```
LegalPlatform/
├── api/                     # NestJS 后端 (TypeScript)
│   ├── prisma/              # 数据模型 + 迁移 + 种子
│   └── src/
│       ├── modules/auth/    # 认证模块（JWT + RBAC）
│       ├── common/          # 守卫 / 装饰器 / 过滤器
│       └── prisma/          # 数据库服务
├── web/                     # Vue 3 前端 (TypeScript)
│   └── src/
│       ├── views/           # 页面（按端分组）
│       ├── stores/          # Pinia 状态
│       ├── router/          # 路由 + 守卫
│       └── api/             # HTTP 客户端（JWT 注入 + refresh 拦截）
└── package.json             # 工作区脚本
```

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + Pinia + Vue Router 4 + 纯 CSS (Apple 风格) |
| 后端 | NestJS + Prisma + passport-jwt + bcrypt |
| 数据库 | MySQL 8.0 |
| 认证 | JWT 双 Token（accessToken 15min 内存 + refreshToken 24h httpOnly cookie） |

## 快速启动

### 1. 环境准备

- Node.js 18+
- MySQL 8.0+
- 复制 `api/.env.example` → `api/.env`，修改数据库密码

### 2. 创建数据库

```sql
CREATE DATABASE legal_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 安装 + 迁移 + 种子

```bash
# 安装根依赖
npm install

# 安装前后端依赖 + 数据库迁移 + 种子用户
npm run setup
```

### 4. 启动

```bash
# 开发模式（前后端同时启动）
npm run dev

# 仅后端（生产）
npm run build && npm start
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:3000
- Swagger 文档：http://localhost:3000/api（后续版本）

## 种子账号

| 用户名 | 密码 | 角色 | 首页 |
|--------|------|------|------|
| `admin` | `admin123` | 管理员 | /admin/dashboard |
| `legal_bp` | `legal123` | 法务 BP | /legal/projects |
| `legal_lead` | `legal123` | 法务负责人 | /legal/projects |
| `business` | `biz123` | 业务人员 | /business/consult |

## API 端点

```
POST   /api/auth/login     # 登录（速率限制 5/分钟）
POST   /api/auth/refresh   # 刷新 accessToken
GET    /api/auth/me         # 当前用户
POST   /api/auth/logout     # 退出
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | MySQL 连接串 | — |
| `JWT_SECRET` | JWT 签名密钥 | — |
| `PORT` | API 端口 | `3000` |
| `WEB_ORIGIN` | 前端地址 (CORS) | `http://localhost:5173` |

## 下一步

- [ ] 工单/项目管理模块（Phase 2）
- [ ] Swagger API 文档 + openapi-typescript 类型同步
- [ ] 自动化测试（vitest + supertest）
- [ ] 钉钉 / CRM Adapter 真实对接
