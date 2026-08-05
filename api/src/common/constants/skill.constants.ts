/**
 * 技能库共享常量（2026-08-04 技能库模块）。
 * DTO 白名单与前端筛选项同源（工程评审决策 OV#2：6 组技能组枚举）。
 */

/** 6 组技能组白名单（PRD 4.7） */
export const SKILL_GROUPS = [
  '合规法务',
  '合同与交易',
  '劳动法务',
  '争议法务',
  '法律研究',
  '知识运营',
] as const;

/** 保留 slug：兜底哨兵 + seed 技能，禁止注册（工程评审决策 OV#2，防与兜底常量/种子冲突） */
export const RESERVED_SLUGS = [
  'general',
  'data-compliance',
  'contract-risk-review',
  'employee-relations',
];

/**
 * 兜底技能常量（不落库）。
 * 语义（工程评审决策 #2）：业务端选择器显示该选项，选中时提交 skillId=null，
 * 后端不注入任何技能段，走现有 buildConsultPrompt。
 */
export const GENERAL_SKILL = {
  slug: 'general',
  name: '通用法务咨询',
};

/** prompt 长度上限（DTO 校验，工程评审决策 F-1） */
export const SKILL_PROMPT_MAX_LENGTH = 4000;
