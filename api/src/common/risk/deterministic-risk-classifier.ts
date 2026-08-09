import { RiskLevel } from '@prisma/client';
import { RISK_RULES } from './risk-rules';

/**
 * 确定性风险下限分类器（P1-11）：对输入文本做纯规则匹配，返回风险下限与命中的规则 ID。
 * 不依赖模型输出，因此提示词注入无法让高风险问题降级。
 */
export interface RuleHit {
  floor: RiskLevel;
  matchedRuleIds: string[];
  matchedReasons: string[];
}

const SEVERITY: Record<RiskLevel, number> = { P0: 2, P1: 1, P2: 0 };

export function maxSeverity(a: RiskLevel | null | undefined, b: RiskLevel | null | undefined): RiskLevel {
  const sa = a ? SEVERITY[a] : -1;
  const sb = b ? SEVERITY[b] : -1;
  return sa >= sb ? (a ?? 'P1') : (b ?? 'P1');
}

export class DeterministicRiskClassifier {
  /** 规范化：小写 + 去所有空白（中文关键词匹配更稳） */
  private normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, '');
  }

  classify(text: string | undefined | null): RuleHit {
    if (!text) return { floor: 'P2', matchedRuleIds: [], matchedReasons: [] };
    const normalized = this.normalize(text);
    let floor: RiskLevel = 'P2';
    const matchedRuleIds: string[] = [];
    const matchedReasons: string[] = [];

    for (const rule of RISK_RULES) {
      const hit = rule.keywords.some((kw) => normalized.includes(this.normalize(kw)));
      if (hit) {
        matchedRuleIds.push(rule.ruleId);
        matchedReasons.push(rule.reason);
        if (SEVERITY[rule.floor] > SEVERITY[floor]) floor = rule.floor;
      }
    }
    return { floor, matchedRuleIds, matchedReasons };
  }
}
