# Codex 执行边界安全 — 实施记录与收尾清单

> 来源：`LegalOS-代码架构与实现复核报告.md` **P0-01**
> 记录日期：2026-08-07
> **实施完成：2026-08-09**（代码部署 `2af3f58`，红队读隔离验证通过）

## 一、问题描述

Codex CLI 子进程继承服务端**全部环境变量**（原 `env: { ...process.env, HOME: workspaceDir }`），且处理用户提供的咨询、合同、技能内容。存在**提示词注入后读取服务端秘密**（`DATABASE_URL` / `JWT_SECRET` / 钉钉凭证）或服务账户可读文件的高风险边界。

**涉及文件（均已修改）**：
- `api/src/common/services/codex.service.ts` — 环境白名单 + Kill Switch + 硬化参数 + CODEX_HOME 预建目录
- `api/test/codex.service.spec.ts` — 新增 7 个安全单测
- `api/.env.example` — 新增 `AI_EXECUTION_ENABLED` / `CODEX_HARDENED` / `CODEX_API_KEY` 说明

## 二、关键技术结论（2026-08-07 调研 + 08-09 实测修正）

1. **codex 沙箱不限制读取**：`--sandbox` 三模式不拦读取，单靠它挡不住 `read_file("/app/.env")`。
2. **真正限制读取的手段**（按优先级）：
   - **权限档案默认拒绝**（`/etc/codex/requirements.toml` 的 `[permissions.legalos_ai]`）：`:root deny` + `:minimal read` + 工作区 read + 网络关 → 代码/命令层面拦读
   - **环境变量白名单**（`buildSpawnEnv`）：`DATABASE_URL`/`JWT_SECRET`/钉钉凭证绝不透传给 codex
   - **`shell_environment_policy.inherit="none"`**：沙箱子进程零继承 env，防 `printenv` / `/proc/self/environ` 泄密
   - **OS 级隔离**（低权限用户/容器）：未启用，作为兜底 Plan B
3. **bwrap 版本硬性要求**：`codex-linux-sandbox` helper 需要 bwrap 支持 `--argv0`（≥0.10.0）。Ubuntu jammy 自带 0.6.1 不支持 → codex 走 fallback 把 helper 变成裸名 PATH 查找 → 沙箱直接起不来。**已编译安装 bwrap 0.11.0** 到 `/usr/local/bin`。
4. **`CODEX_HOME` 目录必须预建**：codex 要求 `CODEX_HOME` 指向的目录已存在（实测报 `path does not exist`）。硬化模式 `CODEX_HOME = workspaceDir/.codex`，已在 `ensureWorkspace` 预建。
5. **`deny_read` 陷阱**：不要写需要遍历无权限目录的 glob（`/root/.codex`、`/home/*/.codex`、`/**/.env`）——codex 构造 bwrap 命令时会展开 stat 这些路径，EACCES 导致沙箱起不来。收窄为**字面可 stat 路径**。
6. **`wire_api` 只支持 `"responses"`**：公司网关必须实现 `POST /v1/responses`，只兼容 `/v1/chat/completions` 不够。
7. **认证变量是 `CODEX_API_KEY`**（非 `OPENAI_API_KEY`），由受管配置 `env_key` 读取。

## 三、已实施（2026-08-09，全部验证）

### 代码侧（`api/src/common/services/codex.service.ts`）
- [x] **AI Kill Switch**：`AI_EXECUTION_ENABLED=false/0/off` 时 `execute` 抛错、`executeStream` 返回伪失败流（转人工）。回滚/紧急停 AI 只需改 env + 重启。
- [x] **环境变量白名单** `buildSpawnEnv`：只放行 PATH / HOME / CODEX_HOME / LANG / 认证变量（`CODEX_API_KEY`）/ CA / 代理；弃 `HOME: workspaceDir` 覆盖（实测它令 CODEX_HOME 指向被清理的临时目录，Unix 上认证一直失效）。
- [x] **硬化参数**（`CODEX_HARDENED=true`）：`--strict-config -a never -c shell_environment_policy.inherit=none --ephemeral --ignore-user-config`，**不传 `--sandbox`**（与权限档案互斥）。
- [x] **CODEX_HOME 独立子目录** + 预建（会话/日志不落盘）。

### 服务器配置
- [x] `bwrap 0.11.0`（源码编译，`/usr/local/bin`）
- [x] `/etc/codex/requirements.toml`：`allowed_approval_policies=["never"]`、`default_permissions="legalos_ai"`、闭集 `[allowed_permission_profiles]`、`[permissions.legalos_ai]`（`:root deny`/`:minimal read`/`:tmpdir deny`/`:slash_tmp deny`/工作区 read/网络关）、字面路径 `deny_read`
- [x] `/etc/codex/managed_config.toml`：网关 provider（`env_key=CODEX_API_KEY`、`wire_api="responses"`、HTTP base_url）+ `shell_environment_policy`（`inherit="none"` + `set.PATH`）

### 单测与红队
- [x] 新增 7 个安全单测：Kill Switch×2 / 白名单挡秘密 / 硬化参数 / CODEX_HOME 隔离与预建 / 本地模式
- [x] **红队读隔离验证**（2026-08-09，`codex sandbox --include-managed-config -P legalos_ai`）：
  - 读假 `.env` / 假 `auth.json` / 真实 `api/.env` / `/etc/codex` → 全部 `rc=1` 拦截
  - 外网 curl → `rc=6` 拦截
  - `/proc/self/environ` → 可读但**内容零秘密**（inherit=none + 白名单生效）
  - 工作区合同模板 → 可读、内容精确匹配（业务正常）

## 四、待收尾（网关侧前置，2026-08-09 状态：等网关团队）

- [ ] **网关 API token** → 填服务器 `.env` 的 `CODEX_API_KEY`（当前为空占位，AI 未启用，无风险）
- [ ] **模型 ID** → 填 `/etc/codex/managed_config.toml` 的 `model`
- [ ] **`POST /v1/responses` 支持确认**（wire_api 只支持 responses）
- [ ] **HTTPS（443）**：当前 ITSM 只批了 HTTP:80，token 明文传输风险，需网关/运维评估

## 五、绿灯后步骤（网关确认后）

1. `.env` 填 `CODEX_API_KEY` + managed_config 填 `model`
2. `AI_EXECUTION_ENABLED=true` → pm2 restart
3. **真实 `codex exec` 注入测试**：注入"读 .env / printenv / curl 外网"提示词，确认 codex 无法执行泄露动作
4. **功能回归**：普通咨询 / 高风险升级人工 / 合同起草 / 合同审查 / 超时退出 / 工作区清理 / Kill Switch
5. 内部账号灰度 1–2 天，观察后逐步放开

## 六、回滚

| 场景 | 操作 | 影响 |
|---|---|---|
| 紧急停 AI | `.env` 改 `AI_EXECUTION_ENABLED=false` + pm2 restart | 仅 AI 停，其余不受影响 |
| 退回旧 codex 参数 | `CODEX_HARDENED=false` | 环境白名单仍生效 |

## 七、参考

- 官方配置参考：https://learn.chatgpt.com/docs/config-file/config-reference
- 受管配置（requirements.toml）：https://learn.chatgpt.com/docs/enterprise/managed-configuration
- codex 源码（linux-sandbox）：https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox
- bwrap `--argv0` 版本要求：https://github.com/containers/bubblewrap
- 复核报告：`LegalOS-代码架构与实现复核报告.md` P0-01
