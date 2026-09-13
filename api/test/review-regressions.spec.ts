import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUploadFilename } from '../src/common/utils/upload-filename';
import { ContractController } from '../src/modules/contract/contract.controller';
import { ProjectController } from '../src/modules/project/project.controller';
import { ContractTemplateService } from '../src/modules/contract/contract-template.service';
import { buildDraftPrompt } from '../src/modules/contract/contract-prompt.builder';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import { EscalateProjectToLegalUseCase } from '../src/modules/project/application/escalate-project-to-legal.use-case';
import { ProjectQueryService } from '../src/modules/project/queries/project-query.service';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

afterEach(() => vi.unstubAllEnvs());

describe('审查修复的文件与模板边界', () => {
  it.each(['中文合同.txt', '合同📄.docx', 'café.pdf', 'plain.md'])('保留已解码文件名 %s', (name) => {
    expect(normalizeUploadFilename(name)).toBe(name);
  });
  it('只还原合法 UTF-8 字节并清理路径、控制字符', () => {
    expect(normalizeUploadFilename(Buffer.from('中文合同.txt').toString('latin1'))).toBe('中文合同.txt');
    expect(normalizeUploadFilename('../a\u0000.txt')).toBe('.._a.txt');
  });
  it('审定正文直接进入模型输入，缺失/空正文/路径穿越明确失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalos-approved-template-'));
    vi.stubEnv('CONTRACT_TEMPLATE_STORAGE_DIR', root);
    const service = new ContractTemplateService({} as any);
    try {
      await mkdir(join(root, 'approved'));
      await writeFile(join(root, 'approved', 'approved.md'), '公司审定完整条款：责任上限为合同价款。');
      const text = await service.readApprovedText('approved');
      const prompt = buildDraftPrompt('甲方：{partyA}', { partyA: '甲方' }, text, '模板');
      expect(prompt).toContain(text);
      expect(prompt).not.toContain('文件读取工具');
      await expect(service.readApprovedText('../private')).rejects.toThrow('标识无效');
      await expect(service.readApprovedText('missing')).rejects.toThrow('正文不可用');
      await writeFile(join(root, 'approved', 'approved.md'), '  ');
      await expect(service.readApprovedText('approved')).rejects.toThrow('正文为空');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('文档版本使用加锁当前读的最大版本，不使用旧快照 count 或重复递归', async () => {
    const tx: any = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: 'p1' }]).mockResolvedValueOnce([{ version: 7 }]),
      contractDocument: { create: vi.fn(), count: vi.fn().mockResolvedValue(2) },
    };
    await new ContractDocumentWriter().create(tx, { projectId: 'p1', documentType: 'draft', content: '正文' });
    expect(tx.contractDocument.create).toHaveBeenCalledWith({ data: {
      projectId: 'p1', documentType: 'draft', content: '正文', version: 8,
    } });
    expect(tx.contractDocument.count).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.map(([parts]: any) => parts.join('?'))).toEqual([
      expect.stringContaining('FOR UPDATE'), expect.stringContaining('ORDER BY version DESC LIMIT 1 FOR UPDATE'),
    ]);
  });
});

describe('所有流式 Controller 的排队取消', () => {
  it.each(['generate', 'review', 'consult'])('%s 在服务返回前断开也会 abort，结束后释放监听', async (kind) => {
    let signal!: AbortSignal;
    let release!: (value: any) => void;
    const queued = new Promise(resolve => { release = resolve; });
    const wait = vi.fn((...args: any[]) => { signal = args[args.length - 1]; return queued; });
    const res: any = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, json: vi.fn() });
    const contract = new ContractController({ generateDraft: wait, reviewContract: wait } as any, {} as any, {} as any);
    const project = new ProjectController({ createMessage: wait } as any);
    const pending = kind === 'generate'
      ? contract.generate({ templateSlug: 't' }, 'u1', 'business', res)
      : kind === 'review' ? contract.review('p1', {}, 'u1', 'legal_bp', res)
        : project.createMessage('p1', { text: '问题' } as any, 'u1', 'business', res);
    expect(signal.aborted).toBe(false);
    res.destroyed = true;
    res.emit('close');
    expect(signal.aborted).toBe(true);
    release({ projectId: 'p1' });
    await pending;
    expect(res.json).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
});

describe('工单终态与历史分页', () => {
  it('合同提交审核遇到并发取消时拒绝，不写事件或 Outbox', async () => {
    const tx: any = {
      project: {
        findUnique: vi.fn().mockResolvedValueOnce({ route: 'llm', status: '待处理' })
          .mockResolvedValue({ route: 'llm', status: '已取消' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      projectEvent: { create: vi.fn() }, outboxEvent: { create: vi.fn() },
    };
    tx.$transaction = vi.fn((run) => run(tx));
    await expect(new EscalateProjectToLegalUseCase(tx).execute({ projectId: 'p1' })).rejects.toThrow('已取消');
    expect(tx.project.updateMany.mock.calls[0][0].where.status).toEqual({ not: '已取消' });
    expect(tx.projectEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('默认取最新窗口、按时间正序展示，提供绑定工单的历史游标', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: `m${201 - index}`, projectId: 'p1', createdAt: new Date(201 - index), role: 'user', text: '问题',
    }));
    const findUnique = vi.fn().mockResolvedValue({
      id: 'p1', creatorId: 'u1', ownerId: 'u1', messages: rows, events: [], extra: null,
    });
    const prisma: any = { project: { findUnique }, consultationRun: { findMany: vi.fn().mockResolvedValue([]) },
      projectMessage: { findFirst: vi.fn().mockResolvedValue(rows[199]) } };
    const service = new ProjectQueryService(prisma, new ProjectAccessPolicy());
    const page = await service.findOne('p1', { id: 'u1', role: 'business' });
    expect(page.messages).toHaveLength(200);
    expect(page.messages[0].id).toBe('m2');
    expect(page.messages.at(-1)?.id).toBe('m201');
    expect(page.history.beforeMessageId).toBe('m2');
    expect(findUnique.mock.calls[0][0].include.messages.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    await service.findOne('p1', { id: 'u1', role: 'business' }, { beforeMessageId: 'm2' });
    expect(prisma.projectMessage.findFirst).toHaveBeenCalledWith({ where: { id: 'm2', projectId: 'p1' } });
    expect(findUnique.mock.calls[1][0].include.messages.where.OR).toContainEqual({ createdAt: { lt: rows[199].createdAt } });
    prisma.projectMessage.findFirst.mockResolvedValue(null);
    await expect(service.findOne('p1', { id: 'u1', role: 'business' }, { beforeMessageId: 'other-project-message' })).rejects.toThrow('游标');
    await expect(service.findOne('p1', { id: 'other', role: 'business' })).rejects.toThrow();
  });
});
