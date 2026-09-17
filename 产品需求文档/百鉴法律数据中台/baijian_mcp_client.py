"""
百鉴法律数据中台 MCP 接口 Python 客户端
========================================
基于 JSON-RPC 2.0 over HTTP，封装 6 个法律数据检索工具。

使用前请先在 key.md 中配置 App Key 和 App Secret。
"""

import json
import os
from typing import Any, Optional

import requests


# ============================================================
# 配置
# ============================================================

def _load_credentials() -> tuple[str, str]:
    """从 key.md 加载凭据，回退到环境变量。"""
    app_key = ""
    app_secret = ""

    # 尝试从 key.md 读取
    key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "key.md")
    if os.path.exists(key_file):
        with open(key_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("key:") or line.startswith("key："):
                    app_key = line.split(":", 1)[-1].strip()
                    # 兼容中文冒号
                    if not app_key:
                        app_key = line.split("：", 1)[-1].strip()
                elif line.startswith("secret:") or line.startswith("secret："):
                    app_secret = line.split(":", 1)[-1].strip()
                    if not app_secret:
                        app_secret = line.split("：", 1)[-1].strip()

    # 环境变量优先
    app_key = os.environ.get("BAIJIAN_APP_KEY", app_key)
    app_secret = os.environ.get("BAIJIAN_APP_SECRET", app_secret)

    return app_key, app_secret


# ============================================================
# 客户端
# ============================================================

class BaijianMCPClient:
    """百鉴法律数据中台 MCP 客户端。"""

    BASE_URL = "https://mcpgateway.100credit.cn/mcp"

    def __init__(
        self,
        app_key: Optional[str] = None,
        app_secret: Optional[str] = None,
        timeout: int = 30,
    ):
        """
        初始化客户端。

        Args:
            app_key:    应用标识，不传则从 key.md 或环境变量读取。
            app_secret: 应用密钥。
            timeout:    HTTP 请求超时（秒）。
        """
        if app_key is None or app_secret is None:
            loaded_key, loaded_secret = _load_credentials()
            self.app_key = app_key or loaded_key
            self.app_secret = app_secret or loaded_secret
        else:
            self.app_key = app_key
            self.app_secret = app_secret

        if not self.app_key or not self.app_secret:
            raise ValueError(
                "App Key / App Secret 未配置。请在 key.md 中填写凭据，"
                "或设置环境变量 BAIJIAN_APP_KEY / BAIJIAN_APP_SECRET。"
            )

        self.timeout = timeout
        self._request_id = 0

    # ----------------------------------------------------------
    # 底层调用
    # ----------------------------------------------------------

    def _call(self, tool_name: str, arguments: dict) -> dict:
        """发起一次 JSON-RPC 调用，返回解析后的内层数据。"""
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": f"req-{self._request_id:04d}",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            },
        }

        headers = {
            "X-App-Key": self.app_key,
            "X-App-Secret": self.app_secret,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }

        resp = requests.post(
            self.BASE_URL,
            headers=headers,
            json=payload,
            timeout=self.timeout,
        )

        # 1. 检查 HTTP 状态
        if not resp.ok:
            raise BaijianAPIError(
                f"HTTP {resp.status_code}: {resp.text[:500]}",
                http_status=resp.status_code,
            )

        outer = resp.json()

        # 2. 检查 JSON-RPC error
        if "error" in outer:
            err = outer["error"]
            raise BaijianAPIError(
                f"JSON-RPC 错误 (code={err.get('code')}): {err.get('message', '')}",
                rpc_error=err,
            )

        result = outer.get("result", {})

        # 3. 检查 MCP isError
        if result.get("isError"):
            raise BaijianAPIError(
                "MCP 工具调用返回 isError=true",
            )

        # 4. 解析内层 text
        content_list = result.get("content", [])
        if not content_list:
            raise BaijianAPIError("返回的 content 为空")

        raw_text = content_list[0].get("text", "")
        if not raw_text:
            raise BaijianAPIError("content[0].text 为空")

        try:
            inner = json.loads(raw_text)
        except json.JSONDecodeError:
            raise BaijianAPIError(f"无法解析内层 JSON: {raw_text[:500]}")

        return inner

    # ----------------------------------------------------------
    # 法律之星 — 搜索
    # ----------------------------------------------------------

    def lawstar_quick_query(
        self,
        keyword: str,
        page: int = 1,
        rows: int = 10,
        *,
        field: Optional[str] = None,
        file_num: Optional[str] = None,
        dep_name: Optional[str] = None,
        start_date: Optional[int] = None,
        end_date: Optional[int] = None,
        start_date_1: Optional[int] = None,
        end_date_1: Optional[int] = None,
        dep_number: Optional[str] = None,
        area_number: Optional[str] = None,
        effective3: Optional[str] = None,
        timelinessnew: Optional[str] = None,
        synonym: Optional[str] = None,
    ) -> dict:
        """
        法律之星快捷搜索 — 同时匹配法规标题和正文。

        Args:
            keyword:       关键词，多个用空格分隔。
            page:          当前页，从 1 开始。
            rows:          每页条数。
            field:         排序字段：rDate（发布日期）/ lawlevel（效力级别）。
            file_num:      文号。
            dep_name:      发文机关名称。
            start_date:    发布日期起始，格式 yyyyMMdd。
            end_date:      发布日期截止。
            start_date_1:  实施日期起始。
            end_date_1:    实施日期截止。
            dep_number:    发文机关代码，例如 [[401,1]]。
            area_number:   区域代码。
            effective3:    法规效力代码，多个用逗号分隔。
            timelinessnew: 0-尚未实施 / 1-现行有效 / 2-已失效 / 3-已修改 / 4-草案。
            synonym:       0-关闭同义词（默认）/ 1-开启。

        Returns:
            内层 data，包含 lawdata / count / pageSize / totalPage。
            lawdata 每条含 lawId、lawName、issuingOrgan 等字段。
        """
        args: dict[str, Any] = {
            "page": page,
            "rows": rows,
            "keyword": keyword,
        }
        _set_if_not_none(args, "field", field)
        _set_if_not_none(args, "fileNum", file_num)
        _set_if_not_none(args, "depName", dep_name)
        _set_if_not_none(args, "startDate", start_date)
        _set_if_not_none(args, "endDate", end_date)
        _set_if_not_none(args, "startDate1", start_date_1)
        _set_if_not_none(args, "endDate1", end_date_1)
        _set_if_not_none(args, "depNumber", dep_number)
        _set_if_not_none(args, "areaNumber", area_number)
        _set_if_not_none(args, "effective3", effective3)
        _set_if_not_none(args, "timelinessnew", timelinessnew)
        _set_if_not_none(args, "synonym", synonym)

        inner = self._call("lawstar_data_professional_query", args)
        _check_lawstar_code(inner)
        return inner["data"]

    def lawstar_advanced_query(
        self,
        keywords: str,
        page: int = 1,
        rows: int = 10,
        *,
        searchtype: Optional[int] = None,
        field: Optional[str] = None,
        file_num: Optional[str] = None,
        dep_name: Optional[str] = None,
        start_date: Optional[int] = None,
        end_date: Optional[int] = None,
        start_date_1: Optional[int] = None,
        end_date_1: Optional[int] = None,
        dep_number: Optional[str] = None,
        area_number: Optional[str] = None,
        effective3: Optional[str] = None,
        timelinessnew: Optional[str] = None,
    ) -> dict:
        """
        法律之星高级搜索 — 支持关键词组合及多种过滤条件。

        Args:
            keywords:      关键词组合，必填。例如 "0;民法典"。
            page:          当前页。
            rows:          每页条数。
            searchtype:    0-所有条件 AND / 1-任意条件 OR，默认 1。
            其余参数同 lawstar_quick_query。
        """
        args: dict[str, Any] = {
            "page": page,
            "rows": rows,
            "keywords": keywords,
        }
        _set_if_not_none(args, "searchtype", searchtype)
        _set_if_not_none(args, "field", field)
        _set_if_not_none(args, "fileNum", file_num)
        _set_if_not_none(args, "depName", dep_name)
        _set_if_not_none(args, "startDate", start_date)
        _set_if_not_none(args, "endDate", end_date)
        _set_if_not_none(args, "startDate1", start_date_1)
        _set_if_not_none(args, "endDate1", end_date_1)
        _set_if_not_none(args, "depNumber", dep_number)
        _set_if_not_none(args, "areaNumber", area_number)
        _set_if_not_none(args, "effective3", effective3)
        _set_if_not_none(args, "timelinessnew", timelinessnew)

        inner = self._call("lawstar_data_k_query", args)
        _check_lawstar_code(inner)
        return inner["data"]

    # ----------------------------------------------------------
    # 法律之星 — 详情
    # ----------------------------------------------------------

    def lawstar_detail(self, rjs8: str) -> dict:
        """
        获取法规全文详情。

        Args:
            rjs8: 法规 ID，取自搜索结果的 lawId 字段。

        Returns:
            内层 data，含 lawName、lawSourceContent（HTML）、tocItem（目录）、
            enclosure（附件）、hisgroup（历史版本）、downdetailurl 等。
        """
        inner = self._call("lawstar_data_professional_detail", {"rjs8": rjs8})
        _check_lawstar_code(inner)
        return inner["data"]

    # ----------------------------------------------------------
    # LDH — 全球法律搜索
    # ----------------------------------------------------------

    def ldh_search(
        self,
        query: str,
        namespace: str = "case_law",
        *,
        top_k: Optional[int] = None,
        alpha: Optional[float] = None,
        country: Optional[list[str]] = None,
        source: Optional[list[str]] = None,
        court_tier: Optional[int] = None,
        jurisdiction: Optional[str] = None,
        subdivision: Optional[str] = None,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
        language: Optional[str] = None,
    ) -> dict:
        """
        LDH 全球法律搜索 — 判例、法规、学说混合检索。

        Args:
            query:        自然语言搜索问题，必填。
            namespace:    case_law（判例）/ legislation（法规）/ doctrine（学说）。
            top_k:        返回数量 1-100。
            alpha:        语义权重，1.0 纯语义 / 0.0 纯关键词，建议 0.7。
            country:      ISO alpha-2 国家代码列表，如 ["FR", "DE"]。
            source:       数据源 ID 列表，如 ["FR/Judilibre", "FR/CNIL"]。
            court_tier:   1-最高法院 / 2-上诉法院 / 3-初审法院。
            jurisdiction: 管辖类型，如 civil / criminal。
            subdivision:  ISO 3166-2 行政区划，如 "DE-BY"。
            date_start:   起始日期 YYYY-MM-DD。
            date_end:     截止日期 YYYY-MM-DD。
            language:     语言代码，如 fr / de / en。

        Returns:
            { query, hits, total_hits, elapsed_ms }。
        """
        args: dict[str, Any] = {
            "query": query,
            "namespace": namespace,
        }
        _set_if_not_none(args, "top_k", top_k)
        _set_if_not_none(args, "alpha", alpha)
        _set_if_not_none(args, "country", country)
        _set_if_not_none(args, "source", source)
        _set_if_not_none(args, "court_tier", court_tier)
        _set_if_not_none(args, "jurisdiction", jurisdiction)
        _set_if_not_none(args, "subdivision", subdivision)
        _set_if_not_none(args, "date_start", date_start)
        _set_if_not_none(args, "date_end", date_end)
        _set_if_not_none(args, "language", language)

        return self._call("ldh_search", args)

    # ----------------------------------------------------------
    # LDH — 文档获取
    # ----------------------------------------------------------

    def ldh_get_document(
        self,
        source: str,
        source_id: str,
        include_full_text: bool = False,
    ) -> dict:
        """
        获取 LDH 文档详情。

        Args:
            source:            数据源 ID，如 "FR/CNIL"。
            source_id:         文档在该来源内的唯一 ID。
            include_full_text: 是否返回完整正文（默认 False，仅返回前约 2KB）。

        Returns:
            文档元数据 + text 正文。
        """
        return self._call("ldh_get_document", {
            "source": source,
            "source_id": source_id,
            "include_full_text": include_full_text,
        })


# ============================================================
# 工具函数
# ============================================================

def _set_if_not_none(d: dict, key: str, value: Any) -> None:
    """仅当 value 不为 None 时写入 dict。"""
    if value is not None:
        d[key] = value


def _check_lawstar_code(inner: dict) -> None:
    """检查法律之星内层 code 是否为 '200'。"""
    code = str(inner.get("code", ""))
    if code != "200":
        msg = inner.get("msg", "未知错误")
        raise BaijianBusinessError(f"法律之星业务错误 (code={code}): {msg}", code=code)


# ============================================================
# 异常
# ============================================================

class BaijianAPIError(Exception):
    """API 调用异常（HTTP、JSON-RPC、MCP 层）。"""

    def __init__(self, message: str, http_status: Optional[int] = None, rpc_error: Optional[dict] = None):
        super().__init__(message)
        self.http_status = http_status
        self.rpc_error = rpc_error


class BaijianBusinessError(Exception):
    """法律之星业务异常（内层 code ≠ 200）。"""

    def __init__(self, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.code = code


# ============================================================
# 快捷入口
# ============================================================

_default_client: Optional[BaijianMCPClient] = None


def get_client(**kwargs) -> BaijianMCPClient:
    """获取（或创建）默认客户端实例。"""
    global _default_client
    if _default_client is None or kwargs:
        _default_client = BaijianMCPClient(**kwargs)
    return _default_client


if __name__ == "__main__":
    # 快速自检
    client = BaijianMCPClient()
    print("Client init OK")
    result = client.lawstar_quick_query("民法典", rows=2)
    print(f"Search '民法典' -> total {result.get('count', 0)}, returned {len(result.get('lawdata', []))} rows")
    for law in result.get("lawdata", []):
        print(f"  [{law.get('lawId')}] {law.get('lawName')}  ({law.get('timeliness', '')})")
