import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConsultationContextBuilder,
  CONSULT_SYSTEM_PROMPT,
  estimateTokens,
} from '../src/modules/project/application/consultation-context-builder';

/**
 * 咨询多轮上下文构建（阶段1）：
 * - 历史完整问答进上下文（两轮指代）；未回答/失败的问答排除
 * - role=legal → assistant 上下文 + 「人工法务回复」标注
 * - 当前消息只在最后出现一次；顺序 system → 历史 → 当前
 * - 最近 CONSULT_RECENT_TURNS 轮窗口，q/a 不拆对
 * - 项目隔离：按 projectId 过滤
 */

function makePrisma() {
  return {
    consultationRun: { findMany: vi.fn() },
    projectMessage: { findMany: vi.fn() },
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { get: (k: string, d: unknown) => (k in overrides ? overrides[k] : d) } as any;
}

function msg(id: string, role: string, text: string, index: number) {
  return { id, projectId: 'p1', role, text, createdAt: new Date(Date.UTC(2026, 7, 12, 0, 0, index)), label: null };
}

describe('ConsultationContextBuilder', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let builder: ConsultationContextBuilder;

  it('P1-1：P2 system prompt 不强制四段式固定模板（自然回答）', () => {
    expect(CONSULT_SYSTEM_PROMPT).not.toContain('严格按四段式输出');
    expect(CONSULT_SYSTEM_PROMPT).not.toContain('### 核心结论');
    expect(CONSULT_SYSTEM_PROMPT).not.toContain('只输出一份四段式回答');
    // 明确要求自然回答 + 保留身份与免责声明
    expect(CONSULT_SYSTEM_PROMPT).toContain('自然直接');
    expect(CONSULT_SYSTEM_PROMPT).toContain('企业法务顾问');
    expect(CONSULT_SYSTEM_PROMPT).toContain('免责声明');
  });

  beforeEach(() => {
    prisma = makePrisma();
    builder = new ConsultationContextBuilder(prisma as any, makeConfig());
  });

  it('两轮指代：第二问的 messages 包含第一轮完整问答', async () => {
    const m1 = msg('m1', 'user', '客户要求把付款期限改成90天，有什么风险？', 1);
    const a1 = msg('a1', 'assistant', '已分析：90天付款期限存在逾期风险……', 2);
    const m2 = msg('m2', 'user', '那如果对方是国企呢？', 3);
    prisma.consultationRun.findMany.mockResolvedValue([{ userMessageId: 'm1', answerMessageId: 'a1' }]);
    prisma.projectMessage.findMany.mockResolvedValue([m1, a1, m2]);

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'm2' });

    expect(result.messages).toEqual([
      { role: 'system', content: CONSULT_SYSTEM_PROMPT },
      { role: 'user', content: m1.text },
      { role: 'assistant', content: a1.text },
      { role: 'user', content: m2.text },
    ]);
    expect(result.includedMessageIds).toEqual(['m1', 'a1', 'm2']);
    expect(result.summaryVersion).toBeNull();
    expect(result.contextPolicyVersion).toBe('v1');
  });

  it('未回答/失败的问答排除：user 无 succeeded run 不进历史', async () => {
    const m1 = msg('m1', 'user', '问题A', 1);
    const a1 = msg('a1', 'assistant', '回答A', 2);
    const m2 = msg('m2', 'user', '问题B(未回答)', 3);
    const m3 = msg('m3', 'user', '当前问题', 4);
    prisma.consultationRun.findMany.mockResolvedValue([{ userMessageId: 'm1', answerMessageId: 'a1' }]);
    prisma.projectMessage.findMany.mockResolvedValue([m1, a1, m2, m3]);

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'm3' });

    const texts = result.messages.map((m) => m.content);
    expect(texts).toContain('问题A');
    expect(texts).toContain('回答A');
    expect(texts).not.toContain('问题B(未回答)');
    expect(texts[texts.length - 1]).toBe('当前问题'); // 当前消息最后
    expect(texts.filter((t) => t === '当前问题')).toHaveLength(1); // 不重复
  });

  it('role=legal 人工法务回复 → assistant 上下文 + 标注', async () => {
    const l1 = msg('l1', 'legal', '这是法务BP的正式意见。', 1);
    const m2 = msg('m2', 'user', '当前问题', 2);
    prisma.consultationRun.findMany.mockResolvedValue([]);
    prisma.projectMessage.findMany.mockResolvedValue([l1, m2]);

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'm2' });

    expect(result.messages).toEqual([
      { role: 'system', content: CONSULT_SYSTEM_PROMPT },
      { role: 'assistant', content: '（人工法务回复）这是法务BP的正式意见。' },
      { role: 'user', content: '当前问题' },
    ]);
  });

  it('窗口：只保留最近 CONSULT_RECENT_TURNS 轮完整问答，q/a 不拆对', async () => {
    builder = new ConsultationContextBuilder(prisma as any, makeConfig({ CONSULT_RECENT_TURNS: 2 }));
    const rows = [
      msg('q1', 'user', 'Q1', 1), msg('a1', 'assistant', 'A1', 2),
      msg('q2', 'user', 'Q2', 3), msg('a2', 'assistant', 'A2', 4),
      msg('q3', 'user', 'Q3', 5), msg('a3', 'assistant', 'A3', 6),
      msg('q4', 'user', 'Q4', 7), msg('a4', 'assistant', 'A4', 8),
      msg('cur', 'user', '当前', 9),
    ];
    prisma.consultationRun.findMany.mockResolvedValue([
      { userMessageId: 'q1', answerMessageId: 'a1' },
      { userMessageId: 'q2', answerMessageId: 'a2' },
      { userMessageId: 'q3', answerMessageId: 'a3' },
      { userMessageId: 'q4', answerMessageId: 'a4' },
    ]);
    prisma.projectMessage.findMany.mockResolvedValue(rows);

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'cur' });

    const contents = result.messages.map((m) => m.content);
    expect(contents).toEqual([
      CONSULT_SYSTEM_PROMPT,
      'Q3', 'A3',
      'Q4', 'A4',
      '当前',
    ]);
    expect(result.includedMessageIds).toEqual(['q3', 'a3', 'q4', 'a4', 'cur']);
  });

  it('超输入上限 → 从最旧完整问答开始丢（不拆对）', async () => {
    const rows = [
      msg('q1', 'user', 'Q1', 1), msg('a1', 'assistant', 'A1', 2),
      msg('q2', 'user', 'Q2', 3), msg('a2', 'assistant', 'A2', 4),
      msg('cur', 'user', '当前CUR', 5),
    ];
    prisma.consultationRun.findMany.mockResolvedValue([
      { userMessageId: 'q1', answerMessageId: 'a1' },
      { userMessageId: 'q2', answerMessageId: 'a2' },
    ]);
    prisma.projectMessage.findMany.mockResolvedValue(rows);

    // 估算基于真实 messages（P2b）：2 轮全量 vs 保留最近 1 轮
    const fullEstimate =
      estimateTokens(CONSULT_SYSTEM_PROMPT + 'Q1A1Q2A2当前CUR') + 6;
    const onePairEstimate =
      estimateTokens(CONSULT_SYSTEM_PROMPT + 'Q2A2当前CUR') + 4;
    expect(fullEstimate).toBeGreaterThan(onePairEstimate);
    builder = new ConsultationContextBuilder(
      prisma as any,
      makeConfig({ CONSULT_CONTEXT_MAX_TOKENS: fullEstimate - 1 }),
    );

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'cur' });

    const contents = result.messages.map((m) => m.content);
    expect(contents).toEqual([CONSULT_SYSTEM_PROMPT, 'Q2', 'A2', '当前CUR']);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(fullEstimate - 1);
  });

  it('P2a：当前问题过长可裁剪到零条历史，仍返回 system+当前', async () => {
    const rows = [
      msg('q1', 'user', 'Q1', 1), msg('a1', 'assistant', 'A1', 2),
      msg('cur', 'user', '当前'.repeat(60), 3), // 当前问题本身超预算
    ];
    prisma.consultationRun.findMany.mockResolvedValue([
      { userMessageId: 'q1', answerMessageId: 'a1' },
    ]);
    prisma.projectMessage.findMany.mockResolvedValue(rows);
    // 上限 = 仅够 system + 当前（不带历史）
    const bareEstimate = estimateTokens(CONSULT_SYSTEM_PROMPT + '当前'.repeat(60)) + 2;
    builder = new ConsultationContextBuilder(
      prisma as any,
      makeConfig({ CONSULT_CONTEXT_MAX_TOKENS: bareEstimate }),
    );

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'cur' });

    const contents = result.messages.map((m) => m.content);
    expect(contents).toEqual([CONSULT_SYSTEM_PROMPT, '当前'.repeat(60)]); // 历史被裁剪到零
    expect(result.includedMessageIds).toEqual(['cur']);
  });

  it('项目隔离：查询按 projectId 过滤', async () => {
    prisma.consultationRun.findMany.mockResolvedValue([]);
    prisma.projectMessage.findMany.mockResolvedValue([msg('cur', 'user', '当前', 1)]);

    await builder.build({ projectId: 'p-a', currentUserMessageId: 'cur' });

    expect(prisma.consultationRun.findMany.mock.calls[0][0].where.projectId).toBe('p-a');
    expect(prisma.projectMessage.findMany.mock.calls[0][0].where.projectId).toBe('p-a');
    expect(prisma.projectMessage.findMany.mock.calls[0][0].where.role).toEqual({ in: ['user', 'assistant', 'legal'] });
  });

  it('skillPrompt 注入为第二条 system', async () => {
    prisma.consultationRun.findMany.mockResolvedValue([]);
    prisma.projectMessage.findMany.mockResolvedValue([msg('cur', 'user', '当前', 1)]);

    const result = await builder.build({ projectId: 'p1', currentUserMessageId: 'cur', skillPrompt: '合同技能规则' });

    expect(result.messages[0]).toEqual({ role: 'system', content: CONSULT_SYSTEM_PROMPT });
    expect(result.messages[1]).toEqual({ role: 'system', content: '合同技能规则' });
    expect(result.messages[2]).toEqual({ role: 'user', content: '当前' });
  });
});
