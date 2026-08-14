import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { BaijianMcpClientService } from '../src/common/baijian/baijian-mcp-client.service';
import { BaijianError } from '../src/common/baijian/baijian.types';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';

async function main() {
  requireSecret('BAIJIAN_MCP_APP_KEY');
  requireSecret('BAIJIAN_MCP_APP_SECRET');
  const mode = process.argv[2] ?? 'health';
  const query = process.argv.slice(3).join(' ').trim();
  const service = new BaijianMcpClientService(
    new ConfigService(process.env),
    new BaijianResultNormalizer(),
  );

  const health = await service.health();
  const requiredTools = ['lawstar_data_professional_query', 'ldh_search'];
  for (const tool of requiredTools) {
    if (!health.availableTools.includes(tool)) throw new Error(`百鉴缺少必需工具：${tool}`);
  }
  console.log(JSON.stringify({ gate: 'baijian-sdk', status: 'healthy', ...health }, null, 2));

  if (mode === 'health') return;
  if (!query) throw new Error(`用法：npm run baijian:verify -- ${mode} <查询>`);
  if (mode === 'law') {
    const result = await service.searchLaws({ keyword: query, page: 1, rows: 3 });
    console.log(JSON.stringify({ gate: 'law-search', result }, null, 2));
    return;
  }
  if (mode === 'case') {
    const result = await service.searchCases({ query, topK: 3 });
    console.log(JSON.stringify({ gate: 'case-search', result }, null, 2));
    return;
  }
  throw new Error('模式只能是 health、law 或 case');
}

function requireSecret(name: string): void {
  if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
}

main().catch((error) => {
  const safe = error instanceof BaijianError
    ? { code: error.code, message: error.message, retryable: error.retryable, supplierCode: error.supplierCode }
    : { code: 'VERIFY_FAILED', message: (error as Error).message };
  console.error(JSON.stringify(safe));
  process.exitCode = 1;
});
