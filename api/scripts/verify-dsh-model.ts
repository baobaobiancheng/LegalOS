import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { AiExecutionQueueService } from '../src/common/services/ai-execution-queue.service';
import { DshExecutionHandle, DshService } from '../src/common/services/dsh.service';
import { DshBaijianToolsService } from '../src/common/services/dsh-baijian-tools.service';
import { BaijianMcpClientService } from '../src/common/baijian/baijian-mcp-client.service';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';

async function main() {
  if (!process.env.DSH_LLM_API_KEY && !process.env.LLM_API_KEY && !process.env.CODEX_API_KEY) {
    throw new Error('缺少 DSH_LLM_API_KEY（或兼容的 LLM_API_KEY / CODEX_API_KEY）');
  }
  process.env.AI_EXECUTION_ENABLED = 'true';
  const config = new ConfigService(process.env);
  const baijian = new BaijianMcpClientService(config, new BaijianResultNormalizer());
  const service = new DshService(
    config,
    new AiExecutionQueueService(config),
    new DshBaijianToolsService(baijian),
  );
  const handle = await service.executeStream(
    '这是模型连通性检查。不要调用工具，只回复：DSH_MODEL_OK',
    { sessionId: 'dsh-model-gate', timeout: 60_000 },
  );
  const text = await waitForCompletion(handle);
  if (!text.includes('DSH_MODEL_OK')) throw new Error('模型返回内容不符合连通性检查契约');
  console.log(JSON.stringify({
    gate: 'dsh-model',
    status: 'passed',
    provider: process.env.DSH_LLM_PROVIDER || 'legalos-dsh',
    model: process.env.DSH_LLM_MODEL || process.env.LLM_MODEL || 'glm-5-2',
  }, null, 2));
}

function waitForCompletion(handle: DshExecutionHandle): Promise<string> {
  return new Promise((resolve, reject) => {
    handle.once('done', (result) => resolve(result.text));
    handle.once('error', reject);
    handle.once('cancelled', () => reject(new Error('dsh 模型检查已取消')));
  });
}

main().catch((error) => {
  console.error(JSON.stringify({
    code: 'DSH_MODEL_GATE_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
