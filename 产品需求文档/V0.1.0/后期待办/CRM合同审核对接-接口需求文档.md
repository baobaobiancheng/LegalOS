# CRM 合同审核对接 — 一期接口契约文档(v4)

> 依据:`CRM合同审核对接与法务任务转派需求说明.doc`(沟通稿)
> 读者:**CRM 系统开发团队**
> 版本:v4(2026-08-31)——按双方约定:**谁暴露接口,谁出规范**。
> 范围:**一期** = 推送建单 + 审核完成文件回传。转派处理人同步列入二期(见 §三)。
> 实现状态(2026-08-31):**A1 专属 Controller、流式 multipart、HMAC/时间戳/nonce/IP 白名单校验、CAS 处理人映射、多文件正文抽取与原子建单、幂等冲突、DOCX 解压资源防护、法务确认文件绑定、CRM 交付状态/Outbox 已完成代码实现**;A1 待执行数据库迁移、注入环境密钥/IP 白名单并与 CRM 联调。B1 真实适配仍受 CRM 接收接口文档阻塞。

## 〇、核心分工(本次修订的关键)

接口规范按如下分工定义:

| 接口 | 方向 | 规范由谁定义 | 对方要做什么 |
|------|------|--------------|--------------|
| A1 推送建单 | CRM → 法务平台 | **法务平台定义**(见本文档 §一) | **CRM 按本文档实现调用** |
| B1 文件回传接收 | 法务平台 → CRM | **CRM 定义** | **CRM 提供接收接口文档,法务平台按其适配** |

- **A1 入站接口**:法务平台定义地址、方法、鉴权、字段、回执、幂等,**CRM 无需新开发接收端,只需按规范调用**。
- **B1 回传接口**:法务平台只列出**需要回传的内容**,具体地址/方法/鉴权/格式由 **CRM 定义**,请 CRM 提供接口文档后法务平台对接。
- 鉴权(已定):签名方案,见 §1.2。

---

## 一、A1 推送建单接口(CRM → 法务平台)

### 1.1 基本信息

| 项 | 值 |
|----|----|
| 地址 | `POST http://192.168.162.170:3000/api/crm/v1/contract-tasks`(联调/生产环境内网地址,以实际部署为准) |
| 方法 | `POST` |
| Content-Type | `multipart/form-data`(建单数据 + 合同文件一起提交,见 §1.4) |
| 认证 | 签名鉴权,见 §1.2 |
| 时间戳 | Unix **Epoch 秒(UTC)**,服务器允许 ±300 秒偏差 |

### 1.2 鉴权与签名

请求头固定带 **7 个字段**(其中 6 个参与签名),`Secret` **绝不出现在请求里**:

| 请求头 | 谁生成 | 说明 |
|--------|--------|------|
| `X-App-Id` | 法务平台分配(CRM 保存) | 固定,标识 CRM 应用;验签通过后由服务端持久化为 `sourceAppId` |
| `X-Timestamp` | CRM 每次请求现生成 | Unix 秒,与服务器时间差 > 5 分钟拒绝 |
| `X-Nonce` | CRM 每次请求现生成 | 随机串(建议 UUID),同一 AppId 下已用过的 nonce 拒绝(防重放) |
| `X-Idempotency-Key` | CRM 每次审核任务生成 | **必填**,值 = `payload.crmTaskId`(见 §1.7),建单幂等键;**纳入签名**防篡改 |
| `X-Payload-SHA256` | CRM 现算 | `payload` 部分内容(JSON 字符串)UTF-8 字节的 SHA-256,小写 hex |
| `X-File-Manifest-SHA256` | CRM 现算 | 文件清单规范 JSON 的 SHA-256,见下 |
| `X-Signature` | CRM 现算 | 签名,见下 |

**设计要点**:签名只依赖 `payload` 内容与每个文件各自的哈希,**不依赖 multipart 的 boundary / 换行 / part 头**——这些字节在不同语言(Java/Node 等)的 multipart 实现下不保证一致,且服务端解析后也拿不到原始请求体。按本方案各语言可稳定对齐。

**文件清单(fileManifest)**:每个上传文件生成一项。`index` = 该文件在其 part 名下的出现顺序(**按请求中该 part 的先后顺序分配,从 0 开始,同一 `partName` 内不重复**);数组按 `partName` 升序、再按 `index` 升序;每项键顺序固定为 `partName → index → originalName → size → sha256`;紧凑 JSON(无多余空格)、UTF-8、无 BOM。`originalName` 为上传文件名(UTF-8,≤128 字符);`size` 为文件原始字节数;`sha256` 为文件原始字节的小写十六进制摘要。

```
fileManifest = [
  {"partName":"files","index":0,"originalName":"合同正文.docx","size":102400,"sha256":"a1b2..."},
  {"partName":"files","index":1,"originalName":"附件.pdf","size":204800,"sha256":"c3d4..."}
]
X-File-Manifest-SHA256 = SHA256(上述紧凑 JSON 的 UTF-8 字节)
```

> **JSON 规范化**:按上述"固定字段顺序 + 排序规则"实现(方案①)。

**签名算法**:

```
message = "v1" + "\n"
        + method + "\n"
        + path + "\n"
        + X-App-Id + "\n"
        + X-Timestamp + "\n"
        + X-Nonce + "\n"
        + X-Idempotency-Key + "\n"
        + X-Payload-SHA256 + "\n"
        + X-File-Manifest-SHA256
X-Signature = HMAC-SHA256(Secret, message) 的十六进制小写
```

- `message` 首行 `v1` 为**签名版本**,算法演进时保留旧版本兼容。
- `method`:转为 ASCII 大写,如 `POST`
- `path`:固定的原始路径 `/api/crm/v1/contract-tasks`,不含 scheme / host / port / fragment。
- **一期不使用 query string**:请求携带任何 query 参数 → 400 `UNSUPPORTED_QUERY`。不能一边允许 query、一边不把它纳入签名(query 可被篡改);未来需要 query 时,把规范化 query 一并纳入签名。
- `X-Payload-SHA256` = multipart 中 `name="payload"` **部分内容**(JSON 字符串)的原始 UTF-8 字节 SHA-256,小写 hex。**不含** boundary、part 头、前后 CRLF、整个 HTTP body。
- **payload 部分声明**:part 头固定为 `Content-Disposition: form-data; name="payload"` 与 `Content-Type: application/json; charset=UTF-8`。
- **客户端**只序列化一次 payload → 转 UTF-8 字节 → 对该组字节算哈希 → 将**完全相同的字节**作为 payload part 发出;**服务端直接对收到的 payload part 原始字节算哈希,不得先解析成对象再 `JSON.stringify()` 重算**(字段顺序/数值格式可能变化)。

**签名示例**(假值,仅演示拼串规则):

```
method          = POST
path            = /api/crm/v1/contract-tasks
X-App-Id        = crm-legal-01
X-Timestamp     = 1723700000
X-Nonce         = a8f3c2b9-4d5e-4f6a-8b7c-1d2e3f4a5b6c
X-Idempotency-Key = task-10086
payload         = {"contractNo":"HT20260810-001", ...}   (payload 字段内容)
X-Payload-SHA256 = 3f9c2e...
X-File-Manifest-SHA256 = 7d1a5b...
message         = "v1\nPOST\n/api/crm/v1/contract-tasks\ncrm-legal-01\n1723700000\na8f3c2b9-...\ntask-10086\n3f9c2e...\n7d1a5b..."
X-Signature     = 8b7c4d...(HMAC-SHA256 hex)
```

**鉴权失败响应**:HTTP 401/403 + 错误码,见 §1.6。

**服务端配置**:

| 变量 | 说明 |
|------|------|
| `CRM_A1_ENABLED` | `true` 才开放 A1;未启用时返回 503 |
| `CRM_A1_APP_ID` | 分配给 CRM 的单应用 AppId,必须与 `X-App-Id` 一致 |
| `CRM_A1_SECRET` | HMAC 密钥,至少 32 个 UTF-8 字节,仅通过受管 Secret 注入,不入库/日志/代码库;可用 `openssl rand -base64 32` 生成 |
| `CRM_A1_ALLOWED_IPS` | 逗号分隔的直连源 IP;生产环境启用 A1 时必填 |

服务端只使用 TCP socket 源 IP 匹配白名单,不直接信任可伪造的 `X-Forwarded-For`;如后续增加受信网关,需单独配置受信代理边界。

**服务端校验顺序**:先校验 AppId、源 IP、时间窗口和请求头 HMAC,验签成功后立即原子占用 nonce,再读取 multipart 请求体并核对实际 payload/文件摘要。无效签名和已重放 nonce 不会触发大文件写盘;头部验签通过后即使请求体格式或摘要错误,nonce 也保留至过期,修正后必须换新 nonce 重发。

### 1.3 请求体字段(建单数据)

**结构**:multipart 表单,一个 `payload` **表单字段**为 JSON 字符串;文件通过独立的多媒体 part 上传(part 定义见 §1.4.1)。`payload` JSON 字段如下(必填 = 建单必需;打 **【待联调】** 的表示需 CRM 确认是否能提供;文件类字段仅为说明,实际走文件 part):

| 分类 | 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|------|
| 合同及流程 | `sourceAppId` | string | 服务端派生 | 值取验签通过的 `X-App-Id`;CRM **不在 payload 重复传入**,避免两处不一致 | `crm-legal-01` |
| | `crmTaskId` | string | 是 | CRM 审核任务实例 ID,一次审核任务的业务主键;必须与 `X-Idempotency-Key` 一致 | `task-10086` |
| | `contractNo` | string | 是 | 合同业务编号,用于展示/查询;**不用于区分审阅轮次**(见 §4.1) | `HT20260810-001` |
| | `contractApplyType` | string | 是 | 申请类型枚举 | `NEW` / `RENEW` / `CHANGE` |
| | `contractType` | string | 是 | 合同类型 | `NORMAL` 普通 / `SUPPLEMENT` 补充协议 |
| | `currentAuditStatus` | string | 是 | 当前审核状态 | `法务审核中` |
| | `currentAuditNode` | string | 是 | 当前审核节点 | `法务审核` |
| | `currentNodeAssignee` | string | 是 | **当前节点处理人 = 公司 CAS 账号**;服务端按 trim + 小写查找已启用的 `legal_bp/legal_lead/admin`,并映射为 `creator/owner/legalBp` | `junfang.zhao` |
| | `applicant` | string | 是 | 合同申请人 | `张伟` |
| | `auditHistory` | array&lt;object&gt; | 否【待联调】 | 审核节点历史意见 `{node, assignee, opinion, time}` | — |
| 客户及主体 | `customerName` | string | 是 | 客户主体 | `某某科技有限公司` |
| | `signSubject` | string | 是 | 我方签约主体 | `我司全称` |
| | `productType` | string | 否【待联调】 | 产品类型 | — |
| | `relatedBizInfo` | string | 否【待联调】 | 关联业务信息 | — |
| | `bizRemark` | string | 否【待联调】 | 商务备注 | — |
| 合同信息 | `contractStartDate` | string(date) | 否 | 合同开始时间 | `2026-08-10` |
| | `contractEndDate` | string(date) | 否 | 合同结束时间 | `2027-08-09` |
| | `useOurTemplate` | boolean | 否【待联调】 | 是否使用我司模板 | `true` |
| 文件 | `files`(文件 part) | multipart part | 是 | 待审核合同文件,重复同名 part 表示数组(≥1,见 §1.4.1) | — |
| | `fileVersion` | string | 否【待联调】 | 文件版本 | `v1.0` |
| | `attachments`(文件 part) | multipart part | 否 | 已有合同附件,重复同名 part,最多 5 个(见 §1.4.1) | — |
| 补充协议 | `mainContractNo` | string | 条件必填 | 主合同编号 | — |
| | `mainContractFile`(文件 part) | multipart part | 条件必填 | 主合同文件,单 part(见 §1.4.1) | — |
| | `mainContractUrl` | string | 条件必填 | 主合同访问链接 | — |

**补充协议规则**:`contractType = SUPPLEMENT` 时,`mainContractNo` / `mainContractFile` / `mainContractUrl` **至少提供其一**;三者都缺 → HTTP 409 `INCOMPLETE_DATA`,平台提示资料不完整。`mainContractUrl` 只做格式校验和持久化,一期服务端**不主动下载**;需进入审查上下文的主合同应使用 `mainContractFile` 上传。

### 1.4 文件传输

- **已定**:一期 **建单与合同文件一次 multipart 提交**(`payload` 字段 + 文件 part),避免"先建单再传文件"的两步失败补偿。
- **每个文件单独计算 SHA-256**(服务端流式计算),用于签名清单(§1.2),不依赖 multipart 序列化。
- 补充协议主合同:随文件上传 或 提供访问链接,二选一。

> **实现状态**:A1 已按本节实现“建单 + 多文件一次提交”;线上可用性以数据库迁移、`CRM_A1_*` 密钥/IP 配置和联调验收完成为准。

### 1.4.1 multipart part 定义

| part 名 | 含义 | 出现方式 | 数量 |
|---------|------|----------|------|
| `payload` | 建单元数据 JSON 字符串(§1.3 字段表) | 表单字段 | 1,必填 |
| `files` | 待审核合同文件 | **重复同名 part 表示数组**(每个 part 一个文件) | ≥1 |
| `attachments` | 已有合同附件 | 重复同名 part | 0..5 |
| `mainContractFile` | 补充协议主合同文件 | 单 part | 0..1,条件必填 |

- **文件与清单对应**:每个文件 part 带 `filename`(原文件名,UTF-8,≤128 字符)。§1.2 文件清单每项 `partName` = 该文件所属 part 名(`files`/`attachments`/`mainContractFile`),`index` = 该 part 名下的出现顺序,`originalName` = 该 part 的 filename,`size`/`sha256` = 该文件内容。
- **服务端验签核对**:逐个流式计算实际文件 SHA-256,并确认:实际文件数量与清单一致;每项 `partName`/`index`/`originalName`/`size` 与实际接收一致;每个实际文件摘要与清单 `sha256` 一致;清单不允许多项、少项或重复项。任何不一致 → 401 `INVALID_SIGNATURE`。
- **数量与大小**:单文件 ≤ 20MB;总文件数 ≤ 10;请求总大小 ≤ 100MB。服务端对无 `Content-Length` 的 chunked 请求仍按实际流量计数。
- **校验规则**:
  - 扩展名白名单 `.docx / .pdf / .txt / .md`(不信任 mimetype,与平台现有规则一致),不匹配 → 422 `FILE_VALIDATION_FAILED`;
  - 空文件(size=0)→ 422 `FILE_VALIDATION_FAILED`;
  - 同名文件:允许(以 `sha256` 区分);完全重复(相同 sha256 重复上传)→ 422 `FILE_VALIDATION_FAILED`;
  - DOCX/PDF/TXT/MD 上传时必须抽取出非空正文,成功后统一写入可审查 `ContractDocument`;
  - 加密/损坏/纯扫描无文字 PDF、损坏 DOCX、非 UTF-8 TXT/MD → 422 `FILE_VALIDATION_FAILED`,不落库、不保留业务文件;
  - DOCX 解压资源限制:非目录 entry 数 ≤ 1,000、单 entry 解压后 ≤ 20MB、单个 DOCX 累计解压后 ≤ 50MB;任一超限 → 422 `FILE_VALIDATION_FAILED`。该限制独立于上传文件 20MB 和合并正文 100,000 字符限制。

**文件落库与审查上下文**:

- 原文件分别落库为 `source`(`files`) / `attachment`(`attachments`) / `main_contract`(`mainContractFile`),不得作为 B1 法务确认回传版本;
- 四种格式都必须抽取出非空正文;抽取正文总量超过 **100,000 个 Unicode 字符** → 422 `FILE_VALIDATION_FAILED`;
- 按 `files → mainContractFile → attachments` 顺序、以文件类别和文件名边界合并为一个 `ContractDocument(type=source)`,作为默认审查文档。

### 1.5 响应与回执

**成功(HTTP 200)**:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "projectId": "2f8a...-uuid",
    "sourceAppId": "crm-legal-01",
    "crmTaskId": "task-10086",
    "contractNo": "HT20260810-001",
    "idempotencyKey": "task-...",
    "duplicated": false
  }
}
```

字段说明:
- `projectId`:法务平台工单 ID,回传文件时带回
- `sourceAppId`:验签通过的 CRM 应用 ID
- `crmTaskId`:本次 CRM 审核任务实例 ID,是跨系统业务主键
- `contractNo`:合同业务编号,非审核任务主键
- `idempotencyKey`:与请求 `X-Idempotency-Key` 一致
- `duplicated`:true = 该任务此前已建单(幂等重复),返回原 `projectId`

### 1.6 错误响应与错误码

**统一错误响应体**(与法务平台现有统一错误响应一致):

```json
{
  "error": "错误说明",
  "code": "INVALID_PARAM",
  "statusCode": 400,
  "requestId": "8f3c...-request-id"
}
```

- `error`:可读错误说明
- `code`:机器错误码(见下表)
- `statusCode`:HTTP 状态码
- `requestId`:请求关联 ID,排查问题时提供给法务平台

| HTTP | code | 含义 | CRM 侧处理 |
|------|------|------|-----------|
| 200 | 0 | 成功(含幂等重复建单) | — |
| 400 | `INVALID_PARAM` | 参数校验失败(缺必填/枚举非法/JSON 解析失败) | 按响应 `error` 修参,不重试 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 缺少 `X-Idempotency-Key` | 补审核任务实例 ID 后重发 |
| 400 | `UNSUPPORTED_QUERY` | URL 携带 query 参数(一期不允许) | 去掉 query 后重发 |
| 401 | `INVALID_SIGNATURE` | 签名不匹配 | 核对签名算法/Secret,不重试 |
| 401 | `EXPIRED_TIMESTAMP` | 时间戳超时(>5 分钟) | 校时钟,重发 |
| 401 | `REPLAYED_NONCE` | nonce 已使用(重放) | 换新 nonce,重发 |
| 403 | `FORBIDDEN_APP` | AppId 无权限/IP 不在白名单 | 联系法务平台 |
| 409 | `INCOMPLETE_DATA` | 补充协议缺主合同 | 补主合同后重发 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 key 但请求内容不同(误用任务 ID) | 核对任务 ID:新请求换新 ID,或原样重发原请求 |
| 409 | `ASSIGNEE_INVALID` | `currentNodeAssignee` 未开通、已停用或不是法务角色 | 先在 LegalOS 完成 CAS 人员开通/角色配置后,使用新 nonce 重发 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体或单文件超过限制(≤20MB) | 压缩或减少文件后重发;一期不支持分片协议 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type 非 multipart/form-data | 修正请求头后重发 |
| 422 | `FILE_VALIDATION_FAILED` | 文件格式不支持(仅 .docx/.pdf/.txt/.md) | 转换格式后重发 |
| 429 | `TOO_MANY_REQUESTS` | 调用频率超限 | 退避后重试 |
| 500 | `INTERNAL_ERROR` | 平台内部错误 | 稍后重试(建议退避) |
| 503 | `SERVICE_UNAVAILABLE` | 平台暂不可用或 A1 未启用 | 核对环境配置后退避重试 |

### 1.7 幂等(防重复建单)

- `X-Idempotency-Key` **必填**:缺失 → HTTP 400 `IDEMPOTENCY_KEY_REQUIRED`,不建单;**参与签名**(§1.2),防止该键在传输中被篡改。
- 取值 = **`payload.crmTaskId` = CRM 审核任务实例 ID**(每次法务审核任务的唯一标识),**不是合同编号**——同一合同可能多轮审核(续签 / 变更 / 退回重提),用合同编号会把新任务错误并入旧工单。
- **幂等语义**:
  - 同一 key + 同一请求内容(指纹一致)→ 返回已存在工单(`duplicated: true`,带原 `projectId`),**不重复建单**;
  - 同一 key + 不同请求内容(指纹不一致)→ HTTP 409 `IDEMPOTENCY_CONFLICT` 拒绝,由 CRM 排查是否误用同一任务 ID。
- **请求指纹** = `X-Payload-SHA256` + `X-File-Manifest-SHA256`(复用 §1.2 签名头,不另造)。
- 平台分别持久化 `crmPayloadSha256`、`crmFileManifestSha256`;命中同一 `sourceAppId + crmTaskId` 时逐项比对。任一不同即返回 409 `IDEMPOTENCY_CONFLICT`,不得覆盖旧工单或静默按重复成功处理。
- 服务端以 `sourceAppId + "\\0" + crmTaskId` 计算 SHA-256,派生内部幂等键 `crm:{digest}`;不同应用/系统的任务 ID 互不冲突,原始业务标识仍分别持久化。
- 业务数据库持久化 `sourceAppId + crmTaskId + contractNo + projectId`;`sourceAppId + crmTaskId` 唯一,`contractNo` 可在多轮审核中重复。
- 【待联调】:CRM 侧任务实例 ID 的稳定性与生成规则。

### 1.8 重试

- 5xx / 超时:建议退避重试(如 3 次,间隔 1s/5s/30s),平台侧有兜底对账。
- 4xx:按错误码修正后换新 nonce 重发,**不盲目重试**。

---

## 二、B1 文件回传接收接口(法务平台 → CRM)

### 2.1 分工(已约定)

法务平台审核/修订合同完成后,把最终文件回传给 CRM,CRM 归档并推动流程继续。**本接口由 CRM 侧定义**(地址、方法、鉴权、格式、限制)。

> **本期阻塞项**:请 CRM 提供**接收接口文档**(URL、方法、鉴权方式、文件格式/大小限制、回执与错误码)。法务平台拿到文档后按其对接,无需 CRM 再动。

### 2.2 回传内容(由 CRM 确定,以下仅供参考)

回传接口由 **CRM 定义**,字段、格式、限制以 CRM 提供的接收接口文档为准。以下为我方**可回传**的数据,供 CRM 设计接口时参考:

| 数据 | 说明 |
|------|------|
| 关联键 | `sourceAppId + crmTaskId`(主) + `contractNo + projectId`(辅助),供 CRM 精确定位本次审核任务 |
| 审核文件 | 法务确认版 / 修订版 合同文件 |
| 文件类型 | `CONFIRMED` 确认版 / `REVISED` 修订版 |
| 完成时间 | 法务完成审核时间 |
| 审核结论摘要 | 简短结论(可选) |

> 文件传输已定:直接 multipart 上传,**不走对象存储中转**。

**确认文件绑定**:CRM 任务完成时,法务必须明确选择一个由 `legal_bp / legal_lead / admin` 角色上传的 `final/revised` 文件。平台将其 ID 持久化为 `crmDeliveryFileId`,Outbox 只携带该 ID;Worker 消费时再次校验工单绑定和上传者角色,不得按“最新文件”自动猜测。

### 2.3 审核完成与 CRM 交付状态

两类状态必须独立,不得用一个“已回传”同时表示内部完成与外部送达:

| 维度 | 状态 | 含义 |
|------|------|------|
| 法务审核 | `reviewStatus=review_completed` | 法务已完成审核/修订,结论和定稿已在 LegalOS 内部落库;Legacy `Project.status=已回传` 仅作兼容,不代表 CRM 已送达 |
| CRM 交付 | `pending` | 审核完成事务已写入 CRM Outbox,尚未调用 CRM |
| | `sending` | Worker 已认领并正在调用 CRM |
| | `delivered` | 仅在收到 CRM 成功回执后设置 |
| | `failed` | 本次调用失败,按 Outbox 退避重试;不回退内部审核完成状态 |
| | `dead` | 超过重试上限,保留最后错误并需人工重放 |

**原子性要求**:法务完成事务内同时写入 `reviewStatus=review_completed`、`crmDeliveryFileId`、`crmDeliveryStatus=pending` 和唯一 Outbox 事件;事务提交后才由 Worker 调用 CRM。CRM 接收端须按 `sourceAppId + crmTaskId` 幂等,以容忍 Worker 超时后重试。

**文件存储要求**:B1 Worker 需按 Outbox 中的 `contractFileId` 读取定稿。单实例可使用本地持久卷;多实例 API/Worker 必须挂载同一共享 `CONTRACT_STORAGE_DIR`,否则非上传实例认领事件后会因文件不可见而失败。

> **实现状态**:上述本地状态、Outbox 和重试/死信已完成代码实现;真实 CRM Adapter 仍等待 B1 接口文档。未显式开启 `CRM_MOCK=true` 时,Mock 不会返回假成功。

---

## 三、二期:C1 转派处理人同步

**场景**:法务在平台内把任务转派给另一名法务,同步更新 CRM 当前未完成的法务审核节点处理人(已完成历史节点不变)。

**此项列入二期,不在本期契约范围。** 二期开工前需确认业务价值与 CRM 是否支持外部变更处理人。二期时按本节约定:法务平台 → CRM,**由 CRM 定义**。

---

## 四、数据打通

### 4.1 跨系统关联键(最重要)

| 标识 | 归属 | 职责 |
|------|------|------|
| **`sourceAppId`** | 法务平台从已验签 `X-App-Id` 派生 | 外部来源系统命名空间;CRM 不在 payload 重复传入 |
| **`crmTaskId`** | CRM 提供值 | **跨系统审核任务主键**;与 `sourceAppId` 组合唯一,同时是幂等键来源;A1/B1 都必须带 |
| **合同编号 `contractNo`** | CRM 提供值 | 合同业务编号,供展示/查询;同一合同多轮审核时可重复,不承担任务唯一性 |
| **`projectId`** | 法务平台 | 平台内部工单 ID,回传时带出,辅助排查 |

> 审阅轮次由每次唯一的 `crmTaskId` 区分,不再延后到二期;`contractNo` 无需全局唯一。**【待联调】**:`crmTaskId` 在退回重提/重新进入法务节点时的生成规则。

### 4.2 幂等

同 §1.7:`X-Idempotency-Key` **必填且必须等于 `payload.crmTaskId`**;服务端以 `sourceAppId + crmTaskId` 定位业务任务,请求指纹复用 §1.2 签名头;同一 key + 异内容 → 409。**【待联调】**:CRM 任务实例 ID 的生成规则、幂等记录保存周期。

### 4.3 文件与主合同

- 推送时合同文件**随建单一起 multipart 上传**(§1.4,已定)。
- 补充协议主合同:随行文件 或 访问链接,二选一。
- 文件格式/大小限制:平台现支持 `.docx/.pdf/.txt/.md` ≤ 20MB,四种格式均在上传时抽取非空正文并写入 `ContractDocument`;暂不支持 OCR。

---

## 五、数据流图

```
【一期目标链路(◆=待联调;●=已实现、待部署验收)】

CRM                                            LegalOS
 │ A1 推送建单(法务平台定义)                       │
 │   POST /api/crm/v1/contract-tasks               │
 │   签名7头 + multipart(payload JSON + 文件)        │
 │   X-Idempotency-Key 幂等 ◆                       │
 │ ─────────────────────────────────────────────▶ [● 专属入站已实现,待部署联调]
 │   sourceAppId+crmTaskId+合同编号+处理人+文件 ◆     │
 │                                                │ ② 建单 → projectId 落库,任务主键关联
 │                                                │ ③ 法务审核/修订
 │ ◀──────────────────────────────────────────────┘
 │ B1 回传文件(CRM 定义)◇ CRM 提供接口文档
 │   crmTaskId+合同编号+projectId+文件+类型+时间 ◆
 │   review_completed → pending/sending → delivered ▲
 │ ⑥ 归档,流程继续
 │
 │ ── 二期:C1 转派同步(CRM 定义,本期不做)──▶
```

```
【失败与重试】A1:5xx/超时退避重试、4xx 按码修正;平台幂等兜底,不重复建单。
B1:回传失败 → `crmDeliveryStatus=failed` 并由 Outbox 重试;超限 → `dead` + 人工重放。`review_completed` 不回退,但不得展示为“已送达”。
```

---

## 六、待双方确认清单

| # | 问题 | 状态/我方倾向 | 需确认方 | 阻塞一期? |
|---|------|--------------|----------|-----------|
| 1 | **人员身份统一**:法务平台已接入公司 CAS,`currentNodeAssignee` 直接用公司 CAS 账号 | ✅ **已解决**(法务平台已接入) | — | 否 |
| 2 | 鉴权方式 | ✅ **已定**:签名方案(7 头:AppId/Timestamp/Nonce/Idempotency-Key/Payload-SHA256/Manifest-SHA256/Signature,§1.2) | — | 否 |
| 3 | 入站地址 | ✅ **已定**:`POST http://192.168.162.170:3000/api/crm/v1/contract-tasks`(以实际部署为准) | — | 否 |
| 4 | 推送字段集 | ✅ 按本文档 §1.3 定义;CRM 提供不了的可选字段请标注,联调删减 | CRM | 否 |
| 5 | **B1 回传接收接口文档**(URL/方法/鉴权/格式/回执) | ⬜ **请 CRM 提供**,法务平台按其适配 | **CRM** | **是** |
| 6 | `contractNo` 取值规则 | 仅作业务编号,允许多轮审核重复;不再作为任务主键 | CRM | 否 |
| 7 | 任务主键/幂等键:`sourceAppId + crmTaskId`;`X-Idempotency-Key = payload.crmTaskId`;B1 必须回传 `crmTaskId` | **CRM 确认能否提供稳定任务实例 ID** | 双方 | 是 |
| 8 | 文件格式/大小/数量/同名处理 | .docx/.pdf/.txt/.md ≤20MB 均抽取正文;PDF 不含 OCR;附件≤5、总文件≤10、请求≤100MB、相同 SHA-256 拒绝、合并正文≤100,000 字符;DOCX entry≤1,000、单 entry 解压≤20MB、累计解压≤50MB | 双方 | 否 |
| 9 | 推送失败补偿/对账(孤儿工单处理) | A1 幂等 + 5xx 退避重试 | 双方 | 否 |
| 10 | 生命周期对账:取消/退回补充/重复审阅/多轮修订/部分成功 | 每次审核用新 `crmTaskId` 建单;取消/退回事件协议仍待确认 | 双方 | 是 |
| 11 | 审核完成与 CRM 交付状态 | 已拆分 `review_completed` 与 `pending/sending/delivered/failed/dead`;法务确认文件通过 `crmDeliveryFileId` 显式绑定;Outbox 已实现,真实 Adapter 待 B1 文档 | CRM+法务 | 是 |
| 12 | 标准协议:错误码/超时/限流/回执/重放窗口/时区 | 按 §1.2/§1.6 约定,联调细调 | 双方 | 否 |
| 13 | C1 转派同步业务价值与可行性 | 二期,开工前确认 | CRM+法务 | 否(二期) |

**结论一句话**:一期 CRM 只需做两件事——**按本文档 §一实现 A1 推送调用**;并**提供 B1 回传接收接口文档**(B1 由 CRM 定义,法务平台适配)。转派同步列二期。

### 6.1 当前剩余建设责任

| 类别 | 剩余事项 | 责任方 | 是否可立即开发 |
|------|----------|--------|----------------|
| 我方部署/联调 | A1 Controller、流式 multipart、HMAC/时间戳/nonce/IP 白名单、CAS 映射、统一回执已实现;需注入 `CRM_A1_*` 配置并与 CRM 完成签名样例对齐 | LegalOS/运维 | 是 |
| 我方部署/联调 | A1 多文件建单/文件/合并正文事务和失败清理已实现;需部署迁移、验证共享存储和联调文件边界 | LegalOS/运维 | 是 |
| 我方开发 | 数据库迁移部署、共享 `CONTRACT_STORAGE_DIR`、Outbox 监控/死信告警/人工重放 | LegalOS/运维 | 是 |
| 我方开发 | B1 真实 CRM Adapter、multipart 回传、鉴权、超时和业务回执判定 | LegalOS | **否,等待 CRM B1 文档** |
| 我方设计 | A1 映射已定:`currentNodeAssignee` 作为 creator/owner/legalBp,`applicant` 作为展示申请人;三类上传文件按固定顺序合并为 source 审查包 | LegalOS 产品+研发 | 已完成 |
| 双方设计 | `crmTaskId` 在退回重提/重新进入法务节点时是否生成新值;取消、撤回、重开和多轮修订协议 | CRM+LegalOS | 需联调前确认 |
| CRM 提供 | B1 URL、方法、鉴权、multipart 字段、成功业务码、幂等规则、大小限制、超时和错误码 | CRM | 是,B1 阻塞项 |
| CRM 开发 | 按 A1 契约生成稳定任务 ID、签名头和文件清单并调用 LegalOS;对 409/4xx/5xx 分类处理 | CRM | A1 服务可用后联调 |

---

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | — | 初版,仅字段清单 |
| v2 | 2026-08-11 | 明确分工(谁暴露谁出规范);A1 出正式接口规范(地址/方法/鉴权签名/字段/回执/幂等/错误码);B1 明确由 CRM 定义,列回传内容需求;CAS 已接入(处理人=公司 CAS 账号) |
| v3 | 2026-08-31 | 消除合同编号与审核任务主键冲突:`sourceAppId + crmTaskId` 为任务主键,`contractNo` 仅业务号;持久化并比对 payload/file manifest 指纹;B1 必须回传 `crmTaskId`;拆分内部审核完成与 CRM 交付状态,法务显式绑定 `crmDeliveryFileId`,Outbox 成功回执后才标记 delivered;明确 DOCX/PDF/TXT/MD 均抽取正文且无 OCR;标注 A1/B1 真实联调边界和剩余责任 |
| v4 | 2026-08-31 | A1 服务端实现同步:流式 multipart、HMAC/时间戳/nonce/IP 校验、CAS 处理人映射、多文件原子建单与失败清理;固定文件数量/大小/重复指纹/正文上限和 DOCX 解压资源上限;明确 source/attachment/main_contract 落库类型、合并审查包顺序、`mainContractUrl` 仅记录不下载、`ASSIGNEE_INVALID` 错误码及部署联调前置条件 |
