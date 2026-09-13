/* Exercises the built CJS adapter against the real pinned DSH packages, without credentials or a database. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DshService } = require('../dist/src/common/services/dsh.service');
const { DshBaijianToolsService } = require('../dist/src/common/services/dsh-baijian-tools.service');
const { AiExecutionQueueService } = require('../dist/src/common/services/ai-execution-queue.service');
const { DSH_RUNTIME_VERSION, DSH_SESSION_PREFIX } = require('../dist/src/common/services/dsh-runtime');

function completed(handle) {
  return new Promise((resolve, reject) => {
    handle.once('done', resolve);
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('Unexpected cancellation')));
  });
}

async function main() {
  const lock = require('../package-lock.json');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (/node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(name)) assert.equal(entry.version, DSH_RUNTIME_VERSION, name);
  }
  const requests = [];
  let requestError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      assert.deepEqual(request.tools.map((tool) => tool.function.name), ['search_similar_cases']);
      const toolResponse = request.messages.at(-1).role === 'tool';
      const delta = toolResponse
        ? { role: 'assistant', content: 'DSH_RUNTIME_OK' }
        : { role: 'assistant', tool_calls: [{ index: 0, id: `case-${requests.length}`, type: 'function', function: {
          name: 'search_similar_cases', arguments: JSON.stringify({ query: 'synthetic runtime check' }),
        } }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish_reason) => `data: ${JSON.stringify({
        id: `completion-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'runtime-test',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.end(frame(delta, null) + frame({}, toolResponse ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
    } catch (error) {
      requestError = error;
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'legalos-dsh-runtime-'));
  const fixtureConfig = {
    DSH_HOME: home,
    DSH_LLM_PROVIDER: 'runtime-test', DSH_LLM_MODEL: 'runtime-test',
    DSH_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    DSH_LLM_API_KEY: 'local-fixture-not-a-secret',
    AI_EXECUTION_ENABLED: 'true', AI_EXECUTION_CONCURRENCY: 1,
  };
  // Never allow host .env/process.env model settings to override the local HTTP fixture.
  const config = { get: (key, fallback) => fixtureConfig[key] ?? fallback };
  const queue = new AiExecutionQueueService(config);
  let slowTool = false;
  let toolEntered;
  let abortedTools = 0;
  const tools = new DshBaijianToolsService({
    searchCases: async (_query, signal) => {
      if (slowTool) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { abortedTools += 1; reject(signal.reason); }, { once: true });
          toolEntered?.();
        });
      }
      return { toolName: 'ldh_search', status: 'success_empty', count: 0,
        query: 'synthetic runtime check', elapsedMs: 1, records: [] };
    },
  });
  const definitions = tools.createDefinitions.bind(tools);
  tools.createDefinitions = async (...args) => (await definitions(...args)).map((definition) => ({
    ...definition, timeoutMs: 100,
  }));
  let service = new DshService(config, queue, tools);
  try {
    const first = await completed(await service.executeStream('Synthetic first turn', {
      researchCapability: 'similar_case', timeout: 20_000,
    }));
    assert.equal(first.text, 'DSH_RUNTIME_OK');
    assert.ok(first.dshSessionId.startsWith(DSH_SESSION_PREFIX));
    assert.equal(first.toolResults[0].result.status, 'success_empty');
    // Cold resume verifies the JSONL path and format, not just the in-memory registry.
    await service.close();
    service = new DshService(config, queue, tools);
    const second = await completed(await service.executeStream('Synthetic followup turn', {
      researchCapability: 'similar_case', resumeDshSessionId: first.dshSessionId, timeout: 20_000,
    }));
    assert.equal(second.dshSessionId, first.dshSessionId);
    assert.equal(second.text, 'DSH_RUNTIME_OK');
    assert.equal(requests.length, 4);
    assert.ok(requests[2].messages.some((message) => JSON.stringify(message.content).includes('Synthetic first turn')));
    assert.ok((await readdir(join(home, `sessions-${DSH_RUNTIME_VERSION}`))).length > 0);
    slowTool = true;
    const timeoutFailure = await completed(await service.executeStream('Synthetic timeout turn', {
      researchCapability: 'similar_case', timeout: 20_000,
    })).then(() => assert.fail('Timed-out evidence must not pass'), (error) => error);
    assert.equal(abortedTools, 1);
    assert.equal(timeoutFailure.result.toolResults[0].isError, true);

    const controller = new AbortController();
    const entered = new Promise((resolve) => { toolEntered = resolve; });
    const cancelledHandle = await service.executeStream('Synthetic cancelled turn', {
      researchCapability: 'similar_case', signal: controller.signal, timeout: 20_000,
    });
    const cancelled = new Promise((resolve, reject) => {
      cancelledHandle.once('cancelled', resolve);
      cancelledHandle.once('done', () => reject(new Error('Cancelled turn reported success')));
      cancelledHandle.once('error', reject);
    });
    await entered;
    controller.abort();
    await cancelled;
    assert.equal(abortedTools, 2);
    if (requestError) throw requestError;
    console.log(JSON.stringify({ gate: 'dsh-runtime', version: DSH_RUNTIME_VERSION, status: 'passed',
      checks: ['CJS boot', 'readonly tools', 'tool result metadata', 'committed text', 'JSONL cold resume', 'exact versions', 'tool timeout', 'cancellation'] }));
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
