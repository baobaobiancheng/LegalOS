import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ContractService } from '../src/modules/contract/contract.service';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import { CreateProjectUseCase } from '../src/modules/project/application/create-project.use-case';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';

/**
 * 合同审查技能注入（工程评审决策 R-2/OV#2）+ P1-05：
 * - 审查时选择技能 → 读实时 prompt → 注入 buildReviewPrompt
 * - 审查所用技能持久化到工单
 * - P1-05：源文档取 ContractDocument（显式 sourceDocumentId 或最新），先建 ReviewRun
 */

/** DshService.executeStream 的语义化事件句柄 mock（本测试不驱动事件，只校验 prompt/元数据） */
const mockHandle = () => new EventEmitter();

const SOURCE_DOC = { id: 'doc-1', content: '第一条 服务内容\n甲方提供AI服务…', version: 1 };

describe('ContractService.reviewContract 技能注入', () => {
  let service: ContractService;
  let prisma: any;
  let dsh: any;
  let template: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      project: { findUnique: vi.fn(), update: vi.fn() },
      skill: { findFirst: vi.fn() },
      projectMessage: { findFirst: vi.fn(), create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractFile: { findMany: vi.fn(), create: vi.fn() },
      contractDocument: { findFirst: vi.fn().mockResolvedValue(SOURCE_DOC) },
      contractReviewRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), update: vi.fn() },
    };
    dsh = { executeStream: vi.fn().mockResolvedValue(mockHandle()) };
    template = { findBySlug: vi.fn() };
    dingtalk = { sendNotification: vi.fn() };
    service = new ContractService(
      prisma as any,
      dsh as any,
      template as any,
      new ContractDocumentWriter(),
      dingtalk as any,
      new CreateProjectUseCase(prisma) as any,
      new ProjectAccessPolicy() as any,
      { execute: vi.fn() } as any,
    );

    prisma.project.findUnique.mockResolvedValue({
      id: 'c-1',
      kind: 'contract',
      status: '待复核',
      title: '合同草稿·测试',
      creatorId: 'u-biz',
      ownerId: 'u-bp',
      legalBpId: 'u-bp', // 已指派给 u-bp → 统一 Policy ReviewContract 通过
      dingtalkChatId: null,
    });
  });

  it('有效技能：注入实时 prompt 到审查 prompt + 持久化 skillId/skillName + ReviewRun 指向源文档', async () => {
    prisma.skill.findFirst.mockResolvedValue({
      id: 'sk-review',
      name: '合同风险审查',
      prompt: '你是企业合同审查专家。逐条识别风险。',
    });

    const result = await service.reviewContract('c-1', { id: 'u-bp', role: 'legal_bp' }, 'sk-review');

    // 持久化（OV#2）
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { skillId: 'sk-review', skillName: '合同风险审查' },
    });

    // P1-05：先建 ReviewRun，sourceDocumentId 指向源文档
    expect(prisma.contractReviewRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'c-1', sourceDocumentId: 'doc-1', status: 'running', createdBy: 'u-bp' }),
      }),
    );

    // 注入：prompt 含技能段，且只使用源文档 content（不再按 assistant 消息推断）
    const prompt = dsh.executeStream.mock.calls[0][0];
    expect(prompt).toContain('## 技能指令（合同风险审查）');
    expect(prompt).toContain('你是企业合同审查专家。逐条识别风险。');
    expect(prompt).toContain('总体评价');
    expect(prompt).toContain(SOURCE_DOC.content);
    expect(prisma.projectMessage.findFirst).not.toHaveBeenCalled();

    // 审查响应携带 reviewRunId/sourceDocumentId/sourceVersion
    expect(result).toMatchObject({
      projectId: 'c-1',
      reviewRunId: 'run-1',
      sourceDocumentId: 'doc-1',
      sourceVersion: 1,
    });
    expect(result.stream).toBeDefined();
  });

  it('无效技能：按无技能审查（不注入、不持久化）', async () => {
    prisma.skill.findFirst.mockResolvedValue(null);

    await service.reviewContract('c-1', { id: 'u-bp', role: 'legal_bp' }, 'junk-id');

    expect(prisma.project.update).not.toHaveBeenCalled();
    const prompt = dsh.executeStream.mock.calls[0][0];
    expect(prompt).not.toContain('## 技能指令');
    expect(prompt).toContain('总体评价'); // 基础审查 prompt 正常
  });

  it('不传 skillId：走纯通用审查', async () => {
    await service.reviewContract('c-1', { id: 'u-bp', role: 'legal_bp' });

    expect(prisma.skill.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
    const prompt = dsh.executeStream.mock.calls[0][0];
    expect(prompt).not.toContain('## 技能指令');
  });
});
