import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContractService } from '../src/modules/contract/contract.service';

/**
 * 合同审查技能注入（工程评审决策 R-2/OV#2）：
 * - 审查时选择技能 → 读实时 prompt → 注入 buildReviewPrompt
 * - 审查所用技能持久化到工单（成功标准 6 对合同工单可验证）
 * - 解析失败 → 按无技能审查（不注入不持久化）
 */

const mockStream = () => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
});

describe('ContractService.reviewContract 技能注入', () => {
  let service: ContractService;
  let prisma: any;
  let codex: any;
  let template: any;
  let dingtalk: any;

  beforeEach(() => {
    prisma = {
      project: { findUnique: vi.fn(), update: vi.fn() },
      skill: { findFirst: vi.fn() },
      projectMessage: { findFirst: vi.fn(), create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractFile: { findMany: vi.fn(), create: vi.fn() },
    };
    codex = { executeStream: vi.fn().mockReturnValue(mockStream()) };
    template = { findBySlug: vi.fn() };
    dingtalk = { sendNotification: vi.fn() };
    service = new ContractService(prisma as any, codex as any, template as any, dingtalk as any);

    prisma.project.findUnique.mockResolvedValue({
      id: 'c-1',
      kind: 'contract',
      status: '待复核',
      title: '合同草稿·测试',
      dingtalkChatId: null,
    });
    prisma.projectMessage.findFirst.mockResolvedValue({ text: '第一条 服务内容\n甲方提供AI服务…' });
  });

  it('有效技能：注入实时 prompt 到审查 prompt + 持久化 skillId/skillName 到工单', async () => {
    prisma.skill.findFirst.mockResolvedValue({
      id: 'sk-review',
      name: '合同风险审查',
      prompt: '你是企业合同审查专家。逐条识别风险。',
    });

    const result = await service.reviewContract('c-1', 'u-bp', 'sk-review');

    // 持久化（OV#2）
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { skillId: 'sk-review', skillName: '合同风险审查' },
    });

    // 注入：prompt 含技能段（边界模板 + 领域指令），基础审查 prompt 在后
    const prompt = codex.executeStream.mock.calls[0][0];
    expect(prompt).toContain('## 技能指令（合同风险审查）');
    expect(prompt).toContain('你是企业合同审查专家。逐条识别风险。');
    expect(prompt).toContain('总体评价');

    // 可选范围 = 公有 + 自己的私有
    expect(prisma.skill.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'sk-review',
      isActive: true,
      OR: [{ visibility: 'public' }, { creatorId: 'u-bp', visibility: 'private' }],
    });
    expect(result.stream).toBeDefined();
  });

  it('无效技能：按无技能审查（不注入、不持久化）', async () => {
    prisma.skill.findFirst.mockResolvedValue(null);

    await service.reviewContract('c-1', 'u-bp', 'junk-id');

    expect(prisma.project.update).not.toHaveBeenCalled();
    const prompt = codex.executeStream.mock.calls[0][0];
    expect(prompt).not.toContain('## 技能指令');
    expect(prompt).toContain('总体评价'); // 基础审查 prompt 正常
  });

  it('不传 skillId：走纯通用审查', async () => {
    await service.reviewContract('c-1', 'u-bp');

    expect(prisma.skill.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
    const prompt = codex.executeStream.mock.calls[0][0];
    expect(prompt).not.toContain('## 技能指令');
  });
});
