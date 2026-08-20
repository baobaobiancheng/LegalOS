import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AiExecutionQueueService } from '../src/common/services/ai-execution-queue.service';
import { DshExecutionHandle, DshService } from '../src/common/services/dsh.service';
import { DSH_BAIJIAN_RESULT_META_KIND } from '../src/common/services/dsh-baijian-tools.service';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('DshService 法律检索执行契约', () => {
  it('转发原生工具事件，并把本轮标准化结果放入权威 completion', async () => {
    const normalized = {
      toolName: 'lawstar_data_professional_query',
      status: 'success_hit',
      count: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1,
      records: [{
        source: 'lawstar', recordId: 'law-1', lawName: '中华人民共和国劳动合同法',
        issuingOrgan: '全国人大常委会', issuingNo: null, releaseDate: null,
        implementDate: null, timeliness: '现行有效',
      }],
    };
    const harness = makeHarness(({ session, publish }) => {
      publish({
        type: 'tool/call',
        data: { callId: 'call-1', name: 'search_laws', arguments: JSON.stringify({ keyword: '劳动合同' }) },
      });
      publish({
        type: 'tool/result',
        data: {
          message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false }] },
          meta: { kind: DSH_BAIJIAN_RESULT_META_KIND, result: normalized },
        },
      });
      publish({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '{"answer":"结论"}' } } });
      session.events.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '{"answer":"权威结论"}' }] } },
      });
      session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });

    const handle = await harness.service.executeStream('请检索', {
      sessionId: 'project-1',
      researchCapability: 'law_search',
      requireResearchTool: true,
    });
    const calls: any[] = [];
    const results: any[] = [];
    handle.on('tool_call', (event) => calls.push(event));
    handle.on('tool_result', (event) => results.push(event));
    const completion = await completionOf(handle);

    expect(harness.register).toHaveBeenCalledWith(harness.toolDefinition);
    expect(calls).toEqual([{ callId: 'call-1', name: 'search_laws', arguments: { keyword: '劳动合同' } }]);
    expect(results[0]).toMatchObject({ callId: 'call-1', name: 'search_laws', isError: false, result: normalized });
    expect(completion.text).toBe('{"answer":"权威结论"}');
    expect(completion.toolResults[0].result).toEqual(normalized);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('已选择检索能力但模型未调用工具时 fail-closed', async () => {
    const harness = makeHarness(({ session }) => {
      session.events.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '凭模型常识直接回答' }] } },
      });
      session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });
    const handle = await harness.service.executeStream('请检索', {
      researchCapability: 'law_search',
      requireResearchTool: true,
    });

    await expect(completionOf(handle)).rejects.toThrow('未产生必需工具结果：search_laws');
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('工具调用超过单轮硬上限时取消 Agent 并返回错误', async () => {
    const harness = makeHarness(({ publish }) => {
      for (let index = 1; index <= 4; index += 1) {
        publish({
          type: 'tool/call',
          data: { callId: `call-${index}`, name: 'search_laws', arguments: '{}' },
        });
      }
    });
    const handle = await harness.service.executeStream('反复检索', {
      researchCapability: 'law_search',
      requireResearchTool: true,
    });

    await expect(completionOf(handle)).rejects.toThrow('工具调用超过上限（3）');
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('传入持久会话 ID 时使用 dsh resume，而不是创建同名新会话', async () => {
    const harness = makeHarness(({ session, publish }) => {
      publish({
        type: 'tool/call',
        data: { callId: 'case-1', name: 'search_similar_cases', arguments: '{"query":"劳动合同"}' },
      });
      publish({
        type: 'tool/result',
        data: {
          message: { content: [{ type: 'tool-result', toolCallId: 'case-1', isError: false }] },
          meta: {
            kind: DSH_BAIJIAN_RESULT_META_KIND,
            result: { toolName: 'ldh_search', status: 'success_empty', count: 0, query: '劳动合同', elapsedMs: 1, records: [] },
          },
        },
      });
      session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '未找到案例' }] } } });
      session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });
    const handle = await harness.service.executeStream('继续检索', {
      researchCapability: 'similar_case',
      resumeDshSessionId: 'legalos-existing',
    });
    const completion = await completionOf(handle);

    expect(harness.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'legalos-existing' }));
    expect(harness.create).not.toHaveBeenCalled();
    expect(completion.dshSessionId).toBe('legalos-existing');
  });
});

function makeHarness(
  finishTurn: (input: { session: any; publish: (event: any) => void }) => void,
) {
  const home = mkdtempSync(join(tmpdir(), 'legalos-dsh-service-'));
  homes.push(home);
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        DSH_HOME: home,
        AI_EXECUTION_ENABLED: 'true',
        AI_EXECUTION_CONCURRENCY: '1',
      };
      return key in values ? values[key] : fallback;
    }),
  };
  const queue = new AiExecutionQueueService(config as any);
  const toolDefinition = { name: 'search_laws' };
  const tools = { createDefinition: vi.fn().mockResolvedValue(toolDefinition) };
  const listeners = new Set<(session: any, event: any) => void>();
  const register = vi.fn();
  const create = vi.fn();
  const resume = vi.fn();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const session = { id: '', events: [] as any[] };
  let followed = false;
  let finished = false;
  const publish = (event: any) => {
    session.events.push(event);
    for (const listener of listeners) listener(session, event);
  };
  const cancel = vi.fn(() => {
    session.events.push({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  });
  const agent = {
    session,
    followup: vi.fn(() => { followed = true; }),
    cancel,
    whenIdle: vi.fn(async () => {
      if (followed && !finished) {
        finished = true;
        finishTurn({ session, publish });
      }
    }),
  };
  const ctx = {
    get: vi.fn((key: string) => {
      if (key === 'agents') return {
        create: async (options: any) => {
          create(options);
          session.id = options.sessionId;
          options.setup({
            tools: { register },
            on: vi.fn(() => () => undefined),
          });
          return { agent, dispose };
        },
        resume: async (options: any) => {
          resume(options);
          session.id = options.resumeSessionId;
          options.setup({ tools: { register }, on: vi.fn(() => () => undefined) });
          return { agent, dispose };
        },
      };
      if (key === 'agentDefaultModel') return {
        currentSelection: () => ({ provider: 'test', model: 'test-model' }),
      };
      if (key === 'sessions') return { flush: vi.fn().mockResolvedValue(undefined) };
      return undefined;
    }),
    on: vi.fn((_event: string, listener: (session: any, event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const service = new DshService(config as any, queue, tools as any);
  (service as any).ensureBooted = vi.fn().mockResolvedValue(ctx);
  return { service, register, dispose, cancel, toolDefinition, create, resume };
}

function completionOf(handle: DshExecutionHandle): Promise<any> {
  return new Promise((resolve, reject) => {
    handle.once('done', resolve);
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('unexpected cancellation')));
  });
}
