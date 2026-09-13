import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AiExecutionQueueService } from '../src/common/services/ai-execution-queue.service';
import {
  DshExecutionHandle,
  DshResearchEvidenceError,
  DshService,
  validateResearchEvidence,
} from '../src/common/services/dsh.service';
import { DSH_BAIJIAN_RESULT_META_KIND } from '../src/common/services/dsh-baijian-tools.service';
import { DSH_SESSION_PREFIX } from '../src/common/services/dsh-runtime';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('DshService 法律检索执行契约', () => {
  it('没有成功的法规检索结果时拒绝生成分析', () => {
    expect(() => validateResearchEvidence(
      'law_search',
      '模型回答',
      [],
      [{ name: 'search_laws', isError: true, result: undefined }] as any[],
    )).toThrow('未产生成功的法规检索结果');
  });

  it('命中候选但未读取权威详情正文时拒绝生成分析', () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    expect(() => validateResearchEvidence(
      'law_search',
      JSON.stringify({ answer: '根据已检索法规，需要结合财产性质进一步分析。', evidenceQuotes: [] }),
      [{ callId: '1', name: 'search_laws', arguments: {} }],
      [{ name: 'search_laws', isError: false, result: { records: [{ recordId: lawId }] } }] as any[],
    )).toThrow('命中法规后未读取权威正文');
  });

  it('读取任一权威详情正文后，不再校验来源 ID、候选关联、引文文字或工具调用白名单', () => {
    const candidateId = 'D6592443DA000EF8D692CE667E947A69';
    const detailId = 'E4A4956751D374FD35D0CEA47C041313';
    const citedId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(() => validateResearchEvidence(
      'law_search',
      JSON.stringify({
        answer: '《某法》规定：“这是一段并不存在于详情正文中的文字。”',
        sections: [{ title: '结论', content: '依法处理。', sourceIds: [citedId] }],
        evidenceQuotes: [{ recordId: citedId, article: '第一条', text: '虚构引文' }],
      }),
      [
        { callId: '1', name: 'search_laws', arguments: {} },
        { callId: '2', name: 'get_law_detail', arguments: { lawId: detailId } },
        { callId: '3', name: 'other_tool', arguments: {} },
      ] as any[],
      [
        { name: 'search_laws', isError: false, result: { records: [{ recordId: candidateId }] } },
        { name: 'get_law_detail', isError: false, result: { recordId: detailId, contentBlocks: [{ text: '权威详情正文。' }] } },
      ] as any[],
    )).not.toThrow();
  });

  it('零命中时只要求检索成功，不再检查回答声明', () => {
    const calls: any[] = [{ callId: '1', name: 'search_laws_semantic', arguments: { query: '问题' } }];
    const results: any[] = [{ name: 'search_laws_semantic', isError: false, result: { records: [] } }];
    expect(() => validateResearchEvidence(
      'law_search',
      '依据一般知识分析',
      calls,
      results,
    )).not.toThrow();
  });

  it('转发原生工具事件，并把本轮标准化结果放入权威 completion', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const normalized = {
      toolName: 'lawstar_data_professional_query',
      status: 'success_hit',
      count: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1,
      records: [{
        source: 'lawstar', recordId: lawId, lawName: '中华人民共和国劳动合同法',
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
      publish({ type: 'tool/call', data: { callId: 'call-2', name: 'get_law_detail', arguments: JSON.stringify({ lawId }) } });
      publish({
        type: 'tool/result',
        data: {
          message: { content: [{ type: 'tool-result', toolCallId: 'call-2', isError: false }] },
          meta: { kind: DSH_BAIJIAN_RESULT_META_KIND, result: {
            toolName: 'lawstar_data_professional_detail', recordId: lawId,
            lawName: '中华人民共和国劳动合同法', contentBlocks: [{ kind: 'paragraph', id: null, text: '第八十七条 应当支付赔偿金。' }], toc: [],
          } },
        },
      });
      publish({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `> [法规原文｜ID:${lawId}｜条文:第八十七条] 应当支付赔偿金。` }] } },
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
    const researchText: string[] = [];
    const displayText: string[] = [];
    handle.on('tool_call', (event) => calls.push(event));
    handle.on('tool_result', (event) => results.push(event));
    handle.on('research_text', (delta) => researchText.push(delta));
    handle.on('text', (delta) => displayText.push(delta));
    const completion = await completionOf(handle);

    expect(harness.register).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { callId: 'call-1', name: 'search_laws', arguments: { keyword: '劳动合同' } },
      { callId: 'call-2', name: 'get_law_detail', arguments: { lawId } },
    ]);
    expect(results[0]).toMatchObject({ callId: 'call-1', name: 'search_laws', isError: false, result: normalized });
    expect(completion.text).toBe(`> [法规原文｜ID:${lawId}｜条文:第八十七条] 应当支付赔偿金。`);
    expect(researchText).toEqual([`> [法规原文｜ID:${lawId}｜条文:第八十七条] 应当支付赔偿金。`]);
    expect(displayText).toEqual([]);
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

    await expect(completionOf(handle)).rejects.toThrow('未产生成功的法规检索结果');
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('工具调用超过单轮硬上限时取消 Agent 并返回错误', async () => {
    const harness = makeHarness(({ publish }) => {
      for (let index = 1; index <= 6; index += 1) {
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

    const failure = await completionOf(handle).then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(DshResearchEvidenceError);
    expect(failure).toMatchObject({
      message: 'dsh Agent 工具调用超过上限（5）',
      result: {
        dshSessionId: expect.any(String),
        toolCalls: expect.arrayContaining([{ callId: 'call-1', name: 'search_laws', arguments: {} }]),
        toolResults: [],
      },
    });
    expect(harness.cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'dsh Agent 工具调用超过上限（5）',
    });
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('宿主结束时释放常驻 dsh Context，重复关闭为幂等操作', async () => {
    const harness = makeHarness(() => undefined);
    (harness.service as any).bootPromise = Promise.resolve(harness.ctx);

    await harness.service.close();
    await harness.service.close();

    expect(harness.rootDispose).toHaveBeenCalledOnce();
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
      resumeDshSessionId: `${DSH_SESSION_PREFIX}existing`,
    });
    const completion = await completionOf(handle);

    expect(harness.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: `${DSH_SESSION_PREFIX}existing` }));
    expect(harness.create).not.toHaveBeenCalled();
    expect(completion.dshSessionId).toBe(`${DSH_SESSION_PREFIX}existing`);
  });

  it('不读取旧版本持久会话', async () => {
    const harness = makeHarness(() => undefined);
    const handle = await harness.service.executeStream('继续', { resumeDshSessionId: 'legalos-old' });
    await expect(completionOf(handle)).rejects.toThrow('不属于当前运行时版本');
    expect(harness.resume).not.toHaveBeenCalled();
  });

  it('失败的 assistant/attempt 不进入正文，重试成功只发布一次', async () => {
    const harness = makeHarness(({ session, publish }) => {
      publish({ type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: '废弃片段' }] } } });
      publish({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '成功回答' }] } } });
      session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });
    const handle = await harness.service.executeStream('测试重试');
    const text: string[] = [];
    handle.on('text', (delta) => text.push(delta));
    expect((await completionOf(handle)).text).toBe('成功回答');
    expect(text).toEqual(['成功回答']);
  });

  it('本轮缺少正文时不能拿上一轮回答冒充成功', async () => {
    const harness = makeHarness(({ session }) => {
      session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });
    harness.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '历史回答' }] } } });
    const handle = await harness.service.executeStream('继续', { resumeDshSessionId: `${DSH_SESSION_PREFIX}existing` });
    await expect(completionOf(handle)).rejects.toThrow('本轮没有已提交的回答正文');
  });

  it('持久化失败或释放失败时只发 error，不能先 done 后 error', async () => {
    for (const phase of ['flush', 'dispose'] as const) {
      const harness = makeHarness(({ session }) => {
        session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } });
        session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      });
      harness[phase].mockRejectedValueOnce(new Error(`${phase} failed`));
      const handle = await harness.service.executeStream('测试收尾');
      const done = vi.fn();
      handle.on('done', done);
      await expect(completionOf(handle)).rejects.toThrow(`${phase} failed`);
      expect(done).not.toHaveBeenCalled();
      expect(harness.dispose).toHaveBeenCalledOnce();
    }
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
  const toolDefinitions = [toolDefinition, { name: 'get_law_detail' }];
  const tools = { createDefinitions: vi.fn().mockResolvedValue(toolDefinitions) };
  const listeners = new Set<(session: any, event: any) => void>();
  const register = vi.fn();
  const create = vi.fn();
  const resume = vi.fn();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const session = { id: '', events: [] as any[] };
  Object.assign(session, { snapshotEvents: () => session.events.slice() });
  const flush = vi.fn().mockResolvedValue(true);
  let followed = false;
  let finished = false;
  const publish = (event: any) => {
    session.events.push(event);
    for (const listener of listeners) listener(session, event);
  };
  const cancel = vi.fn((cause: unknown) => {
    session.events.push({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: cause } } });
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
  const rootDispose = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    fiber: { dispose: rootDispose },
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
      if (key === 'sessions') return { flush };
      return undefined;
    }),
    on: vi.fn((_event: string, listener: (session: any, event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  Object.assign(ctx, { agents: ctx.get('agents'), agentDefaultModel: ctx.get('agentDefaultModel'), sessions: ctx.get('sessions') });
  const service = new DshService(config as any, queue, tools as any);
  (service as any).ensureBooted = vi.fn().mockResolvedValue(ctx);
  return { service, register, dispose, cancel, toolDefinition, create, resume, ctx, rootDispose, session, flush };
}

function completionOf(handle: DshExecutionHandle): Promise<any> {
  return new Promise((resolve, reject) => {
    handle.once('done', resolve);
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('unexpected cancellation')));
  });
}
