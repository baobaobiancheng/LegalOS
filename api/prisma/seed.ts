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
    displayName: '系统管理员',
  },
  {
    username: 'legal_bp',
    password: process.env.SEED_LEGAL_BP_PASSWORD || 'legal123',
    role: Role.legal_bp,
    displayName: '法务BP-张三',
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
    displayName: '业务-王五',
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
