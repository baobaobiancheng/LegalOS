"""
批量获取法规正文详情，结果存为 JSON。
用法：python batch_fetch_details.py

从 law_search_raw.json 读取搜索结果，提取 lawId，
调用 lawstar_detail 获取每部法规的完整正文，存入 law_detail_results.json。
"""
import json
import os
import re
import sys
import time

from baijian_mcp_client import BaijianMCPClient, BaijianAPIError, BaijianBusinessError


def clean_law_name(raw_name):
    """去除 lawName 中的高亮 <span> 标签，得到纯文本法规名。"""
    return re.sub(r'<[^>]+>', '', raw_name)


def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(base_dir, 'law_search_raw.json')
    output_path = os.path.join(base_dir, 'law_detail_results.json')

    # ---------- 加载原始搜索结果 ----------
    print("加载 law_search_raw.json ...")
    with open(input_path, 'r', encoding='utf-8') as f:
        search_results = json.load(f)
    print(f"共 {len(search_results)} 条搜索结果")

    # 提取有 lawdata 的条目
    tasks = []
    skipped = []
    for i, entry in enumerate(search_results):
        lawdata = entry.get('lawdata', [])
        if lawdata and len(lawdata) > 0:
            top1 = lawdata[0]
            tasks.append({
                'index': i,
                'lawId': top1['lawId'],
                'lawName_raw': top1.get('lawName', ''),
                'lawName': clean_law_name(top1.get('lawName', '')),
                'issuingOrgan': top1.get('issuingOrgan', ''),
                'issuingNo': top1.get('issuingNo', ''),
                'timeliness': top1.get('timeliness', ''),
            })
        else:
            skipped.append(i)

    print(f"待获取详情: {len(tasks)} 条")
    print(f"无匹配跳过: {len(skipped)} 条 (索引: {skipped})")

    # ---------- 断点续跑 ----------
    if os.path.exists(output_path):
        with open(output_path, 'r', encoding='utf-8') as f:
            results = json.load(f)
        done_ids = {r['lawId'] for r in results if r.get('detail')}
        print(f"已加载 {len(results)} 条已有结果，断点续跑")
    else:
        results = []
        done_ids = set()

    pending = [t for t in tasks if t['lawId'] not in done_ids]
    print(f"待处理: {len(pending)} 条\n")

    if not pending:
        print("全部已完成，无需继续。")
        return

    # ---------- 开始批量获取 ----------
    client = BaijianMCPClient(timeout=120)

    success = 0
    fail = 0
    start_idx = len(results)

    for i, task in enumerate(pending):
        idx = start_idx + i + 1
        total = len(tasks)
        name = task['lawName'][:50]

        print(f"[{idx}/{total}] {name}...", end=' ', flush=True)

        try:
            detail = client.lawstar_detail(task['lawId'])

            result_entry = {
                'lawId': task['lawId'],
                'lawName': task['lawName'],
                'lawName_raw': task['lawName_raw'],
                'issuingOrgan': task['issuingOrgan'],
                'issuingNo': task['issuingNo'],
                'timeliness': task['timeliness'],
                'detail': detail,
            }
            results.append(result_entry)
            success += 1

            # 统计正文大小
            html_len = len(detail.get('lawSourceContent', ''))
            print(f"OK (HTML {html_len:,} 字符)")

        except (BaijianAPIError, BaijianBusinessError) as e:
            result_entry = {
                'lawId': task['lawId'],
                'lawName': task['lawName'],
                'lawName_raw': task['lawName_raw'],
                'issuingOrgan': task['issuingOrgan'],
                'issuingNo': task['issuingNo'],
                'timeliness': task['timeliness'],
                'detail': None,
                'error': str(e),
            }
            results.append(result_entry)
            fail += 1
            print(f"FAIL: {e}")

        except Exception as e:
            result_entry = {
                'lawId': task['lawId'],
                'lawName': task['lawName'],
                'lawName_raw': task['lawName_raw'],
                'issuingOrgan': task['issuingOrgan'],
                'issuingNo': task['issuingNo'],
                'timeliness': task['timeliness'],
                'detail': None,
                'error': f"{type(e).__name__}: {e}",
            }
            results.append(result_entry)
            fail += 1
            print(f"FAIL: {e}")

        # 每 5 条保存一次（正文数据量大，频繁保存防丢失）
        if (i + 1) % 5 == 0:
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
            print(f"  --- 已保存 {len(results)} 条 (成功 {success}, 失败 {fail}) ---")

        time.sleep(0.5)  # 正文接口可能比搜索慢，适当间隔

    # ---------- 最终保存 ----------
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    # 追加跳过的空结果
    for i in skipped:
        results.append({
            'lawId': None,
            'lawName': f'[无匹配-索引{i}]',
            'detail': None,
            'error': 'search returned empty lawdata',
        })

    print(f"\n===== 完成 =====")
    print(f"总数: {len(tasks)} 条, 成功: {success}, 失败: {fail}, 跳过: {len(skipped)}")
    print(f"结果文件: {output_path}")

    # 估算文件大小
    file_size = os.path.getsize(output_path)
    print(f"文件大小: {file_size / 1024 / 1024:.1f} MB")


if __name__ == '__main__':
    main()
