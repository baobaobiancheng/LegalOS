import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SkillVisibility } from '@prisma/client';
import { SkillService } from '../src/modules/skill/skill.service';

/**
 * 技能库状态机与权限矩阵单测（/plan-eng-review E4：vitest 最小骨架）。
 * 测试目标（设计文档 §2/§7 + 覆盖率图）：
 *   状态机转换（submit/withdraw/review 条件更新 + 409）
 *   权限矩阵（private 硬边界 / public 编辑权 / business 剥离 prompt）
 *   驳回必填 + reviewLog append-only
 */

const P2002 = (field: string) =>
  new Prisma.PrismaClientKnownRequestError('unique constraint', {
    code: 'P2002',
    clientVersion: '6.1.0',
    meta: { target: [field] },
  });

const skillRow = (over: Partial<any> = {}) => ({
  id: 'sk-1',
  slug: 'data-compliance',
  name: '数据合规评估',
  group: '合规法务',
  description: '',
  prompt: '你是数据合规专家。',
  visibility: 'private' as SkillVisibility,
  isActive: true,
  creatorId: 'u-bp',
  approvedBy: null,
  approvedAt: null,
  reviewLog: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('SkillService', () => {
  let service: SkillService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      skill: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      skillReviewLog: { create: vi.fn().mockResolvedValue({ id: 'log-1' }), upsert: vi.fn() },
      // P1-09：交互式事务，用 prisma 自身充当 tx
      $transaction: vi.fn((cb: (tx: any) => Promise<any>) => cb(prisma)),
    };
    service = new SkillService(prisma);
  });

  // ── create（注册） ──

  describe('create', () => {
    const base = { name: '数据合规评估', group: '合规法务', prompt: '你是数据合规专家。' };

    it('BP 注册默认 private（即使传 public 也强制）', async () => {
      prisma.skill.create.mockResolvedValue(skillRow());
      await service.create({ ...base, visibility: 'public' }, 'u-bp', Role.legal_bp);
      const data = prisma.skill.create.mock.calls[0][0].data;
      expect(data.visibility).toBe('private');
      expect(data.approvedBy).toBeNull();
    });

    it('lead/admin 可直接建 public + approvedBy 落库', async () => {
      prisma.skill.create.mockResolvedValue(skillRow({ visibility: 'public' }));
      await service.create({ ...base, visibility: 'public' }, 'u-lead', Role.legal_lead);
      const data = prisma.skill.create.mock.calls[0][0].data;
      expect(data.visibility).toBe('public');
      expect(data.approvedBy).toBe('u-lead');
    });

    it('保留 slug（general / seed slug）拒绝注册', async () => {
      await expect(service.create({ ...base, slug: 'general' }, 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.create({ ...base, slug: 'contract-risk-review' }, 'u-bp', Role.legal_bp),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('手填 slug 冲突 → 409 Conflict', async () => {
      prisma.skill.create.mockRejectedValue(P2002('slug'));
      await expect(service.create({ ...base, slug: 'my-skill' }, 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('未提供 slug 时自动生成（中文名 → 拼音）并追加冲突后缀重试', async () => {
      prisma.skill.create
        .mockRejectedValueOnce(P2002('slug'))
        .mockResolvedValueOnce(skillRow({ slug: 'shujuheguipinggu-2' }));
      const result = await service.create(base, 'u-bp', Role.legal_bp);
      expect(prisma.skill.create).toHaveBeenCalledTimes(2);
      expect(result.slug).toBe('shujuheguipinggu-2');
    });
  });

  // ── submit / withdraw ──

  describe('submit（private → pending）', () => {
    it('创建者提交成功', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 1 });
      await service.submit('sk-1', 'u-bp');
      expect(prisma.skill.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'sk-1',
        creatorId: 'u-bp',
        visibility: 'private',
      });
    });

    it('非创建者 → 403', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      prisma.skill.findUnique.mockResolvedValue(skillRow()); // creatorId=u-bp ≠ u-other
      await expect(service.submit('sk-1', 'u-other')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('非 private 状态 → 409', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      prisma.skill.findUnique.mockResolvedValue(skillRow({ creatorId: 'u-bp', visibility: 'pending' }));
      await expect(service.submit('sk-1', 'u-bp')).rejects.toBeInstanceOf(ConflictException);
    });

    it('技能不存在 → 404', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      prisma.skill.findUnique.mockResolvedValue(null);
      await expect(service.submit('sk-1', 'u-bp')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('withdraw（pending → private）', () => {
    it('创建者撤回成功', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 1 });
      await service.withdraw('sk-1', 'u-bp');
      expect(prisma.skill.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'sk-1',
        creatorId: 'u-bp',
        visibility: 'pending',
      });
    });

    it('非 pending → 409', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      prisma.skill.findUnique.mockResolvedValue(skillRow({ creatorId: 'u-bp', visibility: 'public' }));
      await expect(service.withdraw('sk-1', 'u-bp')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── review（审核） ──

  describe('review（pending → public / private）', () => {
    it('通过：pending → public + approvedBy/At + reviewLog append', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 1 });
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'pending', reviewLog: [] }));
      prisma.skill.update.mockResolvedValue({});
      await service.review('sk-1', { approved: true }, 'u-lead');

      expect(prisma.skill.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'sk-1', visibility: 'pending' },
        data: { visibility: 'public', approvedBy: 'u-lead' },
      });
      // reviewLog append-only：保留历史
      const log = prisma.skill.update.mock.calls[0][0].data.reviewLog;
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ action: 'approve', reviewerId: 'u-lead' });
    });

    it('驳回缺少原因 → 400', async () => {
      await expect(service.review('sk-1', { approved: false }, 'u-lead')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('驳回：pending → private + reviewLog 保留全部历史（二次驳回不覆盖首次原因）', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 1 });
      const history = [
        { action: 'reject', reviewerId: 'u-lead', reason: '首次驳回原因', at: '2026-08-04T00:00:00Z' },
      ];
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'pending', reviewLog: history }));
      prisma.skill.update.mockResolvedValue({});
      await service.review('sk-1', { approved: false, reason: '二次驳回原因' }, 'u-lead');

      const log = prisma.skill.update.mock.calls[0][0].data.reviewLog;
      expect(log).toHaveLength(2);
      expect(log[0].reason).toBe('首次驳回原因');
      expect(log[1]).toMatchObject({ action: 'reject', reason: '二次驳回原因' });
    });

    it('非 pending 状态 → 409（并发防护：审核瞬间被撤回）', async () => {
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      await expect(service.review('sk-1', { approved: true }, 'u-lead')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // ── update（编辑） ──

  describe('update', () => {
    it('pending 不可编辑 → 409', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'pending', creatorId: 'u-bp' }));
      await expect(service.update('sk-1', { name: '新名' }, 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('private 仅创建者可编辑（他人 403）', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      await expect(service.update('sk-1', { name: '新名' }, 'u-other', Role.legal_bp)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      prisma.skill.update.mockResolvedValue(skillRow({ name: '新名' }));
      await expect(service.update('sk-1', { name: '新名' }, 'u-bp', Role.legal_bp)).resolves.toBeDefined();
    });

    it('public 修改权仅 lead/admin（创建者发布后让渡，BP 403）', async () => {
      prisma.skill.findUnique.mockResolvedValue(
        skillRow({ visibility: 'public', creatorId: 'u-bp' }),
      );
      await expect(service.update('sk-1', { name: '新名' }, 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      prisma.skill.findUnique.mockResolvedValue(
        skillRow({ visibility: 'public', creatorId: 'u-bp' }),
      );
      prisma.skill.update.mockResolvedValue(skillRow({ name: '新名' }));
      await expect(service.update('sk-1', { name: '新名' }, 'u-lead', Role.legal_lead)).resolves.toBeDefined();
    });
  });

  // ── archive / restore ──

  describe('archive / restore', () => {
    it('pending 不可停用 → 409', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'pending', creatorId: 'u-bp' }));
      await expect(service.archive('sk-1', 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(ConflictException);
    });

    it('非创建者且非 lead 停用 → 403', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      await expect(service.archive('sk-1', 'u-other', Role.legal_bp)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('创建者停用/恢复自己的公有技能（权限矩阵补行）', async () => {
      prisma.skill.findUnique.mockResolvedValue(
        skillRow({ visibility: 'public', creatorId: 'u-bp' }),
      );
      prisma.skill.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.archive('sk-1', 'u-bp', Role.legal_bp)).resolves.toMatchObject({
        isActive: false,
      });
      prisma.skill.findUnique.mockResolvedValue(
        skillRow({ visibility: 'public', creatorId: 'u-bp', isActive: false }),
      );
      await expect(service.restore('sk-1', 'u-bp', Role.legal_bp)).resolves.toMatchObject({
        isActive: true,
      });
    });

    it('已停用再停用 → 409；未停用恢复 → 409', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ creatorId: 'u-bp', isActive: false }));
      prisma.skill.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.archive('sk-1', 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(ConflictException);
      prisma.skill.findUnique.mockResolvedValue(skillRow({ creatorId: 'u-bp', isActive: true }));
      await expect(service.restore('sk-1', 'u-bp', Role.legal_bp)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── list / detail ──

  describe('list / detail', () => {
    it('business 访问 pending 列表 → 403', async () => {
      await expect(service.list('pending', undefined, 'u-biz', Role.business)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('scope=mine 仅返回自己的技能；剥离 prompt 但保留 reviewLog（驳回原因展示）', async () => {
      prisma.skill.findMany.mockResolvedValue([
        skillRow({ creatorId: 'u-bp' }),
        skillRow({ id: 'sk-2', creatorId: 'u-bp', visibility: 'pending' }),
      ]);
      const items = await service.list('mine', undefined, 'u-bp', Role.legal_bp);
      expect(prisma.skill.findMany.mock.calls[0][0].where.creatorId).toBe('u-bp');
      expect(items).toHaveLength(2);
      expect(items[0]).not.toHaveProperty('prompt');
      expect(items[0]).toHaveProperty('reviewLog'); // 我的技能保留审核历史
    });

    it('public/usable 列表剥离 reviewLog（内部治理信息不外泄）', async () => {
      prisma.skill.findMany.mockResolvedValue([skillRow({ id: 'pub-1', visibility: 'public' })]);
      const items = await service.list('public', undefined, 'u-biz', Role.business);
      expect(items[0]).not.toHaveProperty('reviewLog');
      expect(items[0]).not.toHaveProperty('prompt');
    });

    it('usable = 公有 + 自己的私有（含其他用户的 private 不出现）', async () => {
      prisma.skill.findMany.mockResolvedValue([
        skillRow({ id: 'pub-1', visibility: 'public' }),
        skillRow({ id: 'my-1', creatorId: 'u-bp', visibility: 'private' }),
        skillRow({ id: 'other-1', creatorId: 'u-other', visibility: 'private' }), // 私有硬边界 → 过滤
      ]);
      const items = await service.list('usable', undefined, 'u-bp', Role.legal_bp);
      expect(prisma.skill.findMany.mock.calls[0][0].where.OR).toEqual([
        { visibility: 'public' },
        { creatorId: 'u-bp', visibility: 'private' },
      ]);
      const ids = items.map((i: any) => i.id);
      expect(ids).toContain('pub-1');
      expect(ids).toContain('my-1');
      expect(ids).not.toContain('other-1'); // 他人私有不可见（含 lead/admin 视角）
    });

    it('detail：business 剥离 prompt；private 非创建者 403', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'public' }));
      const d = await service.detail('sk-1', 'u-biz', Role.business);
      expect(d).not.toHaveProperty('prompt');

      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      await expect(service.detail('sk-1', 'u-other', Role.legal_bp)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      prisma.skill.findUnique.mockResolvedValue(skillRow({ visibility: 'private' }));
      await expect(service.detail('sk-1', 'u-lead', Role.legal_lead)).rejects.toBeInstanceOf(
        ForbiddenException,
      ); // 私有硬边界：lead/admin 也不可见他人私有
    });
  });
});
