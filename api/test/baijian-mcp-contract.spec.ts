import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaijianMcpClientService } from '../src/common/baijian/baijian-mcp-client.service';
import { BaijianResultNormalizer } from '../src/common/baijian/baijian-result.normalizer';

const fixture = (name: string) => JSON.parse(readFileSync(
  join(__dirname, 'fixtures', 'baijian', name),
  'utf8',
));

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('Baijian MCP SDK offline contract', () => {
  it('完成 initialize/list/call，携带鉴权头并标准化结果', async () => {
    const seenMethods: string[] = [];
    const seenHeaders: Array<{ key?: string; secret?: string }> = [];
    server = createServer((req, res) => {
      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seenHeaders.push({
          key: req.headers['x-app-key'] as string | undefined,
          secret: req.headers['x-app-secret'] as string | undefined,
        });
        seenMethods.push(message.method);
        if (message.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        const result = message.method === 'initialize'
          ? fixture('initialize.result.json')
          : message.method === 'tools/list'
            ? fixture('tools-list.result.json')
            : message.params?.name === 'lawstar_data_professional_detail'
              ? fixture('law-detail-call.result.json')
              : fixture('law-call.result.json');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const values: Record<string, string> = {
      BAIJIAN_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      BAIJIAN_MCP_APP_KEY: 'fixture-key',
      BAIJIAN_MCP_APP_SECRET: 'fixture-secret',
      BAIJIAN_MCP_TIMEOUT_MS: '5000',
    };
    const config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback };
    const client = new BaijianMcpClientService(config as any, new BaijianResultNormalizer());

    const result = await client.searchLaws({ keyword: '劳动合同', page: 1, rows: 1 });

    expect(seenMethods).toEqual(expect.arrayContaining([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]));
    expect(seenHeaders.every((headers) => headers.key === 'fixture-key')).toBe(true);
    expect(seenHeaders.every((headers) => headers.secret === 'fixture-secret')).toBe(true);
    expect(result).toMatchObject({
      status: 'success_hit',
      records: [{ recordId: 'SANITIZED-LAW-ID', lawName: '中华人民共和国劳动合同法' }],
    });

    const detail = await client.getLawDetail({ lawId: 'D6592443DA000EF8D692CE667E947A69' });
    expect(detail).toMatchObject({
      recordId: 'D6592443DA000EF8D692CE667E947A69',
      lawName: '中华人民共和国劳动合同法',
      historyCount: 1,
      basisCount: 1,
      toc: [{ id: 'section0', text: '第一章 总则' }],
      contentBlocks: [
        { id: 'section0', kind: 'heading', text: '第一章 总则' },
        { id: null, kind: 'paragraph', text: '第一条 为了完善劳动合同制度，制定本法。' },
      ],
    });
  });
});
