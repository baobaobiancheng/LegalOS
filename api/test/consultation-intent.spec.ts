import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { ConsultationIntentRouter } from '../src/modules/project/application/consultation-intent.router';
import { CreateProjectMessageDto } from '../src/modules/project/dto/create-project.dto';
import { normalizeConsultationCapabilityChoice } from '../src/modules/project/domain/consultation-capability';

const question = [{ role: 'user' as const, content: '请检索适用法规' }];
const options = { projectId: 'p1', runId: 'r1' };

describe('咨询意图路由契约', () => {
  it.each(['general', 'law_search', 'similar_case'])('只返回允许的 AI 能力 %s', async capability => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ capability }));
    const router = new ConsultationIntentRouter({ complete } as any);
    expect(await router.resolve(question, options)).toBe(capability);
    expect(complete).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxTokens: 200, timeout: 10_000, ...options }));
  });

  it.each(['', 'null', '[]', '{"capability":"admin"}', '{"capability":"auto"}', 'PRIVATE_MODEL_RESPONSE', '{"legalBpId":"u1"}'])('非法输出不降级成无检索回答：%s', async output => {
    const router = new ConsultationIntentRouter({ complete: vi.fn().mockResolvedValue(output) } as any);
    await expect(router.resolve(question, options)).rejects.toThrow('AI 意图识别暂不可用');
  });

  it('读取当前任务及有限历史，将技能系统指令隔离在分类请求外', async () => {
    const complete = vi.fn().mockResolvedValue('```json\n{"capability":"law_search"}\n```');
    const router = new ConsultationIntentRouter({ complete } as any);
    const messages = [
      { role: 'system' as const, content: 'PRIVATE_SKILL_PROMPT' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: 'user' as const, content: `${i}${'X'.repeat(4_000)}` })),
      { role: 'user' as const, content: '再检索最新规定。' + 'Y'.repeat(20_000) },
    ];
    await router.resolve(messages, options);
    const sent = complete.mock.calls[0][0];
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_SKILL_PROMPT');
    const payload = JSON.parse(sent[1].content);
    expect(payload.currentQuestion).toHaveLength(12_000);
    expect(payload.currentQuestion).toMatch(/^再检索最新规定/);
    expect(payload.history).toHaveLength(4);
    expect(payload.history.every((m: any) => m.content.length === 1_500)).toBe(true);
  });

  it('上游故障仅返回安全信息，不泄露模型或请求内容', async () => {
    const router = new ConsultationIntentRouter({ complete: vi.fn().mockRejectedValue(new Error('PRIVATE_SECRET')) } as any);
    await expect(router.resolve(question, options)).rejects.toThrow('AI 意图识别暂不可用');
  });

  it('取消前不调用模型，取消后不返回可执行能力', async () => {
    const abort = new AbortController();
    const complete = vi.fn().mockImplementation(async () => { abort.abort(); return '{"capability":"law_search"}'; });
    const router = new ConsultationIntentRouter({ complete } as any);
    await expect(router.resolve(question, { ...options, signal: abort.signal })).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
    await expect(router.resolve(question, { ...options, signal: abort.signal })).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('缺少本轮用户消息时不调用模型', async () => {
    const complete = vi.fn();
    const router = new ConsultationIntentRouter({ complete } as any);
    await expect(router.resolve([], options)).rejects.toThrow('无法识别本轮任务');
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['auto', 'general', 'law_search', 'similar_case'])('入站接受 %s，未指定默认 auto', async capability => {
    const dto = Object.assign(new CreateProjectMessageDto(), { text: '这是测试问题', capability });
    expect(await validate(dto)).toEqual([]);
    expect(normalizeConsultationCapabilityChoice(undefined)).toBe('auto');
  });
  it('入站拒绝人员标识等未知能力', async () => {
    const dto = Object.assign(new CreateProjectMessageDto(), { text: '这是测试问题', capability: 'yuxin.peng' });
    expect((await validate(dto)).some(error => error.property === 'capability')).toBe(true);
  });
});
