import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsultationChatService } from '../src/common/services/consultation-chat.service';

/**
 * 咨询直连网关流式客户端（2026-08-12，契约记录 C3-C9）：
 * - delta.reasoning → thinking 流；delta.content → text 流；[DONE] → close(0)+__finalText
 * - 首帧 role 标记帧（content:""）不产生输出
 * - Kill Switch / 未配置 / 网关 HTTP 错误 → close(1)；客户端断开 → close(0)+__cancelled
 * - 请求体正确（messages/stream/max_tokens），日志不含正文
 */

type Env = Record<string, string>;

function makeService(env: Env): ConsultationChatService {
  const config = {
    get: (key: string, def?: unknown) => (key in env ? env[key] : def),
  };
  return new ConsultationChatService(config as any);
}

/** 用帧数组构造一个 mock SSE Response（真实 Response + ReadableStream） */
function sseResponse(frames: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(new TextEncoder().encode(f + '\n'));
      controller.close();
    },
  });
  return new Response(body, { status });
}

/** 等待流结束并收集全部输出 */
async function collect(stream: any) {
  let text = '';
  let thinking = '';
  stream.stdout.on('data', (c: Buffer) => (text += c.toString()));
  stream.thinking.on('data', (c: Buffer) => (thinking += c.toString()));
  const code: number = await new Promise((res) => stream.on('close', res));
  return { text, thinking, code, finalText: stream.__finalText, cancelled: stream.__cancelled };
}

const baseEnv: Env = {
  LLM_BASE_URL: 'http://api-cybotforge-pre.brapp.com/v1',
  LLM_API_KEY: 'sk-test',
  LLM_MODEL: 'glm-5-2',
  AI_EXECUTION_ENABLED: 'true',
};

const chunk = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-2', choices: [{ index: 0, delta, finish_reason: null }] })}`;

const frames = (deltas: Record<string, unknown>[]): string[] => [...deltas.map(chunk), 'data: [DONE]'];

describe('ConsultationChatService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reasoning 帧 → thinking 流；content 帧 → text 流；[DONE] → close(0) + __finalText', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(
        frames([
          { role: 'assistant', content: '' }, // C7 角色标记帧，不产生输出
          { reasoning: '思考一' },
          { reasoning: '思考二' },
          { content: '答案一' },
          { content: '答案二' },
        ]),
      ),
    );
    vi.stubGlobal('fetch', mockFetch);

    const service = makeService(baseEnv);
    const stream = await service.stream([{ role: 'user', content: '问题' }], { runId: 'r1', projectId: 'p1' });
    const out = await collect(stream);

    expect(out.thinking).toBe('思考一思考二');
    expect(out.text).toBe('答案一答案二');
    expect(out.code).toBe(0);
    expect(out.finalText).toBe('答案一答案二');
    expect(out.cancelled).toBeUndefined();
  });

  it('请求体正确：model / messages / stream / max_tokens(取 CONSULT_OUTPUT_TOKEN_RESERVE)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(frames([{ content: '好' }])));
    vi.stubGlobal('fetch', mockFetch);

    const service = makeService({ ...baseEnv, CONSULT_OUTPUT_TOKEN_RESERVE: '5000' });
    const stream = await service.stream(
      [
        { role: 'system', content: '规则' },
        { role: 'user', content: '问题' },
      ],
      { runId: 'r2' },
    );
    await collect(stream);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('glm-5-2');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(5000);
    expect(body.messages).toEqual([
      { role: 'system', content: '规则' },
      { role: 'user', content: '问题' },
    ]);
    expect(String(init.headers.authorization)).toBe('Bearer sk-test');
  });

  it('AI Kill Switch 关闭 → close(1)，不请求网关', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const service = makeService({ ...baseEnv, AI_EXECUTION_ENABLED: 'false' });

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('未配置 LLM_BASE_URL → close(1)，不请求网关', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const env = { ...baseEnv };
    delete env.LLM_BASE_URL;
    const service = makeService(env);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('空 messages → close(1)', async () => {
    const service = makeService(baseEnv);
    const stream = await service.stream([]);
    const out = await collect(stream);
    expect(out.code).toBe(1);
  });

  it('网关 HTTP 500 → close(1)', async () => {
    // 延迟 resolve：让 collect 的 close 监听器先挂上（避免 mock 瞬时 resolve 抢在监听前完成）
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((res) => setTimeout(() => res(new Response('gateway boom', { status: 500 })), 5)),
      ),
    );
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(1);
  });

  it('P0-4：连续完全重复的大段 → 只保留第一份 + __repeatGuard', async () => {
    const block = '甲'.repeat(210);
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(frames([{ content: block }, { content: block }])), // 同一大段出现两次
    );
    vi.stubGlobal('fetch', mockFetch);
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(0);
    // 不再出现完整重复的两份；长度 < 2×block（截断边界可能在块内）
    expect(out.finalText!.length).toBeLessThan(block.length * 2);
    expect(out.finalText!.length).toBeGreaterThan(block.length);
    expect(stream.__repeatGuard).toBe(true);
  });

  it('P0-4：免责声明重复 → finalText 只剩一份', async () => {
    const d = '> ⚠️ 本答复由AI生成，不构成正式法律意见。如需正式法务意见，请联系法务BP确认。';
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(frames([{ content: `正文\n${d}\n${d}` }])));
    vi.stubGlobal('fetch', mockFetch);
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(0);
    const count = out.finalText!.split('本答复由AI生成').length - 1;
    expect(count).toBe(1); // 末尾最多一次
    expect(out.finalText).toContain('正文');
  });

  it('F1：EOF 未收到 [DONE]（半段答案）→ close(1)，不得保存截断答复', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse([
        chunk({ reasoning: '思考' }),
        chunk({ content: '半段' }), // 无 [DONE] 即结束
      ]),
    );
    vi.stubGlobal('fetch', mockFetch);
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.code).toBe(1);
    expect(out.finalText).toBeUndefined();
  });

  it('F2：请求超时 → close(1)（失败），不视为取消', async () => {
    // fetch 挂起，只有超时 abort 才 reject
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: any) =>
        new Promise((_res, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      ),
    );
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }], { timeout: 50 });
    const out = await collect(stream);

    expect(out.code).toBe(1);
    expect(out.cancelled).toBeUndefined(); // 超时不是取消
  });

  it('客户端断开(signal.abort) → close(0) + __cancelled，不视为失败', async () => {
    // fetch 挂起，只有 signal 触发 abort 才 reject
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: any) =>
        new Promise((_res, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      ),
    );
    const service = makeService(baseEnv);
    const ac = new AbortController();

    const stream = await service.stream([{ role: 'user', content: '问题' }], { signal: ac.signal });
    // 等待 fetch 挂起后再 abort，模拟 SSE 连接断开
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    const out = await collect(stream);
    expect(out.code).toBe(0);
    expect(out.cancelled).toBe(true);
  });

  it('非 data: 行与坏 JSON 帧忽略，不影响正常内容', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse([
        ': keep-alive 注释',
        chunk({ content: 'a' }),
        'not-json-line',
        'data: {bad json',
        chunk({ content: 'b' }),
        'data: [DONE]',
      ]),
    );
    vi.stubGlobal('fetch', mockFetch);
    const service = makeService(baseEnv);

    const stream = await service.stream([{ role: 'user', content: '问题' }]);
    const out = await collect(stream);

    expect(out.text).toBe('ab');
    expect(out.code).toBe(0);
  });
});
