import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsultationChatService } from './consultation-chat.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SKILL_GROUPS } from '../constants/skill.constants';
import { DeterministicRiskClassifier, maxSeverity } from '../risk/deterministic-risk-classifier';
import { RISK_RULES_VERSION } from '../risk/risk-rules';
import type { RiskLevel } from '@prisma/client';

export type ProjectRoute = 'llm' | 'legalbp';

/** 领域白名单 = SKILL_GROUPS 单一来源（/review 2026-08-05 统一，防多份拷贝漂移） */
export const LEGAL_DOMAINS = SKILL_GROUPS;

/** 分类证据（P1-11）：规则下限 + 命中规则 + 模型结果 + 版本，供审计追溯 */
export interface RiskEvidence {
  ruleFloor: RiskLevel;
  matchedRuleIds: string[];
  modelRisk: RiskLevel | null;
  modelReason: string | null;
  classifierVersion: string;
}

export interface RiskAssessment {
  risk: RiskLevel;
  route: ProjectRoute;
  /** 领域标签（六选一白名单）；解析失败/越界 → null（按未匹配处理） */
  domain: string | null;
  /** 分类证据（P1-11），供工单创建时写 RiskAssessmentLog */
  evidence: RiskEvidence;
}

@Injectable()
export class LLMRiskService {
  private readonly logger = new Logger(LLMRiskService.name);
  private readonly classifier = new DeterministicRiskClassifier();

  private readonly classifyTimeoutMs: number;
  private readonly classifyMaxTokens: number;

  constructor(
    private readonly chat: ConsultationChatService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    // 分类直连网关（2026-08-13 压测调优）：已通过 chat_template_kwargs.enable_thinking=false 关闭思考，
    // 分类秒回(实测 0.7s、completion 7 token)。预算给足余量即可，超时 10s 早于建单请求超时(45s)。
    this.classifyTimeoutMs =
      Number.parseInt(String(this.config?.get('RISK_CLASSIFY_TIMEOUT_MS', '10000') ?? 10000), 10) || 10_000;
    this.classifyMaxTokens =
      Number.parseInt(String(this.config?.get('RISK_CLASSIFY_MAX_TOKENS', '1000') ?? 1000), 10) || 1000;
  }

  /**
   * 风险 + 领域双标签（P1-11 加固）：
   * - 确定性规则给出风险下限（ruleFloor），模型只允许调高，不允许调低：
   *   finalRisk = maxSeverity(ruleFloor, modelRisk)。
   * - 模型输出改为严格 JSON，JSON.parse + 结构校验；解析失败/异常 → 默认 P1（安全优先）。
   */
  async assess(query: string): Promise<RiskAssessment> {
    // 1. 确定性下限（不依赖模型，提示词注入无法降级）
    const ruleHit = this.classifier.classify(query);

    // 2. 模型输出严格 JSON（2026-08-12 改造：直连网关非流式，短超时 15s，绕开 Codex CLI）
    //    契约 C8：max_tokens 含思考；小预算即可出 JSON，分类约 2-6s。
    //    超时/失败 → 下方兜底 P1，不阻塞建单请求（此前 Codex CLI 卡满 90s 导致前端也 90s 超时）。
    let modelRisk: RiskLevel | null = null;
    let modelDomain: string | null = null;
    let modelReason: string | null = null;
    try {
      const raw = await this.chat.complete([{ role: 'user', content: this.buildPrompt(query) }], {
        maxTokens: this.classifyMaxTokens,
        timeout: this.classifyTimeoutMs,
        runId: 'risk-classify',
      });
      ({ modelRisk, modelDomain, modelReason } = this.parseModelJson(raw));
    } catch (error) {
      this.logger.error(
        `LLM risk assessment failed: ${error instanceof Error ? error.message : error}`,
      );
    }

    // 3. 最终风险 = 规则下限与模型结果取更严重者。
    //    模型结果缺失（解析失败/异常/越界）时按 P1 处理（安全优先，不可降为 P2）。
    const effectiveModelRisk: RiskLevel = modelRisk ?? 'P1';
    const risk = maxSeverity(ruleHit.floor, effectiveModelRisk);
    const route: ProjectRoute = risk === 'P2' ? 'llm' : 'legalbp';
    const domain =
      modelDomain && LEGAL_DOMAINS.includes(modelDomain as (typeof SKILL_GROUPS)[number])
        ? modelDomain
        : null;

    return {
      risk,
      route,
      domain,
      evidence: {
        ruleFloor: ruleHit.floor,
        matchedRuleIds: ruleHit.matchedRuleIds,
        modelRisk,
        modelReason,
        classifierVersion: RISK_RULES_VERSION,
      },
    };
  }

  private buildPrompt(query: string): string {
    return `判断以下法律咨询问题的风险等级与所属领域。只输出一行 JSON，不要任何解释、前后缀或多余字符。

输出格式：
{"risk":"P0|P1|P2","domain":"合规法务|合同与交易|劳动法务|争议法务|法律研究|知识运营","reason":"一句话原因"}

风险定义：
P0（紧急）：涉及刑事犯罪、监管执法调查、紧急法院禁令、重大安全事故
P1（重要）：涉及无限责任、数据出境、跨境传输、个人信息保护、诉讼仲裁、并购股权、竞业限制
P2（常规）：其他一般法律问题，合规咨询，合同条款询问，政策了解

用户问题：${query}

只输出 JSON：`;
  }

  /**
   * 解析严格 JSON（P1-11）。只使用 JSON.parse + 结构校验，禁止从任意文本提取正则标签。
   * 先整体 parse；若带 markdown 围栏则先剥围栏；仍失败则提取首个 JSON 对象；再失败 → 全 null。
   */
  private parseModelJson(
    raw: string,
  ): { modelRisk: RiskLevel | null; modelDomain: string | null; modelReason: string | null } {
    const none = { modelRisk: null, modelDomain: null, modelReason: null } as const;
    if (!raw?.trim()) return none;

    const stripFence = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stripFence);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          this.logger.warn(`风险分类 JSON 解析失败（默认 P1）：${raw.slice(0, 80)}`);
          return none;
        }
      } else {
        this.logger.warn(`风险分类输出非 JSON（默认 P1）：${raw.slice(0, 80)}`);
        return none;
      }
    }

    if (typeof parsed !== 'object' || parsed === null) return none;
    const o = parsed as Record<string, unknown>;
    const riskVal = typeof o.risk === 'string' ? o.risk.toUpperCase() : '';
    const modelRisk: RiskLevel | null =
      riskVal === 'P0' ? 'P0' : riskVal === 'P1' ? 'P1' : riskVal === 'P2' ? 'P2' : null;
    const modelDomain = typeof o.domain === 'string' ? o.domain.trim() : null;
    const modelReason =
      typeof o.reason === 'string' ? o.reason.trim().slice(0, 200) : null;
    return { modelRisk, modelDomain, modelReason };
  }
}
