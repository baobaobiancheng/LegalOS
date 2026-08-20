import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ContractService } from '../src/modules/contract/contract.service';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

/**
 * P1-05 合同审查源文档单测：
 * - 显式 sourceDocumentId 必须属于当前工单，跨工单拒绝
 * - 缺省取最新可审查 ContractDocument（不再按 role/label 推断 assistant 消息）
 * - 第二次审查（未上传新文档）仍指向同一份源文档，不会把上一次风险报告当正文
 * - 风险报告只进 ContractReviewRun.result，绝不创建 ContractDocument
 * - 审查失败 → ReviewRun failed，源文档不变
 */

const ACTOR = { id: 'u-bp', role: 'legal_bp' as const };
const PROJECT = {
  id: 'c-1',
  kind: 'contract',
  status: '待复核',
  title: '合同草稿·测试',
  creatorId: 'u-biz',
  ownerId: 'u-bp',
  legalBpId: 'u-bp',
  dingtalkChatId: null,
};

/** DshService.executeStream 的语义化事件句柄 mock（'text'/'done'/'cancelled'/'error'） */
const makeHandle = () => new EventEmitter();

describe('ContractService.reviewContract 源文档', () => {
  let service: ContractService;
  let prisma: any;
  let dsh: any;
  let template: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      project: { findUnique: vi.fn() },
      skill: { findFirst: vi.fn() },
      projectMessage: { findFirst: vi.fn(), create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractDocument: { findFirst: vi.fn(), create: vi.fn() },
      contractReviewRun: { create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
    };
    dsh = { executeStream: vi.fn() };
    template = { findBySlug: vi.fn() };
    dingtalk = { sendNotification: vi.fn() };
    service = new ContractService(
      prisma as any,
      dsh as any,
      template as any,
      dingtalk as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { execute: vi.fn() } as any,
    );
    prisma.project.findUnique.mockResolvedValue(PROJECT);
    prisma.contractReviewRun.create.mockResolvedValue({ id: 'run-1' });
  });

  it('显式 sourceDocumentId 属于其他工单 → 拒绝，不建 ReviewRun 不启动 AI 执行', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue(null); // 跨工单/不存在
    await expect(
      service.reviewContract('c-1', ACTOR, undefined, 'doc-foreign'),
    ).rejects.toThrow('源文档不存在或不属于当前工单');
    expect(prisma.contractReviewRun.create).not.toHaveBeenCalled();
    expect(dsh.executeStream).not.toHaveBeenCalled();
  });

  it('缺省取项目最新 ContractDocument，不使用 assistant 消息推断', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue({ id: 'doc-2', content: '最新修订版合同正文', version: 2 });
    dsh.executeStream.mockResolvedValue(makeHandle());

    const result = await service.reviewContract('c-1', ACTOR);

    expect(prisma.contractDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'c-1' }, orderBy: { createdAt: 'desc' } }),
    );
    expect(prisma.projectMessage.findFirst).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sourceDocumentId: 'doc-2', sourceVersion: 2 });
    expect(prisma.contractReviewRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceDocumentId: 'doc-2' }) }),
    );
    // prompt 只使用该文档 content
    const prompt = dsh.executeStream.mock.calls[0][0];
    expect(prompt).toContain('最新修订版合同正文');
  });

  it('未上传新文档第二次审查 → 仍指向同一份源文档（不会用上一次风险报告当正文）', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue({ id: 'doc-1', content: '合同正文', version: 1 });
    dsh.executeStream.mockResolvedValue(makeHandle());

    const first = await service.reviewContract('c-1', ACTOR);
    const second = await service.reviewContract('c-1', ACTOR);

    expect(first.sourceDocumentId).toBe('doc-1');
    expect(second.sourceDocumentId).toBe('doc-1');
    // 风险报告只进 ReviewRun.result，文档表从未多出内容
    expect(prisma.contractDocument.create).not.toHaveBeenCalled();
  });

  it('审查成功：ReviewRun.result 写风险报告，绝不创建 ContractDocument', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue({ id: 'doc-1', content: '合同正文', version: 1 });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);

    await service.reviewContract('c-1', ACTOR);
    handle.emit('text', '风险清单：违约金过高…');
    handle.emit('done', { text: '风险清单：违约金过高…' });

    await vi.waitFor(() => expect(prisma.contractReviewRun.update).toHaveBeenCalled());
    const update = prisma.contractReviewRun.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'run-1' });
    expect(update.data.status).toBe('succeeded');
    expect(update.data.result).toBe('风险清单：违约金过高…');
    expect(prisma.contractDocument.create).not.toHaveBeenCalled();
    // 同步写 ProjectMessage 供 UI 展示
    expect(prisma.projectMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ label: 'AI 风险审查' }) }),
    );
  });

  it('审查失败：ReviewRun failed + 真实 errorMessage 透传，源文档不变', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue({ id: 'doc-1', content: '合同正文', version: 1 });
    const handle = makeHandle();
    dsh.executeStream.mockResolvedValue(handle);

    await service.reviewContract('c-1', ACTOR);
    handle.emit('error', new Error('dsh turn 失败'));

    await vi.waitFor(() => expect(prisma.contractReviewRun.update).toHaveBeenCalled());
    expect(prisma.contractReviewRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      errorMessage: 'dsh turn 失败',
    });
    expect(prisma.contractDocument.create).not.toHaveBeenCalled();
    // 源文档未被修改
    expect(prisma.contractDocument.findFirst).toHaveBeenCalledTimes(1);
  });
});

