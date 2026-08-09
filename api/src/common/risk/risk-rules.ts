import { RiskLevel } from '@prisma/client';

/**
 * 确定性风险下限规则（P1-11）。
 *
 * 原则：风险等级 P0 > P1 > P2。规则给出"最低风险等级"，模型只允许把风险调高，
 * 不允许调低（`finalRisk = maxSeverity(ruleFloor, modelRisk)`）。
 * 提示词注入/否定表达/引用文本都不能让规则降级——规则是确定性的，独立于模型输出。
 *
 * 关键词设计避免宽泛词造成误报（如不用裸"刑事""争议"），用较具体的短语。
 */

export interface RiskRule {
  /** 稳定规则 ID（审计可追溯） */
  ruleId: string;
  /** 规则版本（规则变更时递增，审计记录 classifierVersion 可追溯） */
  version: number;
  /** 风险下限 */
  floor: RiskLevel;
  /** 命中原因（中文，写入审计） */
  reason: string;
  /** 关键词（对规范化后的文本做 includes 匹配） */
  keywords: string[];
}

export const RISK_RULES_VERSION = '1.0.0';

export const RISK_RULES: RiskRule[] = [
  // ── P0 下限 ──────────────────────────────────────────────
  {
    ruleId: 'R001',
    version: 1,
    floor: 'P0',
    reason: '刑事犯罪/公安司法机关调查',
    keywords: [
      '刑事犯罪', '刑事立案', '刑事侦查', '刑事拘留', '刑拘', '逮捕',
      '公安', '检察院', '警方', '公安机关', '监察委', '传唤', '立案侦查',
    ],
  },
  {
    ruleId: 'R002',
    version: 1,
    floor: 'P0',
    reason: '监管立案执法/紧急禁令',
    keywords: ['监管立案', '执法调查', '紧急禁令', '禁止令', '强制措施'],
  },
  {
    ruleId: 'R003',
    version: 1,
    floor: 'P0',
    reason: '重大安全事故',
    keywords: ['重大安全事故', '安全事故', '爆炸', '重大责任事故'],
  },
  // ── P1 下限 ──────────────────────────────────────────────
  {
    ruleId: 'R101',
    version: 1,
    floor: 'P1',
    reason: '数据出境/跨境传输',
    keywords: ['数据出境', '跨境传输', '数据跨境', '数据出境评估', '出境'],
  },
  {
    ruleId: 'R102',
    version: 1,
    floor: 'P1',
    reason: '个人信息重大风险',
    keywords: ['个人信息泄露', '个人信息保护', '个人信息安全', '隐私泄露'],
  },
  {
    ruleId: 'R103',
    version: 1,
    floor: 'P1',
    reason: '诉讼/仲裁',
    keywords: ['诉讼', '仲裁', '起诉', '应诉', '被执行', '强制执行'],
  },
  {
    ruleId: 'R104',
    version: 1,
    floor: 'P1',
    reason: '并购股权',
    keywords: ['并购', '股权收购', '股权转让', '控股'],
  },
  {
    ruleId: 'R105',
    version: 1,
    floor: 'P1',
    reason: '无限责任/连带责任',
    keywords: ['无限责任', '连带责任', '无限连带'],
  },
  {
    ruleId: 'R106',
    version: 1,
    floor: 'P1',
    reason: '竞业限制',
    keywords: ['竞业限制', '竞业禁止'],
  },
];
