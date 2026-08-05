import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMRiskService } from '../src/common/services/llm-risk.service';

/**
 * LLM 风险+领域双标签（2026-08-05 工程评审决策 #11）：
 * - 双标签解析：风险 P0/P1/P2 + 领域白名单
 * - 领域非白名单 → null（未匹配）
 * - 风险解析失败 → 默认 P1/legalbp（安全优先，回归：现有行为）
 */

const mockCodex = (output: string) => ({
  execute: vi.fn().mockResolvedValue(output),
});

describe('LLMRiskService 双标签', () => {
  let codex: any;

  beforeEach(() => {
    codex = mockCodex('风险:P1 领域:合规法务');
  });

  it('双标签解析：risk + domain', async () => {
    const service = new LLMRiskService(codex);
    const r = await service.assess('数据出境问题');
    expect(r).toEqual({ risk: 'P1', route: 'legalbp', domain: '合规法务' });
  });

  it('P2 → llm 路由（回归：现有分级语义不变）', async () => {
    codex = mockCodex('风险:P2 领域:合同与交易');
    const service = new LLMRiskService(codex);
    const r = await service.assess('合同条款询问');
    expect(r).toEqual({ risk: 'P2', route: 'llm', domain: '合同与交易' });
  });

  it('P0 → legalbp（回归：紧急升级）', async () => {
    codex = mockCodex('风险:P0 领域:争议法务');
    const service = new LLMRiskService(codex);
    const r = await service.assess('被起诉了');
    expect(r.risk).toBe('P0');
    expect(r.route).toBe('legalbp');
  });

  it('领域非白名单 → domain null（未匹配走兜底）', async () => {
    codex = mockCodex('风险:P1 领域:税务咨询');
    const service = new LLMRiskService(codex);
    const r = await service.assess('税务问题');
    expect(r.domain).toBeNull();
    expect(r.risk).toBe('P1');
  });

  it('风险解析失败 → 默认 P1/legalbp（安全优先，回归）', async () => {
    codex = mockCodex('我不知道怎么分类');
    const service = new LLMRiskService(codex);
    const r = await service.assess('未知问题');
    expect(r.risk).toBe('P1');
    expect(r.route).toBe('legalbp');
    expect(r.domain).toBeNull();
  });

  it('LLM 调用异常 → 默认 P1/legalbp（回归：现有兜底）', async () => {
    codex = { execute: vi.fn().mockRejectedValue(new Error('codex down')) };
    const service = new LLMRiskService(codex);
    const r = await service.assess('任何问题');
    expect(r).toEqual({ risk: 'P1', route: 'legalbp', domain: null });
  });

  it('全角冒号也兼容', async () => {
    codex = mockCodex('风险：P2　领域：知识运营');
    const service = new LLMRiskService(codex);
    const r = await service.assess('知识库制度');
    expect(r).toEqual({ risk: 'P2', route: 'llm', domain: '知识运营' });
  });
});
