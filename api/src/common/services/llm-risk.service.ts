import { Injectable, Logger } from '@nestjs/common';
import { CodexService } from './codex.service';
import { SKILL_GROUPS } from '../constants/skill.constants';

export type RiskLevel = 'P0' | 'P1' | 'P2';
export type ProjectRoute = 'llm' | 'legalbp';

/** 领域白名单 = SKILL_GROUPS 单一来源（/review 2026-08-05 统一，防多份拷贝漂移） */
export const LEGAL_DOMAINS = SKILL_GROUPS;

export interface RiskAssessment {
  risk: RiskLevel;
  route: ProjectRoute;
  /** 领域标签（六选一白名单）；解析失败/越界 → null（按未匹配处理，工程评审决策 #11） */
  domain: string | null;
}

@Injectable()
export class LLMRiskService {
  private readonly logger = new Logger(LLMRiskService.name);

  constructor(private readonly codexService: CodexService) {}

  /** 风险 + 领域双标签（2026-08-05 钉钉拉群：领域供 BP 匹配；仅 legalbp 路由使用） */
  async assess(query: string): Promise<RiskAssessment> {
    const prompt = `判断以下法律咨询问题的风险等级与所属领域，只回复一行两个标签，不要任何解释，格式：风险:P0|P1|P2 领域:${SKILL_GROUPS.join('|')}

风险定义：
P0（紧急）：涉及刑事犯罪、监管执法调查、紧急法院禁令、重大安全事故
P1（重要）：涉及无限责任、数据出境、跨境传输、个人信息保护、诉讼仲裁、并购股权、竞业限制
P2（常规）：其他一般法律问题，合规咨询，合同条款询问，政策了解

领域定义：
合规法务：数据合规、个人信息保护、行业监管合规、知识产权布局
合同与交易：合同审查、交易结构、商务条款
劳动法务：用工、劳动合同、竞业限制、社保
争议法务：诉讼、仲裁、纠纷、维权
法律研究：法规检索、类案研究、法律解读
知识运营：法律知识库、培训、制度文本

用户问题：${query}

风险: 领域:`;

    try {
      const result = await this.codexService.execute(prompt, {
        maxTokens: 30,
        timeout: 30_000, // Codex CLI 冷启动需要时间
      });
      return this.parseAssessment(result);
    } catch (error) {
      this.logger.error(`LLM risk assessment failed, defaulting to P1/legalbp: ${error instanceof Error ? error.message : error}`);
      // 安全优先：分类失败默认升级人工处理（工程评审决策 #11：风险部分失败默认 P1）
      return { risk: 'P1', route: 'legalbp', domain: null };
    }
  }

  /** 解析 "风险:P0 领域:合规法务" 行；风险越界/缺失 → 默认 P1（安全优先）；领域非白名单 → null */
  private parseAssessment(raw: string): RiskAssessment {
    // /review 2026-08-05：风险/领域均取【最后一个】匹配——用户 query 拼在提示词末尾，
    // 恶意输入可诱导模型先输出伪造标签行，取首个匹配会被降级攻击
    const riskMatches = [...raw.matchAll(/风险\s*[:：]\s*(P[012])/gi)];
    const riskMatch = riskMatches.length ? riskMatches[riskMatches.length - 1] : null;
    const risk: RiskLevel = riskMatch?.[1]?.toUpperCase() === 'P0' ? 'P0'
      : riskMatch?.[1]?.toUpperCase() === 'P1' ? 'P1'
      : riskMatch?.[1]?.toUpperCase() === 'P2' ? 'P2'
      : 'P1';
    const route: ProjectRoute = risk === 'P2' ? 'llm' : 'legalbp';

    const domainPattern = new RegExp(`领域\\s*[:：]\\s*(${SKILL_GROUPS.join('|')})`, 'g');
    const domainMatches = [...raw.matchAll(domainPattern)];
    const domainMatch = domainMatches.length ? domainMatches[domainMatches.length - 1] : null;
    const domain = domainMatch ? domainMatch[1] : null;
    if (!domainMatch) {
      this.logger.warn(`领域标签解析失败（按未匹配处理）：${raw.trim().slice(0, 50)}`);
    }
    return { risk, route, domain };
  }
}
