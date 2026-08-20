import { ContractElementsDto } from './dto/create-contract.dto';
import { injectSkillSection } from '../../common/utils/skill-prompt';

/**
 * 合同 prompt 纯函数构建器（从 ContractService 抽出，2026-08-20 上帝类拆分）。
 *
 * 全部为无状态纯函数：模板占位符填充（起草）、风险审查 prompt（可注入技能段）、
 * 要素摘要文本。ContractService 只调用这些导出函数，不再持有 prompt 组装逻辑。
 */

export function hasAnyElement(e: ContractElementsDto): boolean {
  return !!(e.partyA || e.partyB || e.amount || e.term || e.clauses);
}

export function buildElementsText(e: ContractElementsDto): string {
  const fields: [string, string | undefined][] = [
    ['甲方', e.partyA], ['乙方', e.partyB], ['金额', e.amount], ['期限', e.term],
    ['甲方通讯地址', e.partyAAddress], ['甲方授权代表', e.partyARepresentative],
    ['甲方经办人', e.partyAContact], ['甲方联系电话', e.partyATel], ['甲方电子邮件', e.partyAEmail],
    ['乙方通讯地址', e.partyBAddress], ['乙方联系人', e.partyBContact], ['乙方联系电话', e.partyBTel],
    ['服务内容', e.serviceContent], ['结算方式', e.settlement], ['特殊条款', e.specialClauses],
    ['保密信息范围', e.confidentialScope], ['项目名称', e.projectName],
    ['经费与支付方式', e.payment], ['交付物与验收', e.deliverable], ['知识产权', e.ipOwnership],
    ['主要条款', e.clauses],
  ];
  const filled = fields.filter(([, v]) => v && v.trim());
  return '合同要素摘要：\n' + filled.map(([k, v]) => `${k}：${v}`).join('\n');
}

/** 用模板 prompt + 要素填充起草 prompt（⚠️ 必须覆盖所有模板占位符，漏掉则 AI 看到字面量） */
export function buildDraftPrompt(
  templatePrompt: string,
  e: ContractElementsDto,
  slug?: string,
  name?: string,
): string {
  const fill = (s?: string) => (s && s.trim()) || '【待补充】';
  let filled = templatePrompt
    .split('{partyA}').join(fill(e.partyA))
    .split('{partyB}').join(fill(e.partyB))
    .split('{amount}').join(fill(e.amount))
    .split('{term}').join(fill(e.term))
    .split('{clauses}').join(fill(e.clauses))
    .split('{serviceContent}').join(fill(e.serviceContent))
    .split('{settlement}').join(fill(e.settlement))
    .split('{specialClauses}').join(fill(e.specialClauses))
    .split('{confidentialScope}').join(fill(e.confidentialScope))
    .split('{projectName}').join(fill(e.projectName))
    .split('{payment}').join(fill(e.payment))
    .split('{deliverable}').join(fill(e.deliverable))
    .split('{ipOwnership}').join(fill(e.ipOwnership))
    .split('{partyAAddress}').join(fill(e.partyAAddress))
    .split('{partyARepresentative}').join(fill(e.partyARepresentative))
    .split('{partyAContact}').join(fill(e.partyAContact))
    .split('{partyATel}').join(fill(e.partyATel))
    .split('{partyAEmail}').join(fill(e.partyAEmail))
    .split('{partyBAddress}').join(fill(e.partyBAddress))
    .split('{partyBContact}').join(fill(e.partyBContact))
    .split('{partyBTel}').join(fill(e.partyBTel));

  // 指示 AI 读取工作区内的模板原文（工程决策 2026-08-03，替代全文注入 prompt）
  if (slug) {
    filled += `\n\n## 模板原文参照\n工作区内 templates/${slug}.md 为《${name || slug}》公司审定模板原文，请用文件读取工具读取该文件，并严格参照其章节结构与条款口径起草，不得偏离模板表述。`;
  }
  return filled;
}

/** 法务端 AI 风险审查 prompt（技能指令段注入顶部，工程决策 #3/#5） */
export function buildReviewPrompt(text: string, skillName?: string, skillPrompt?: string): string {
  const base = `你是企业合同审查专家。审查下方合同内容，逐条识别法律风险。

## 输出格式（每条风险独立成块）
### 第 N 条 · {条款标题}
- 原文摘要：…
- 风险等级：【高/中/低】
- 风险分析：…
- 修改建议：…

## 审查要点
- 违约责任、责任上限、违约金比例是否失衡
- 知识产权归属与许可范围
- 保密条款、竞业限制的合理性与可执行性
- 付款节点与交付验收的对应关系
- 争议解决条款（管辖法院/仲裁）的合法性
- 是否有明显违反强制性法律法规的条款

## 结尾
输出"总体评价"：该合同整体风险等级（高/中/低）+ 必须修改的核心条款清单

## 合同内容
${text}`;
  // 技能段由共享 util 注入（含边界标记剥除）
  return injectSkillSection(base, skillName ?? '', skillPrompt ?? '');
}
