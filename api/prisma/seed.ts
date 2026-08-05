import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * 种子用户（设计文档「种子用户」表）
 * v0.0.1 密码从环境变量注入，生产部署前需改为强密码 + 首次登录强制改密
 */
const seedUsers = [
  {
    username: 'admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'admin123',
    role: Role.admin,
    displayName: '赵俊芳', // 2026-08-05 钉钉拉群：真实姓名（姓名匹配钉钉通讯录前提）
  },
  {
    username: 'legal_bp',
    password: process.env.SEED_LEGAL_BP_PASSWORD || 'legal123',
    role: Role.legal_bp,
    displayName: '彭宇欣', // 2026-08-05 钉钉拉群：真实姓名（姓名匹配钉钉通讯录前提）
  },
  {
    username: 'legal_lead',
    password: process.env.SEED_LEGAL_LEAD_PASSWORD || 'legal123',
    role: Role.legal_lead,
    displayName: '法务负责人-李四',
  },
  {
    username: 'business',
    password: process.env.SEED_BUSINESS_PASSWORD || 'biz123',
    role: Role.business,
    displayName: '田强', // 2026-08-05 钉钉拉群：真实姓名（姓名匹配钉钉通讯录前提）
  },
];

/**
 * 合同模板种子（2026-08-03 模板升级：替换为公司法务真实模板）
 * 3 个新模板：ai-service / nda-institution / tech-dev
 * 旧模板（channel-cooperation/tech-service/nda）在 main() 中停用（isActive=false）
 */
const seedTemplates = [
  {
    slug: 'ai-service',
    name: '百融AI服务协议',
    category: 'AI服务',
    description: '百融AI服务协议【主协议】- AI服务/硅基员工/智能体搭建',
    prompt: `你是企业合同起草专家。基于下方合同要素，按《百融AI服务协议》的标准章节结构起草合同草稿。

## 合同要素
- 甲方：{partyA}（通讯地址：{partyAAddress}；授权代表：{partyARepresentative}；经办人：{partyAContact}；电话：{partyATel}；邮箱：{partyAEmail}）
- 乙方：{partyB}（通讯地址：{partyBAddress}；联系人：{partyBContact}；电话：{partyBTel}）
- 服务内容：{serviceContent}
- 服务期限：{term}
- 结算方式：{settlement}
- 特殊条款：{specialClauses}

## 标准章节结构（必须完整保留以下章节）
一、服务内容
二、结算条款
三、甲方权利义务
四、乙方权利义务
五、知识产权与保密
六、违约责任
七、不可抗力与免责条款
八、其他条款

## 公司审定条款口径（关键条款按此表述）
- 甲方承诺遵守《网络安全法》《数据安全法》《个人信息保护法》《生成式人工智能服务管理暂行办法》等法律法规，不得输入、利用服务输出或传播违法不良信息
- 乙方对产品及服务享有法律规定范围内的全部权利（知识产权）；双方对合作相关的保密信息严格保密
- 争议解决：友好协商，协商不成向有管辖权的人民法院起诉

## 铁律（违反即不合格，严禁违反）
1. 严格只使用用户提供的合同要素，不得推测、编造任何实事（主体信息、金额、期限、地址、联系人、证照号码等）
2. 用户未提供的实事一律标注【待补充】或【以双方确认为准】，严禁自行填写
3. 条款表述（权利义务、违约责任、知识产权等）按公司审定口径撰写，不得引入模板外的新义务或新权利
4. 生成完成后统计【待补充】数量（仅供系统提示使用，严禁写入合同正文）

## 输出要求
1. 按模板章节结构输出完整合同，Markdown 格式（## 章节标题 + 条款序号）
2. 要素嵌入对应条款，未提供的实事标注【待补充】
3. **严格只输出合同正文本身**，禁止输出任何说明、解释、处理过程、章节对齐说明、笔误修正说明等元叙述；**禁止在正文末尾追加免责声明、待补充统计等提示文字**（这些由系统单独提示）`,
    style: {
      pageMargin: { top: 1440, right: 1558, bottom: 1276, left: 1800 },
      body: { fontEastAsia: '楷体', fontAscii: 'Arial', sizePt: 10.5, lineSpacing: 1.5 },
      partyInfo: { fontEastAsia: '楷体', fontAscii: 'Arial', sizePt: 12, bold: true },
      heading: { fontEastAsia: '楷体', fontAscii: 'Arial', sizePt: 10.5, bold: true },
    },
    elementsSchema: [
      // 基本信息（核心要素，必填）
      { key: 'partyA', label: '甲方名称', type: 'text', required: true, group: 'basic', placeholder: '如：大同证券有限责任公司' },
      { key: 'partyB', label: '乙方名称', type: 'text', required: true, group: 'basic', placeholder: '如：百融至信（北京）科技有限公司' },
      { key: 'serviceContent', label: '服务内容', type: 'textarea', required: true, group: 'basic', placeholder: '描述 AI 服务/硅基员工/智能体搭建的具体内容…' },
      { key: 'term', label: '服务期限', type: 'text', required: false, group: 'basic', placeholder: '如：自签署之日起 1 年' },
      // 甲方详细信息（选填，填了进合同，不填标注【待补充】）
      { key: 'partyAAddress', label: '甲方通讯地址', type: 'text', required: false, group: 'details' },
      { key: 'partyARepresentative', label: '甲方授权代表', type: 'text', required: false, group: 'details' },
      { key: 'partyAContact', label: '甲方经办人', type: 'text', required: false, group: 'details' },
      { key: 'partyATel', label: '甲方联系电话', type: 'text', required: false, group: 'details' },
      { key: 'partyAEmail', label: '甲方电子邮件', type: 'text', required: false, group: 'details' },
      // 乙方详细信息（选填）
      { key: 'partyBAddress', label: '乙方通讯地址', type: 'text', required: false, group: 'details' },
      { key: 'partyBContact', label: '乙方联系人', type: 'text', required: false, group: 'details' },
      { key: 'partyBTel', label: '乙方联系电话', type: 'text', required: false, group: 'details' },
      // 其他
      { key: 'settlement', label: '结算方式', type: 'textarea', required: false, group: 'details', placeholder: '如：按附件报价结算' },
      { key: 'specialClauses', label: '特殊条款', type: 'textarea', required: false, group: 'details', placeholder: '补充您特别关注的条款' },
    ],
    sourceFile: '1-（AI业务通用模板）【主协议】百融AI服务协议.docx',
  },
  {
    slug: 'nda-institution',
    name: '保密协议 V4.5（机构合作端）',
    category: '保密',
    description: '机构间保密协议 V4.5，覆盖保密信息/例外/责任/返还等完整条款',
    prompt: `你是企业合同起草专家。基于下方合同要素，按《保密协议 V4.5》的标准章节结构起草合同草稿。

## 合同要素
- 甲方（机构）：{partyA}（通讯地址：{partyAAddress}）
- 乙方（机构）：{partyB}（通讯地址：{partyBAddress}）
- 保密信息范围：{confidentialScope}
- 保密期限：{term}
- 特殊条款：{specialClauses}

## 标准章节结构（必须完整保留以下章节）
第一条 保密信息内容
第二条 保密信息例外
第三条 保密责任主体
第四条 保密责任
第五条 例外使用
第六条 未经授权不得访问
第七条 保密信息的返还
第八条 违约责任
第九条 转让
第十条 协议期限
第十一条 适用法律
第十二条 争议解决
第十三条 修改
第十四条 其他

## 铁律（违反即不合格，严禁违反）
1. 严格只使用用户提供的合同要素，不得推测、编造任何实事（主体信息、期限、地址、联系人等）
2. 用户未提供的实事一律标注【待补充】或【以双方确认为准】，严禁自行填写
3. 条款表述按模板审定口径撰写，不得引入模板外的新义务或新权利
4. 生成完成后统计【待补充】数量（仅供系统提示使用，严禁写入合同正文）

## 输出要求
1. 按模板章节结构输出完整合同，Markdown 格式（## 章节标题 + 条款序号）
2. 要素嵌入对应条款，未提供的实事标注【待补充】
3. **严格只输出合同正文本身**，禁止输出任何说明、解释、处理过程、章节对齐说明、笔误修正说明等元叙述；**禁止在正文末尾追加免责声明、待补充统计等提示文字**（这些由系统单独提示）`,
    style: {
      pageMargin: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
      body: { fontEastAsia: '楷体', fontAscii: 'Arial', sizePt: 10.5, lineSpacing: 1.5 },
      heading: { fontEastAsia: '楷体', fontAscii: 'Arial', sizePt: 10.5, bold: true },
    },
    elementsSchema: [
      { key: 'partyA', label: '甲方（机构）', type: 'text', required: true, group: 'basic', placeholder: '机构名称' },
      { key: 'partyB', label: '乙方（机构）', type: 'text', required: true, group: 'basic', placeholder: '机构名称' },
      { key: 'term', label: '保密期限', type: 'text', required: false, group: 'basic', placeholder: '如：自签署之日起 2 年' },
      { key: 'partyAAddress', label: '甲方通讯地址', type: 'text', required: false, group: 'details' },
      { key: 'partyBAddress', label: '乙方通讯地址', type: 'text', required: false, group: 'details' },
      { key: 'confidentialScope', label: '保密信息范围', type: 'textarea', required: false, group: 'details', placeholder: '默认按模板定义，可补充' },
      { key: 'specialClauses', label: '特殊条款', type: 'textarea', required: false, group: 'details' },
    ],
    sourceFile: '（2026-02月）5-【保密协议V4.5】保密协议书（机构合作端）.docx',
  },
  {
    slug: 'tech-dev',
    name: '技术开发合同（联合建模通用版）',
    category: '技术开发',
    description: '联合建模项目技术开发合同通用版，覆盖定义/项目内容/经费/验收/知识产权等 16 章',
    prompt: `你是企业合同起草专家。基于下方合同要素，按《联合建模项目技术开发合同》的标准章节结构起草合同草稿。

## 合同要素
- 甲方（委托人）：{partyA}
- 乙方（开发方）：{partyB}
- 项目名称：{projectName}
- 开发内容：{serviceContent}
- 经费与支付方式：{payment}
- 交付物与验收：{deliverable}
- 知识产权：{ipOwnership}
- 开发周期：{term}

## 标准章节结构（必须完整保留以下章节）
第一条 定义
第二条 项目内容
第三条 项目开发计划
第四条 项目研究开发经费、报酬及其支付方式
第五条 项目验收的标准和方式
第六条 甲方陈述与保证
第七条 乙方陈述与保证
第八条 培训
第九条 远程维护和技术支持
第十条 知识产权
第十一条 保密义务
第十二条 违约责任
第十三条 争议解决
第十四条 合同生效、变更、解除及终止
第十五条 不可抗力
第十六条 其他

## 铁律（违反即不合格，严禁违反）
1. 严格只使用用户提供的合同要素，不得推测、编造任何实事（主体信息、金额、期限、地址、联系人、证照号码等）
2. 用户未提供的实事一律标注【待补充】或【以双方确认为准】，严禁自行填写
3. 条款表述按模板审定口径撰写，不得引入模板外的新义务或新权利
4. 生成完成后统计【待补充】数量（仅供系统提示使用，严禁写入合同正文）

## 输出要求
1. 按模板章节结构输出完整合同，Markdown 格式（## 章节标题 + 条款序号）
2. 要素嵌入对应条款，未提供的实事标注【待补充】
3. **严格只输出合同正文本身**，禁止输出任何说明、解释、处理过程、章节对齐说明、笔误修正说明等元叙述；**禁止在正文末尾追加免责声明、待补充统计等提示文字**（这些由系统单独提示）`,
    style: {
      pageMargin: { top: 623, right: 879, bottom: 1304, left: 1418 },
      body: { fontEastAsia: '楷体_GB2312', fontAscii: '宋体', sizePt: 14 },
      heading: { fontEastAsia: '黑体', fontAscii: 'Times', sizePt: 18, bold: true },
    },
    elementsSchema: [
      { key: 'partyA', label: '甲方（委托人）', type: 'text', required: true, group: 'basic', placeholder: '委托方机构名称' },
      { key: 'partyB', label: '乙方（开发方）', type: 'text', required: true, group: 'basic', placeholder: '开发方机构名称' },
      { key: 'projectName', label: '项目名称', type: 'text', required: true, group: 'basic', placeholder: '如：联合建模项目' },
      { key: 'serviceContent', label: '开发内容', type: 'textarea', required: true, group: 'basic', placeholder: '需求分析、设计、开发、调试、测试、上线和远程维护…' },
      { key: 'term', label: '开发周期', type: 'text', required: false, group: 'basic', placeholder: '如：自签署之日起 3 个月' },
      { key: 'payment', label: '经费与支付方式', type: 'textarea', required: false, group: 'details', placeholder: '如：含税总价人民币 XX 万元，里程碑付款' },
      { key: 'deliverable', label: '交付物与验收', type: 'textarea', required: false, group: 'details', placeholder: '验收标准与流程' },
      { key: 'ipOwnership', label: '知识产权', type: 'textarea', required: false, group: 'details', placeholder: '默认按模板条款' },
      { key: 'specialClauses', label: '特殊条款', type: 'textarea', required: false, group: 'details' },
    ],
    sourceFile: '（2026-02）联合建模项目-技术开发合同-通用版.docx',
  },
];

/**
 * 技能库种子（2026-08-04 技能库模块，工程评审决策：只 seed 3 项核心技能精修跑通，
 * 其余 15 项（PRD 4.7）入 TODOS 后补）。creatorId 运行时绑定 admin。
 * prompt 铁律：不编造实事/未提供标注【需确认】/法条真实/禁元叙述（对齐合同模板升级口径）。
 */
const seedSkills = [
  {
    slug: 'data-compliance',
    name: '数据合规评估',
    group: '合规法务',
    description: '评估数据处理活动（收集/存储/使用/传输/跨境/AI训练）的合规性，输出风险点+法律依据+整改建议。',
    prompt: `你是数据合规评估专家。针对用户描述的数据处理活动（数据收集、存储、使用、加工、传输、提供、公开、删除等），评估其合规性。

## 输出结构（严格三段式）
### 一、风险点
逐条列出识别的合规风险，每条含：涉及的数据类型、处理环节、风险描述
### 二、法律依据
每条风险对应援引具体法律条文：《个人信息保护法》《数据安全法》《网络安全法》《民法典》及行业监管规定（AI 场景援引《生成式人工智能服务管理暂行办法》）
### 三、整改建议
按优先级（高/中/低）给出可落地整改措施，说明整改后的合规状态

## 评估要点
- 合法基础：处理个人信息是否具有《个人信息保护法》第13条规定的合法性基础（同意/合同/法定义务/紧急情况等）
- 最小必要：收集范围是否限于实现目的的最小必要
- 告知同意：是否履行告知义务，同意是否充分知情、自愿、明确
- 安全措施：是否采取与风险相适应的技术和管理措施
- 跨境传输：涉及境外传输时是否完成安全评估/认证/标准合同备案
- AI 场景：涉及 AI 训练/生成时，评估《生成式人工智能服务管理暂行办法》合规要求（数据来源合法性、内容安全、标注义务等）
- 员工数据：涉及员工个人信息时，评估劳动合同与规章制度依据

## 铁律（违反即不合格，严禁违反）
1. 严格基于用户提供的描述评估，不得虚构数据处理场景
2. 用户未提供的环节（如是否已获同意）标注【需确认】，不得默认存在或不存在
3. 法条引用必须真实准确，不得编造条文内容或条文号
4. 输出末尾统计【需确认】数量（仅供系统提示使用，严禁写入正文）`,
  },
  {
    slug: 'contract-risk-review',
    name: '合同风险审查',
    group: '合同与交易',
    description: '逐条识别合同条款法律风险，输出风险等级+分析+修改建议（违约责任/知识产权/保密/争议解决等）。',
    prompt: `你是企业合同审查专家。对用户提供的合同条款/合同文本逐条识别法律风险。

## 输出结构（每条风险独立成块）
### 第 N 条 · {条款标题}
- 原文摘要：…
- 风险等级：【高/中/低】
- 风险分析：从法律后果、商业影响、可执行性三方面分析
- 修改建议：给出可直接替换的条款表述建议

## 审查要点
- 违约责任、责任上限、违约金比例是否失衡
- 知识产权归属与许可范围是否明确
- 保密条款、竞业限制的合理性与可执行性
- 付款节点与交付验收的对应关系
- 争议解决条款（管辖法院/仲裁）的合法性
- 不可抗力条款的适用范围
- 是否有明显违反强制性法律法规的条款
- 合同主体资质与签署权限

## 铁律（违反即不合格，严禁违反）
1. 严格基于用户提供的合同内容审查，不得推测合同不存在的条款
2. 用户未提供的合同部分标注【需提供】，不得假设其内容
3. 法条引用必须真实准确，不得编造
4. 审查结论基于中国法律（民法典合同编等）`,
  },
  {
    slug: 'employee-relations',
    name: '员工关系咨询',
    group: '劳动法务',
    description: '用工关系咨询（招聘/在职/离职/争议/竞业），输出结论+法律依据+操作建议。',
    prompt: `你是劳动法务专家。针对用户描述的用工关系问题（招聘、入职、在职管理、离职、争议等）提供专业咨询意见。

## 输出结构（严格三段式）
### 一、结论
先给出明确结论（合法/不合法/需补手续/建议协商等），一句话回答核心问题
### 二、法律依据
援引《劳动合同法》《劳动合同法实施条例》《劳动法》《社会保险法》及相关司法解释、地方规定
### 三、操作建议
按步骤给出可落地操作：文书模板要点、时间节点、风险提示

## 咨询要点
- 劳动关系 vs 劳务关系 vs 承揽关系认定
- 试用期、劳动合同期限与订立时点
- 解除情形（协商解除/过失性辞退/无过失性辞退/经济性裁员）与补偿标准
- 竞业限制与保密协议的范围、期限、补偿金
- 加班工资、年休假、社保公积金合规
- 员工违纪处理与规章制度民主程序

## 铁律（违反即不合格，严禁违反）
1. 严格基于用户提供的案情回答，不得虚构事实细节
2. 用户未提供的关键事实（如是否签合同、员工工龄）标注【需确认】，结论注明依赖该事实
3. 法条引用必须真实准确，不得编造
4. 涉及仲裁/诉讼时效的，提示时效风险`,
  },
];

async function main() {
  for (const item of seedUsers) {
    const passwordHash = await bcrypt.hash(item.password, 10);
    await prisma.user.upsert({
      where: { username: item.username },
      update: { passwordHash, role: item.role, displayName: item.displayName },
      create: {
        username: item.username,
        passwordHash,
        role: item.role,
        displayName: item.displayName,
      },
    });
    console.log(`seeded: ${item.username} (${item.role})`);
  }

  // BP 领域映射（2026-08-05 钉钉拉群）：法务 BP 彭宇欣 → 合规法务（知识产权/数据合规归入该组）
  const bpUser = await prisma.user.findUnique({ where: { username: 'legal_bp' } });
  if (bpUser) {
    await prisma.bpDomainMap.upsert({
      where: { userId_domain: { userId: bpUser.id, domain: '合规法务' } },
      update: {},
      create: { userId: bpUser.id, domain: '合规法务' },
    });
    console.log('seeded: bp domain map (彭宇欣 → 合规法务)');
  }

  // 技能库种子（creatorId 绑定 admin，视为已审核直接 public）
  const admin = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (admin) {
    for (const s of seedSkills) {
      await prisma.skill.upsert({
        where: { slug: s.slug },
        update: {
          name: s.name,
          group: s.group,
          description: s.description,
          prompt: s.prompt,
          visibility: 'public',
          isActive: true,
          creatorId: admin.id,
        },
        create: {
          ...s,
          visibility: 'public',
          creatorId: admin.id,
        },
      });
      console.log(`seeded skill: ${s.slug}`);
    }
  }

  // 2026-08-03 模板升级：停用旧通用模板（历史工单不受影响）
  for (const oldSlug of ['channel-cooperation', 'tech-service', 'nda']) {
    const r = await prisma.contractTemplate.updateMany({
      where: { slug: oldSlug },
      data: { isActive: false },
    });
    if (r.count > 0) console.log(`deactivated old template: ${oldSlug}`);
  }

  for (const t of seedTemplates) {
    await prisma.contractTemplate.upsert({
      where: { slug: t.slug },
      update: {
        name: t.name,
        category: t.category,
        description: t.description,
        prompt: t.prompt,
        style: t.style as any,
        elementsSchema: t.elementsSchema as any,
        sourceFile: t.sourceFile,
        isActive: true,
      },
      create: t as any,
    });
    console.log(`seeded contract template: ${t.slug}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
