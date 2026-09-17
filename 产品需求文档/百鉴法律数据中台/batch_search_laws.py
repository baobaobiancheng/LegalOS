"""
批量检索法律法规目录中的每条法规，结果存为 JSON。
用法：python batch_search_laws.py
"""
import json
import re
import sys
import time
import os

from baijian_mcp_client import BaijianMCPClient

# ---------- 1. 从 markdown 中提取所有法规名称 ----------
def extract_laws(md_path):
    """从目录 markdown 提取法规名称列表，去重保留首次出现的层级路径。"""
    laws = []  # [(name, hierarchy_path)]
    seen = set()

    with open(md_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    # 跟踪当前层级
    bian = zhang = jie = cat = ""

    for line in lines:
        line = line.rstrip('\n')

        # 编
        if line.startswith('## '):
            bian = line[3:].strip()
            zhang = jie = cat = ""
            continue
        # 章
        if line.startswith('### '):
            zhang = line[4:].strip()
            jie = cat = ""
            continue
        # 节 / 四级别
        if line.startswith('#### '):
            jie = line[5:].strip()
            cat = ""
            continue

        # 法规条目
        if line.startswith('- '):
            raw = line[2:].strip()
            # 清洗名称
            name = clean_name(raw)
            if not name or len(name) < 2:
                continue

            # 构建层级路径
            path_parts = [p for p in [bian, zhang, jie, cat] if p]
            hierarchy = ' > '.join(path_parts) if path_parts else '根'

            if name not in seen:
                seen.add(name)
                laws.append({
                    "raw": raw,
                    "name": name,
                    "hierarchy": hierarchy
                })
        else:
            # 可能是子分类（如"一、 法律"）
            m = re.match(r'^####\s+(.+)', line)
            if not m:
                # 检查是否是纯文本分类行（在 #### 之后没有 - 开头的情况实际已被上面捕获）
                pass

    return laws


def clean_name(raw):
    """清洗法规名称：去书名号、去前缀编号、去括号内发文机关。"""
    name = raw.strip()
    # 去掉前缀编号如 "1. ", "240. "
    name = re.sub(r'^\d+\.\s*', '', name)
    # 去掉书名号
    name = name.replace('《', '').replace('》', '')
    name = name.replace('<', '').replace('>', '')
    # 统一全角半角括号
    name = name.replace('（', '(').replace('）', ')')
    # 去掉末尾的 "（XX部）" 发文机关标注（保留内容本身）
    # 先不做激进清理
    return name.strip()


def extract_keyword(name):
    """从法规名称中提取核心关键词用于检索。"""
    # 去掉括号中的补充说明（征求意见稿、试行等保留）
    # 取书名号内的核心名称，去掉发文机关后缀
    raw = name

    # 如果名字太长（>30字），取前半段核心部分
    if len(raw) > 40:
        # 尝试在某个分隔处截断
        raw = raw[:40]

    return raw


# ---------- 2. 主流程 ----------
def main():
    md_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '法律法规汇编目录.md')
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'law_search_results.json')

    # 断点续跑：如果已有结果文件，加载之
    if os.path.exists(output_path):
        with open(output_path, 'r', encoding='utf-8') as f:
            results = json.load(f)
        done_names = {r['name'] for r in results}
        print(f"已加载 {len(results)} 条已有结果，断点续跑")
    else:
        results = []
        done_names = set()

    print("提取法规列表...")
    all_laws = extract_laws(md_path)
    print(f"共提取 {len(all_laws)} 条唯一法规")

    # 过滤已完成的
    pending = [law for law in all_laws if law['name'] not in done_names]
    print(f"待检索: {len(pending)} 条")

    client = BaijianMCPClient(timeout=60)

    success = 0
    fail = 0
    start_idx = len(results)

    for i, law in enumerate(pending):
        keyword = extract_keyword(law['name'])
        idx = start_idx + i + 1

        print(f"[{idx}/{len(all_laws)}] 检索: {law['name'][:60]}...", end=' ', flush=True)

        try:
            data = client.lawstar_quick_query(keyword, rows=1, timelinessnew="1")
            result_entry = {
                "name": law['name'],
                "raw": law['raw'],
                "hierarchy": law['hierarchy'],
                "search_keyword": keyword,
                "search_result": {
                    "count": data.get("count", 0),
                    "top1": data["lawdata"][0] if data.get("lawdata") else None
                }
            }
            results.append(result_entry)
            success += 1
            print(f"OK (命中{data.get('count',0)}条)")

        except Exception as e:
            result_entry = {
                "name": law['name'],
                "raw": law['raw'],
                "hierarchy": law['hierarchy'],
                "search_keyword": keyword,
                "search_result": None,
                "error": str(e)
            }
            results.append(result_entry)
            fail += 1
            print(f"FAIL: {e}")

        # 每 10 条保存一次
        if (i + 1) % 10 == 0:
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
            print(f"  --- 已保存 {len(results)} 条 (成功{success}, 失败{fail}) ---")

        time.sleep(0.3)  # 避免请求过快

    # 最终保存
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n===== 完成 =====")
    print(f"总数: {len(results)}, 成功: {success}, 失败: {fail}")
    print(f"结果文件: {output_path}")


if __name__ == '__main__':
    main()
