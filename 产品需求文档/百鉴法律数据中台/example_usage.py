"""
百鉴法律数据中台 MCP 客户端 — 使用示例
=======================================
"""

from baijian_mcp_client import BaijianMCPClient, BaijianBusinessError


def main():
    client = BaijianMCPClient()

    # ============================================================
    # 示例 1：法律之星快捷搜索
    # ============================================================
    print("=" * 60)
    print("1. 法律之星快捷搜索：现行有效的民法典相关法规（前 5 条）")
    print("=" * 60)

    data = client.lawstar_quick_query("民法典", rows=5, timelinessnew="1")
    print(f"命中总数：{data['count']}，当前 {data['totalPage']} 页\n")
    for i, law in enumerate(data["lawdata"], 1):
        print(f"  {i}. [{law['lawId']}] {law['lawName']}")
        print(f"     发文机关：{law.get('issuingOrgan', '')}  |  时效性：{law.get('timeliness', '')}")
        print(f"     发布日期：{law.get('releaseYearMonthDate', '')}  |  实施日期：{law.get('implementYearMonthDate', '')}")
        print()

    # ============================================================
    # 示例 2：法律之星高级搜索
    # ============================================================
    print("=" * 60)
    print("2. 法律之星高级搜索：标题含'数据'且现行有效（前 3 条）")
    print("=" * 60)

    data = client.lawstar_advanced_query("0;数据", rows=3, timelinessnew="1")
    for i, law in enumerate(data["lawdata"], 1):
        print(f"  {i}. {law['lawName']}")
        print(f"     文号：{law.get('issuingNo', '')}  |  时效性：{law.get('timeliness', '')}")
        print()

    # ============================================================
    # 示例 3：获取法规详情
    # ============================================================
    print("=" * 60)
    print("3. 获取法规详情（使用示例 1 第一个结果的 lawId）")
    print("=" * 60)

    # 先取一个 lawId
    search_data = client.lawstar_quick_query("个人信息保护法", rows=1, timelinessnew="1")
    if search_data["lawdata"]:
        law_id = search_data["lawdata"][0]["lawId"]
        print(f"  查询 lawId: {law_id}")

        detail = client.lawstar_detail(law_id)
        print(f"  法规名称：{detail.get('lawName', '')}")
        print(f"  发文机关：{detail.get('issuingOrgan', '')}")
        print(f"  文号：{detail.get('issuingNo', '')}")
        print(f"  时效性：{detail.get('timeliness', '')}")
        print(f"  附件数：{len(detail.get('enclosure', []))}")
        print(f"  历史版本数：{len(detail.get('hisgroup', []))}")
        # 正文前 200 字（已去除 HTML 标签）
        html = detail.get("lawSourceContent", "")
        text = html.replace("\n", " ").strip()
        print(f"  正文预览：{text[:200]}...")
        print()

    # ============================================================
    # 示例 4：LDH 全球法律搜索
    # ============================================================
    print("=" * 60)
    print("4. LDH 搜索：法国关于'被遗忘权'的判例（前 3 条）")
    print("=" * 60)

    data = client.ldh_search(
        query="right to be forgotten personal data protection",
        namespace="case_law",
        top_k=3,
        alpha=0.7,
        country=["FR"],
        source=["FR/CNIL"],
    )
    print(f"  耗时：{data.get('elapsed_ms', 0)} ms，命中：{data.get('total_hits', 0)} 条\n")
    for i, hit in enumerate(data.get("hits", []), 1):
        print(f"  {i}. {hit.get('title', '')}")
        print(f"     来源：{hit.get('source', '')}  |  法院：{hit.get('court', '')}")
        print(f"     日期：{hit.get('date', '')}  |  语言：{hit.get('language', '')}")
        print(f"     摘要：{hit.get('snippet', '')[:150]}...")
        print()

    # ============================================================
    # 示例 5：LDH 获取文档
    # ============================================================
    print("=" * 60)
    print("5. LDH 获取文档详情")
    print("=" * 60)

    # 先用搜索拿一个 source + source_id
    search_data = client.ldh_search(
        query="data protection GDPR",
        namespace="legislation",
        top_k=1,
        country=["EU"],
    )
    if search_data.get("hits"):
        hit = search_data["hits"][0]
        source = hit["source"]
        source_id = hit["source_id"]
        print(f"  查询 source={source}, source_id={source_id}")

        doc = client.ldh_get_document(source, source_id, include_full_text=False)
        print(f"  标题：{doc.get('title', '')}")
        print(f"  类型：{doc.get('data_type', '')}")
        print(f"  国家：{doc.get('country', '')}")
        print(f"  发布日期：{doc.get('date', '')}")
        print(f"  全文大小：{doc.get('full_text_size', 0)} 字符")
        print(f"  原文链接：{doc.get('url', '')}")
        print(f"  正文预览：{doc.get('text', '')[:200]}...")
        print()

    print("All examples completed.")


if __name__ == "__main__":
    main()
