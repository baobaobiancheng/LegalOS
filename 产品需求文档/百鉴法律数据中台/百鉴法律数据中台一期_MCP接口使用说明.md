# 百鉴法律数据中台一期 MCP 接口使用说明

> 文档版本：1.1  
> 编制日期：2026-07-03  
> 适用环境：线上环境  
> 服务范围：法律之星国内法规、Legal Data Hunter（LDH）全球法规与案例

## 1. 接入概览

### 1.1 MCP 地址

```text
POST https://mcpgateway.100credit.cn/mcp
```

### 1.2 鉴权请求头

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `X-App-Key` | 是 | 由数据中台分配的应用标识 |
| `X-App-Secret` | 是 | 由数据中台分配的应用密钥，请勿写入前端或提交到代码仓库 |
| `Content-Type` | 是 | 固定为 `application/json` |
| `Accept` | 建议 | 建议使用 `application/json, text/event-stream` |

应用方应向数据中台管理员申请独立的 App Key 和 App Secret。本文示例均使用占位符，不提供真实凭据。

### 1.3 通用调用格式

```json
{
  "jsonrpc": "2.0",
  "id": "request-001",
  "method": "tools/call",
  "params": {
    "name": "工具名称",
    "arguments": {}
  }
}
```

### 1.4 通用返回格式

网关当前把工具结果作为 JSON 字符串放在 `result.content[0].text` 中。接入方需要：

1. 先解析外层 JSON-RPC 响应；
2. 再把 `result.content[0].text` 解析为 JSON；
3. 法律之星接口还必须检查内层 `code`，不能只检查 HTTP 200 或 `isError=false`。

```json
{
  "jsonrpc": "2.0",
  "id": "request-001",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"code\":\"200\",\"msg\":\"查询成功\",\"data\":{}}"
      }
    ],
    "isError": false
  }
}
```

## 2. 一期工具清单

| 工具名称 | 数据源 | 业务能力 |
| --- | --- | --- |
| `lawstar_data_professional_query` | 法律之星 | 法规快捷搜索 |
| `lawstar_data_k_query` | 法律之星 | 法规高级搜索 |
| `lawstar_data_xl_query` | 法律之星 | 法律语义/向量搜索 |
| `lawstar_data_professional_detail` | 法律之星 | 根据法规 ID 获取法规全文详情 |
| `ldh_search` | LDH | 全球判例、法规和学说混合搜索 |
| `ldh_get_document` | LDH | 根据来源和来源内 ID 获取文档 |

推荐调用链：

```text
法律之星：query / k_query / xl_query → 取得 lawId → professional_detail
LDH：ldh_search → 取得 source + source_id → ldh_get_document
```

## 3. 法律之星接口

### 3.1 快捷搜索：lawstar_data_professional_query

快捷搜索同时匹配法规标题和正文，适合以一组关键词快速检索。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `page` | integer | 是 | 当前页，从 1 开始 |
| `rows` | integer | 是 | 每页条数 |
| `keyword` | string | 是 | 关键词；多个关键词用空格分隔 |
| `field` | string | 否 | 排序字段：`rDate` 发布日期、`lawlevel` 效力级别 |
| `fileNum` | string | 否 | 文号 |
| `depName` | string | 否 | 发文机关名称 |
| `startDate` | integer | 否 | 发布日期起始，格式 `yyyyMMdd` |
| `endDate` | integer | 否 | 发布日期截止，格式 `yyyyMMdd` |
| `startDate1` | integer | 否 | 实施日期起始，格式 `yyyyMMdd` |
| `endDate1` | integer | 否 | 实施日期截止，格式 `yyyyMMdd` |
| `depNumber` | string | 否 | 发文机关代码，例如 `[[401,1]]` |
| `areaNumber` | string | 否 | 区域代码，格式同 `depNumber`；全国查询不能同时包含省市 |
| `effective3` | string | 否 | 法规效力代码，多个代码用逗号分隔 |
| `timelinessnew` | string | 否 | `0` 尚未实施、`1` 现行有效、`2` 已失效、`3` 已修改、`4` 草案/征求意见稿；多个用逗号分隔 |
| `synonym` | string | 否 | `0` 关闭同义词搜索（默认），`1` 开启 |

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "lawstar-quick-001",
  "method": "tools/call",
  "params": {
    "name": "lawstar_data_professional_query",
    "arguments": {
      "page": 1,
      "rows": 10,
      "keyword": "民法典",
      "timelinessnew": "1"
    }
  }
}
```

#### 返回数据

内层结构为 `code / msg / data`。成功时 `code` 为字符串 `"200"`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.lawdata` | array | 法规结果列表 |
| `data.count` | integer | 命中总数 |
| `data.pageSize` | integer | 当前每页条数 |
| `data.totalPage` | integer | 总页数 |
| `data.lawdata[].lawId` | string | 法规唯一 ID，详情查询使用 |
| `data.lawdata[].lawName` | string | 法规名称；可能含 `<span>` 高亮标签 |
| `data.lawdata[].issuingOrgan` | string | 发文机关 |
| `data.lawdata[].issuingNo` | string | 文号 |
| `data.lawdata[].releaseYearMonthDate` | string | 发布日期 |
| `data.lawdata[].implementYearMonthDate` | string | 实施日期 |
| `data.lawdata[].timeliness` | string | 时效性中文名称 |

### 3.2 高级搜索：lawstar_data_k_query

高级搜索支持关键词组合、发文机关、地区、日期、效力和时效性等组合条件。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `page` | integer | 建议必填 | 当前页，默认 1 |
| `rows` | integer | 建议必填 | 每页条数，默认 5 |
| `keywords` | string | 是 | 关键词组合，例如 `0;民法典`；多关键词用空格分隔 |
| `searchtype` | integer | 否 | `0` 所有条件 AND，`1` 任意条件 OR，默认 1 |
| `field` | string | 否 | `rDate`、`lawlevel` 或 `fileNum` |
| `fileNum` | string | 否 | 文号 |
| `depName` | string | 否 | 发文机关名称，例如“国务院” |
| `startDate` | integer | 否 | 发布日期起始，`yyyyMMdd` |
| `endDate` | integer | 否 | 发布日期截止，`yyyyMMdd` |
| `startDate1` | integer | 否 | 实施日期起始，`yyyyMMdd` |
| `endDate1` | integer | 否 | 实施日期截止，`yyyyMMdd` |
| `depNumber` | string | 否 | 发文机关代码，例如 `[[401,1]]` |
| `areaNumber` | string | 否 | 区域代码，格式同 `depNumber` |
| `effective3` | string | 否 | 法规效力代码，多个用逗号分隔 |
| `timelinessnew` | string | 否 | `0` 尚未实施、`1` 现行有效、`2` 已失效、`3` 已修改、`4` 草案/征求意见稿；多个用逗号分隔 |

`keywords` 为必填参数；缺失时返回业务码 `"202"` 和“关键词不能为空！”。

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "lawstar-advanced-001",
  "method": "tools/call",
  "params": {
    "name": "lawstar_data_k_query",
    "arguments": {
      "page": 1,
      "rows": 10,
      "keywords": "0;民法典",
      "timelinessnew": "1"
    }
  }
}
```

返回字段与快捷搜索一致，位于 `data.lawdata`。

### 3.3 语义搜索：lawstar_data_xl_query

语义搜索适合用自然语言描述法律问题，并可叠加法规标题、机关、地区、条号、文号等过滤条件。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `rows` | integer | 否 | 返回条数，默认 10，最大 100 |
| `vector` | string | 条件必填 | 自然语言或向量检索文本 |
| `keyword` | string | 条件必填 | 标题关键词，多个用空格分隔 |
| `fbdwFacet` | string | 否 | 发文机关，例如“人民政府” |
| `lawstatexlsFacet` | string | 否 | 单个时效性：`0` 尚未实施、`1` 现行有效、`2` 已失效、`4` 已修改 |
| `areaFacet` | string | 否 | 适用地区，多个用空格分隔 |
| `topicsFacet` | string | 否 | 部委系统，例如“公安系统” |
| `rawnumber` | string | 否 | 条号 |
| `filenum` | string | 否 | 文号 |
| `xls` | string | 否 | 效力级别详细子类，多个用空格分隔 |

`vector` 与 `keyword` 至少应提供一个，也可以仅使用 `vector` 进行语义检索。

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "lawstar-semantic-001",
  "method": "tools/call",
  "params": {
    "name": "lawstar_data_xl_query",
    "arguments": {
      "rows": 5,
      "vector": "个人信息保护的法律规定",
      "lawstatexlsFacet": "1"
    }
  }
}
```

#### 返回数据

结果列表位于 `data.result`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lawId` | string | 法规 ID，可用于详情查询 |
| `lawName` | string | 法规名称 |
| `content` | string | 匹配条文或内容片段 |
| `score` | number | 语义相关度 |
| `issuingOrgan` | string | 发文机关 |
| `filenum` | string | 文号 |
| `releaseYearMonthDate` | string | 发布日期，格式为 `yyyyMMdd` |
| `implementYearMonthDate` | string | 实施日期，格式为 `yyyyMMdd` |
| `timeliness` | string | 时效性 |
| `xls` | string | 效力级别 |
| `topName` | string | 部委系统分类 |
| `rawnumber` | string | 条号 |
| `hisgroup` | array | 历史版本信息 |

### 3.4 法规详情：lawstar_data_professional_detail

根据搜索结果中的 `lawId` 获取法规元数据、HTML 正文、目录和下载路径。相同 `rjs8` 由中台缓存。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `rjs8` | string | 是 | 法规 ID，取自前三类搜索结果的 `lawId` |

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "lawstar-detail-001",
  "method": "tools/call",
  "params": {
    "name": "lawstar_data_professional_detail",
    "arguments": {
      "rjs8": "8F80C43687B13EA1FB8DB364A6245F49"
    }
  }
}
```

#### 返回数据

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.lawName` | string | 法规名称 |
| `data.rjs8` | string | 法规唯一 ID |
| `data.issuingOrgan` | string | 发文机关 |
| `data.releaseYearMonthDate` | string | 发布日期 |
| `data.implementYearMonthDate` | string | 实施日期 |
| `data.issuingNo` | string | 文号 |
| `data.timeliness` | string | 时效性 |
| `data.lawSourceContent` | string | 带 HTML 标签的法规正文 |
| `data.enclosure` | array | 附件列表 |
| `data.hisgroup` | array | 历史版本 |
| `data.hasCompare` | string | 是否存在版本比对能力 |
| `data.basisList` | array | 相关依据列表 |
| `data.anchorNumber` | string | 锚点信息 |
| `data.tocItem` | array | 法规目录 |
| `data.downdetailurl` | string | Word 下载相对路径 |
| `data.downdetailurlpdf` | string | PDF 下载相对路径 |

注意：当前下载字段返回相对路径，不是可直接访问的完整 URL。业务方如需下载原文件，应由数据中台确认并提供统一的下载域名或代理接口。

## 4. LDH 接口

### 4.1 全球法律搜索：ldh_search

支持对判例、法规和学说进行语义与关键词混合搜索。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 自然语言搜索问题 |
| `namespace` | string | 建议必填 | `case_law` 判例、`legislation` 法规、`doctrine` 学说 |
| `top_k` | integer | 否 | 返回数量，1–100，建议显式传入 |
| `alpha` | number | 否 | 语义权重，`1.0` 纯语义、`0.0` 纯关键词；一般建议 0.7 |
| `country` | array<string> | 否 | ISO alpha-2 国家代码或 `EU`、`UN`、`CoE` 等聚合代码 |
| `source` | array<string> | 否 | 数据源 ID，例如 `FR/Judilibre`、`FR/CNIL` |
| `court_tier` | integer | 否 | `1` 最高法院、`2` 上诉法院、`3` 初审法院 |
| `jurisdiction` | string | 否 | 管辖类型，例如 `civil`、`criminal` |
| `subdivision` | string | 否 | ISO 3166-2 行政区划，例如 `DE-BY`、`US-CA` |
| `date_start` | string | 否 | 起始日期，`YYYY-MM-DD` |
| `date_end` | string | 否 | 截止日期，`YYYY-MM-DD` |
| `language` | string | 否 | 语言代码，例如 `fr`、`de`、`en` |

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "ldh-search-001",
  "method": "tools/call",
  "params": {
    "name": "ldh_search",
    "arguments": {
      "query": "right to be forgotten personal data protection",
      "namespace": "case_law",
      "top_k": 5,
      "alpha": 0.7,
      "country": ["FR"],
      "source": ["FR/CNIL"],
      "language": "fr"
    }
  }
}
```

#### 返回数据

LDH 返回不使用法律之星的 `code/msg/data` 外壳。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string | 原搜索文本 |
| `hits` | array | 命中列表 |
| `total_hits` | integer | 返回的命中数量 |
| `elapsed_ms` | integer | LDH 内部查询耗时（毫秒） |
| `hits[].source` | string | 来源标识 |
| `hits[].source_id` | string | 来源内文档 ID |
| `hits[].score` | number | 相关度 |
| `hits[].country` | string | 国家代码 |
| `hits[].court` | string/null | 法院或机构名称 |
| `hits[].court_tier` | integer/null | 法院层级 |
| `hits[].date` | string/null | 判决或发布日期 |
| `hits[].language` | string/null | 语言代码 |
| `hits[].title` | string | 标题 |
| `hits[].snippet` | string | 摘要片段 |
| `hits[].url` | string | 原始来源链接 |
| `hits[].jurisdiction` | string/null | 管辖信息，部分数据源返回 |
| `hits[].ecli` | string/null | ECLI，部分判例返回 |
| `hits[].case_number` | string/null | 案号，部分判例返回 |

### 4.2 文档获取：ldh_get_document

根据搜索结果中的 `source + source_id` 获取文档元数据和正文。

#### 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `source` | string | 是 | 数据源 ID，例如 `FR/Judilibre`、`FR/CNIL` |
| `source_id` | string | 是 | 文档在该来源内的唯一 ID |
| `include_full_text` | boolean | 否 | `false` 返回约前 2KB 摘要；`true` 返回完整正文；默认 `false` |

#### 示例

```json
{
  "jsonrpc": "2.0",
  "id": "ldh-document-001",
  "method": "tools/call",
  "params": {
    "name": "ldh_get_document",
    "arguments": {
      "source": "FR/CNIL",
      "source_id": "CNILTEXT000020022201",
      "include_full_text": false
    }
  }
}
```

#### 返回数据

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | 来源标识 |
| `source_id` | string | 来源内文档 ID |
| `data_type` | string | `case_law`、`legislation` 或 `doctrine` |
| `title` | string | 标题 |
| `text` | string | 文本；是否完整由 `include_full_text` 决定 |
| `url` | string | 原始来源链接 |
| `date` | string/null | 主要日期 |
| `country` | string | 国家代码 |
| `language` | string/null | 语言代码 |
| `court` | string/null | 法院或机构 |
| `chamber` | string/null | 审判庭/部门 |
| `jurisdiction` | string/null | 管辖信息 |
| `ecli` | string/null | ECLI |
| `case_number` | string/null | 案号 |
| `decision_type` | string/null | 决定类型 |
| `court_tier` | integer/null | 法院层级 |
| `summary` | string/null | 摘要 |
| `full_text_size` | integer | 摘要模式返回，表示完整正文字符数 |
| `text_truncated` | boolean | 摘要模式返回，表示文本是否截断 |

## 5. 错误处理

### 5.1 JSON-RPC 或 MCP 错误

如果外层存在 `error`，或者 `result.isError=true`，应按 MCP 调用失败处理。

### 5.2 法律之星业务错误

法律之星业务校验失败时，网关可能仍返回 HTTP 200 和 `isError=false`。必须继续解析 `content[0].text` 并检查 `code`：

```json
{
  "code": "202",
  "msg": "关键词不能为空！",
  "data": {}
}
```

建议接入方成功条件同时满足：

```text
HTTP 2xx
且不存在 JSON-RPC error
且 result.isError != true
且法律之星内层 code == "200"
```

LDH 当前没有统一的 `code/msg/data` 外壳，应按照 JSON-RPC/MCP 错误和返回字段完整性判断。

## 6. cURL 示例

```bash
curl 'https://mcpgateway.100credit.cn/mcp' \
  -H 'X-App-Key: YOUR_APP_KEY' \
  -H 'X-App-Secret: YOUR_APP_SECRET' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data-binary '{
    "jsonrpc":"2.0",
    "id":"example-001",
    "method":"tools/call",
    "params":{
      "name":"lawstar_data_professional_query",
      "arguments":{"page":1,"rows":10,"keyword":"民法典"}
    }
  }'
```
