# 分配与路由工作台 UI

## 设计约束

- 保留现有 LegalOS 品牌、Vue 组件及账号权限，不引入新 UI 依赖。
- 8px 间距节奏；白色内容面板、冷灰背景、蓝色单一操作强调色。正文与操作文案保持清晰对比，键盘焦点可见。
- 缩短页面标题区，将路由解释收起为单行说明；主要视口优先展示人员与职责。
- 桌面采用人员列表与详情分栏；平板三列、手机两列排列人员，不用横向轮播隐藏其他人。人员选择保留搜索及选中状态。
- 桌面左右面板共用网格行，顶部和底部对齐；左侧统计贴底，人员行保持自然高度。不使用固定高度、吸顶或脚本测量，两栏随职责详情和帮助内容一同伸展。小屏上下排列时各自按内容定高。
- 人数标题为“已录入职责”，仅统计当前职责目录中的人员，并注明“非全员名册”；不能将该数字解释为全部系统法务账号数。
- 业务职责与系统关联状态分开呈现。技术阻断使用后端 `issueCode`，不从提示文案猜测原因，也不将未关联规则显示为已生效。
- 确认应用、取消、请求失败、加载、空目录、无搜索结果和待对应人员范围均保留明确状态。
- 不调整自动分配算法，不启用线上规则，不修改账号角色或历史工单。

## 视觉参考与实际页面

- `routing-workspace-reference.png`：内置生图工具生成的布局参考，不作为真实业务数据或界面文案的来源。
- `routing-workspace-desktop.png`：浏览器渲染的实现截图，1366 × 768。
- `routing-workspace-mobile.png`：浏览器渲染的小屏实现截图，390 × 844。

实现截图采用浏览器回归测试的模拟接口，保留代码中已确认的职责清单；截图中的关联状态是测试数据，不代表线上规则状态。

## 验证

- 在 1366 × 768、1280 × 720、1024 × 768、390 × 844、320 × 740 视口检查六位法务均完整位于视口内，且人员列表和主内容没有横向溢出。
- 覆盖搜索、详情切换、应用前确认、取消、应用后刷新，以及不再请求旧专业领域标签。
- 验证桌面左右面板边缘及左侧统计底边对齐，覆盖长职责、短职责和帮助展开后的高度变化。
- 覆盖账号未就绪、部门未同步、部门名称不符、待应用和已启用的不同状态；保留没有部门 ID 的既有职责描述。

## 生图提示词

生成方式：内置 `image_gen`，单张横向工作台参考；未使用 CLI 或额外模型接口。

```text
Use case: ui-mockup. Create ONE polished horizontal 16:10 high-fidelity Chinese enterprise legal admin workspace reference, a single focused responsibility-directory screen for LegalOS. This is a precision daily-use business tool, not a marketing landing page. Style: restrained premium Swiss grid, cool offwhite canvas #f6f8fb, white surfaces, ink #1c293d, one restrained royal blue #315bd6 accent, clear dark Chinese sans-serif typography, no photos, no gradients, no decorative charts, no futuristic art. 8px spacing rhythm, 14px readable body, 24px headings, 1px hairlines and 10px panel radii, compact 44px controls. Existing slim global left sidebar with LegalOS, 数据看板, 成员管理 selected, 定时任务, 审计日志. Main compact top header 成员管理 and secondary text 账号、组织与职责, actions 同步钉钉通讯录 and 预开通成员. Tabs 系统用户 / 分配与路由 selected / 同步记录. Absolutely NO oversized hero, slogan or tall introductory cards. Beneath tabs a slim one-line routing explanation AI 按意图选择能力 / 人工按业务职责分配, with link 路由说明. Main work area starts high on screen and occupies most viewport: left column 270px wide labeled 法务人员 · 6 with compact search; six clearly visible compact rows with square initial avatars and names 彭宇欣, 陈东, 李潇潇 (selected), 刁英楠, 孙文弘, 王玉. Each row 56px tall with short business subtitle and chevron, no tiny metrics. All six names must fit within the first viewport at ordinary desktop height. Right detail panel header 李潇潇 / 法务 BP, tags BaaS业务线 and 生态合作部. One calm compact status note: 业务范围已明确，尚未关联钉钉组织. A short responsibility description, and prominent organization mapping table: heading 业务范围与组织关联, columns 已明确的业务范围 / 钉钉关联状态; rows BaaS BG and 生态合作部, both tagged 待同步组织 not 待完善. Each row secondary text 部门信息尚未同步，职责范围无需重复填写. Small distinguishable section 关联步骤: 同步组织 → 核验账号与部门 → 应用分配规则. Right top action 应用分配规则. Footer unobtrusive note 未匹配或冲突的工单交法务领导处理. Show accurate hierarchy, usable empty/error affordances, subtle selection background, no fake analytics. The design solves hidden people caused by large intro and horizontal-only scrolling. All information inside a single coherent admin directory screen, no page montage. Flat front-facing production UI screenshot, no device frame or watermark.
```
