import { Injectable, Logger } from '@nestjs/common';
import { CodexService } from './codex.service';

export type RiskLevel = 'P0' | 'P1' | 'P2';
export type ProjectRoute = 'llm' | 'legalbp';

@Injectable()
export class LLMRiskService {
  private readonly logger = new Logger(LLMRiskService.name);

  constructor(private readonly codexService: CodexService) {}

  async assess(query: string): Promise<{ risk: RiskLevel; route: ProjectRoute }> {
    const prompt = `判断以下法律咨询问题的风险等级，只回复一个标签（P0/P1/P2），不要任何解释：

P0（紧急）：涉及刑事犯罪、监管执法调查、紧急法院禁令、重大安全事故
P1（重要）：涉及无限责任、数据出境、跨境传输、个人信息保护、诉讼仲裁、并购股权、竞业限制
P2（常规）：其他一般法律问题，合规咨询，合同条款询问，政策了解

用户问题：${query}

风险等级：`;

    try {
      const result = await this.codexService.execute(prompt, {
        maxTokens: 5,
        timeout: 30_000,  // Codex CLI 冷启动需要时间
      });
      const trimmed = result.trim().toUpperCase();
      if (trimmed.includes('P0')) return { risk: 'P0', route: 'legalbp' };
      if (trimmed.includes('P1')) return { risk: 'P1', route: 'legalbp' };
      return { risk: 'P2', route: 'llm' };
    } catch (error) {
      this.logger.error(`LLM risk assessment failed, defaulting to P1/legalbp: ${error instanceof Error ? error.message : error}`);
      // 安全优先：分类失败默认升级人工处理
      return { risk: 'P1', route: 'legalbp' };
    }
  }
}
