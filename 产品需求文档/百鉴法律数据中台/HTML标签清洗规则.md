
# 法律之星 HTML 正文标签规则与清洗指南

> 数据来源：`lawstar_data_professional_detail` 接口返回的 `lawSourceContent` 字段  
> 示例法规：《中华人民共和国民法典》（175,170 字符）

---

## 一、关于"正文请求"

### Q: search / detail / 下载分别算哪种计费？

根据法律之星公开报价，接口分两类：

| 调用类型 | 对应接口 | 计费类别 |
|----------|----------|----------|
| `lawstar_data_professional_query`（快捷搜索） | 搜索 | **精准查询** |
| `lawstar_data_k_query`（高级搜索） | 搜索 | **精准查询** |
| `lawstar_data_xl_query`（语义搜索） | 搜索 | 语义检索 |
| **`lawstar_data_professional_detail`（详情）** | 正文 | **正文请求**（随搜索额度赠送） |
| `downdetailurl` / `downdetailurlpdf`（下载文件） | 下载 | GET 请求，不计入 API 调用次数 |

> **关键结论**：detail 接口计为一条正文请求。法律之星免费额度中精准查询送 1000 次搜索 + 300 篇正文，你的 443 条批量检索如果每条都调 detail，正文额度很快会用完。两个下载 URL 的 GET 请求不额外计费。

---

## 二、HTML 标签体系（全文只有 5 种标签）

| 标签 | 出现次数 | 用途 |
|------|:-------:|------|
| `<p>` | 5330 | 段落，承载所有文本内容 |
| `<div>` | 2520 | 容器，每个条文一个 div |
| `<strong>` | 280 | 粗体，仅用于编/章/节标题 |
| `<br/>` | 258 | 段内换行 |
| `<a>` | 18 | 法规间交叉引用链接 |

> **不使用**：`<b>`、`<span>`、`<em>`、`<h1>`-`<h6>`、`class` 属性、CSS。
> 极简体系，只有 `style` 行内样式和 `id` 属性。

---

## 三、层级结构

全文分为 **427 个非 div 段落**（标题/目录区）和 **2238 个 div 包裹段落**（正文区）。

```
HTML 整体
├── 标题区（<p> + <strong> + style='text-align:center'）
│   ├── 法规名称（全文标题）
│   ├── 主席令号 / 通过日期
│   └── 目录（纯文本排列）
│
├── 正文区（按编/章/节逐级展开）
│   ├── <p id='section0' style='text-align:center'><strong>第一编  总则</strong></p>
│   ├── <p id='section1' style='text-align:center'><strong>第一章  基本规定</strong></p>
│   ├── <div id='第一条'>
│   │   <p>　　第一条  为了保护民事主体的合法权益...</p>
│   │   </div>
│   ├── <div id='第二条'>
│   │   <p>　　第二条  民法调整平等主体的...</p>
│   │   </div>
│   └── ...（逐条目重复）
│
└── 交叉引用（<a> 标签）
    └── <a href='' targetdataid='16D1177D...'>中华人民共和国婚姻法</a>
```

### 层级识别规则

| 元素 | 层级 | 识别特征 |
|------|:--:|------|
| `<p style='text-align:center'><strong>` | 编 | `第X编`，`id='section0'` 等 |
| `<p style='text-align:center'><strong>` | 章 | `第X章`，`id` 递增 |
| `<p style='text-align:center'><strong>` | 节 | `第X节` |
| `<p>`（centered, 无 strong） | 分编 | `第X分编` |
| `<div id='第X条'>` → `<p>` | 条 | 每个 `<div>` 即一条 |

---

## 四、各类标签详细格式

### 4.1 `<p>` — 普通段落

承载所有文本，特征：

- **全角空格缩进**：正文开头用 `　　`（两个全角空格）
- **无 class 属性**
- **style 仅三种取值**：
  - `text-align:center` → 标题、目录、编/章/节名
  - `text-align:right` → 签名行、日期行
  - 无 style → 正文段落

```html
<!-- 居中标题 -->
<p style='text-align:center'><strong>第一编  总则</strong></p>

<!-- 右对齐签名 -->
<p style='text-align:right'>中华人民共和国主席 习近平</p>

<!-- 普通正文（无 style） -->
<p>　　第一条  为了保护民事主体的合法权益，调整民事关系...</p>
```

### 4.2 `<div>` — 条文容器

**每个条文（第X条）独占一个 div**，`id` 属性即条号名称。

```html
<div id='第一条'>
  <p>　　第一条  为了保护民事主体的合法权益，调整民事关系，
  维护社会和经济秩序，适应中国特色社会主义发展要求，
  弘扬社会主义核心价值观，根据宪法，制定本法。</p>
</div>
```

**特征：**
- `<div>` 的 `id` 值就是条号，格式如 `第一条`、`第一百条`、`第一千零二十五条`
- `<div>` 本身无 style / class 属性
- 每个 div 内包含 1 个 `<p>`（单款条文）或 2 个 `<p>`（多款条文）

**多款条文示例：**

```html
<div id='第一千条'>
  <p>　　第一千条  行为人因侵害人格权承担消除影响、恢复名誉、
  赔礼道歉等民事责任的，应当与行为的具体方式、造成的影响范围相当。</p>
  <p>　　行为人拒不承担前款规定的民事责任的，人民法院可以采取
  在报刊、网络等媒体上发布公告或者公布生效裁判文书等方式执行，
  产生的费用由行为人负担。</p>
</div>
```

### 4.3 `<strong>` — 层级标题

**仅用于编、章、节名称**，不出现在条文正文中。

```html
<strong>第一编  总则</strong>
<strong>第一章  基本规定</strong>
<strong>第一节  民事权利能力和民事行为能力</strong>
```

**重要**：条文编号（第一条、第二条…）**不使用** `<strong>` 或 `<b>`，只是 `<p>` 内的普通文本。

### 4.4 `<br/>` — 段内换行

出现在标题区域的空白行和目录区）：

```html
<p><br/></p>    <!-- 空行分隔 -->
```

正文条文中极少使用。

### 4.5 `<a>` — 交叉引用

用于指向其他被民法典取代/引用的法律，共 9 处：

```html
<a href='' targetdataid='16D1177D1E67AA06FB9D4BB44158D339'>中华人民共和国婚姻法</a>
<a href='' targetdataid='CE6A10DD5E34211FC1864010D4A76E2A'>中华人民共和国继承法</a>
<a href='' targetdataid='DECDE8EBCF197BF9FD1CA5C6F6E55123'>中华人民共和国民法通则</a>
<!-- ... 等 9 部被民法典取代的旧法 -->
```

| 属性 | 说明 |
|------|------|
| `href` | 空字符串（非外部链接） |
| `targetdataid` | 目标法规的 lawId，可用于 `lawstar_detail()` 跳转 |
| 内容 | 被引用法律的完整名称 |

---

## 五、清洗规则总结

### 5.1 从任意 HTML 清洗为法律之星格式

```python
import re

def clean_to_lawstar_format(raw_html: str) -> str:
    """
    将任意法规 HTML 清洗为法律之星 body 格式。
    输入：来自网络下载的法规 HTML
    输出：与 lawSourceContent 一致的简洁 HTML
    """
    # 1. 只保留 p, div, strong, br, a 五种标签
    allowed_tags = ['p', 'div', 'strong', 'br', 'a']
    # 移除所有不允许的标签
    for tag in ['span', 'font', 'b', 'i', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'img', 'script', 'style']:
        raw_html = re.sub(rf'</?{tag}[^>]*>', '', raw_html, flags=re.DOTALL)

    # 2. 移除非法的 style/class 属性
    #    只保留 style='text-align:center' 和 style='text-align:right'
    def clean_style(match):
        tag = match.group(0)
        if "text-align:center" in tag:
            return re.sub(r"style='[^']*'", "style='text-align:center'", tag)
        elif "text-align:right" in tag:
            return re.sub(r"style='[^']*'", "style='text-align:right'", tag)
        else:
            return re.sub(r"\s+style='[^']*'", '', tag)

    raw_html = re.sub(r'<(p|div|strong|br|a)\b[^>]*>', clean_style, raw_html)

    # 3. 移除所有 class 属性
    raw_html = re.sub(r"\s+class='[^']*'", '', raw_html)

    # 4. 将 <a> 标签的 href 清空，保留 targetdataid（如有）
    raw_html = re.sub(r"<a\s+href='[^']*'", "<a href=''", raw_html)

    # 5. 统一空白字符
    raw_html = raw_html.replace('\n', '').replace('\r', '')
    raw_html = re.sub(r'>\s+<', '><', raw_html)  # 去除标签间空白

    return raw_html
```

### 5.2 提取纯文本

```python
def extract_plain_text(lawstar_html: str) -> str:
    """从法律之星 HTML 提取纯文本，保留段落结构。"""
    # 替换标签
    text = lawstar_html
    text = re.sub(r'<br\s*/?>', '\n', text)           # br → 换行
    text = re.sub(r'</div>', '\n', text)               # div 结束 → 换行
    text = re.sub(r'</p>', '\n', text)                 # p 结束 → 换行
    text = re.sub(r'<[^>]+>', '', text)                # 移除所有标签
    text = re.sub(r'\n{3,}', '\n\n', text)             # 压缩多余空行
    return text.strip()
```

### 5.3 提取层级结构

```python
def extract_structure(lawstar_html: str) -> list[dict]:
    """提取法规层级结构（编/章/节/条）。"""
    import re
    items = []

    # 编/章/节：<p style='text-align:center'><strong>第X编/章/节 名称</strong></p>
    for m in re.finditer(
        r"<p[^>]*style='text-align:center'[^>]*><strong>"
        r"((?:第[一二三四五六七八九十百]+(?:编|章|节)|附则)[^<]*)"
        r"</strong></p>",
        lawstar_html
    ):
        items.append({'type': 'heading', 'text': m.group(1)})

    # 条：<div id='第X条'><p>...</p></div>
    for m in re.finditer(
        r"<div\s+id='([^']+)'\s*>(.*?)</div>",
        lawstar_html, re.DOTALL
    ):
        article_id = m.group(1)
        content = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        items.append({'type': 'article', 'id': article_id, 'text': content})

    return items
```

### 5.4 清洗效果对照

| 步骤 | 操作 | 输入示例 | 输出示例 |
|------|------|----------|----------|
| 1 | 去除非允许标签 | `<span class="art">第一条</span>` | `第一条` |
| 2 | 清洗 style | `<p style="color:red;font-size:16px">` | `<p>` |
| 3 | 去 class | `<p class="article-content">` | `<p>` |
| 4 | 清空 a href | `<a href="http://xx.com/law/123">` | `<a href=''>` |
| 5 | 压空白 | `<p>   </p>\n\n<p>` | `<p></p><p>` |

---

## 六、完整标签参考卡

```
┌──────────────────────────────────────────────────────┐
│ 法律之星 lawSourceContent 标签一览                     │
├──────────┬─────────┬──────────────────────────────────┤
│ 标签     │ 数量    │ 用途                             │
├──────────┼─────────┼──────────────────────────────────┤
│ <p>      │ 5330    │ 所有文本段落                     │
│ <div>    │ 2520    │ 条文容器，id=条号                 │
│ <strong> │ 280     │ 编/章/节标题粗体                  │
│ <br/>    │ 258     │ 段内换行（标题区空白行）          │
│ <a>      │ 18      │ 交叉引用，href='', targetdataid   │
├──────────┼─────────┼──────────────────────────────────┤
│ style值  │         │                                  │
│ center   │ 140     │ 标题/编/章/节居中                │
│ right    │ 2       │ 签名/日期右对齐                  │
│ (无)     │ 其余    │ 正文段落                         │
├──────────┼─────────┼──────────────────────────────────┤
│ 不使用   │ —       │ <b> <span> <em> <h1>-<h6>       │
│          │         │ class属性 CSS文件 外部样式表      │
└──────────┴─────────┴──────────────────────────────────┘
```
