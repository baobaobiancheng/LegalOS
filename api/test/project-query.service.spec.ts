import { ProjectKind, ProjectStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  businessStatusGroupWhere,
  PROJECT_GROUP_KEYS,
  ProjectQueryService,
  isProjectGroupKey,
  isProjectKind,
  projectGroupWhere,
} from '../src/modules/project/queries/project-query.service';

describe('ProjectQueryService 工单分组分页', () => {
  it('只接受受支持的分组名称，并保持投影优先级一致', () => {
    expect(PROJECT_GROUP_KEYS).toEqual(['待处理', '合同协作', '已回传', '数字分身处理']);
    expect(isProjectGroupKey('待处理')).toBe(true);
    expect(isProjectGroupKey('其它')).toBe(false);
    expect(isProjectKind('consult')).toBe(true);
    expect(isProjectKind('unknown')).toBe(false);
    expect(projectGroupWhere('合同协作')).toEqual({ kind: ProjectKind.contract });
    expect(projectGroupWhere('数字分身处理')).toEqual({
      kind: { not: ProjectKind.contract },
      route: 'llm',
    });
    expect(projectGroupWhere('已回传')).toEqual({
      kind: { not: ProjectKind.contract },
      route: { not: 'llm' },
      status: { in: [ProjectStatus.已回传, ProjectStatus.已取消] },
    });
  });

  it('按选中分组在数据库分页，每页 10 条，并返回全部分组总数', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn()
      .mockResolvedValueOnce(23)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(13)
      .mockResolvedValueOnce(5);
    const listScope = vi.fn().mockReturnValue({ OR: [{ legalBpId: 'bp-1' }, { ownerId: 'bp-1' }, { legalBpId: null }] });
    const service = new ProjectQueryService(
      { project: { findMany, count } } as any,
      { listScope } as any,
    );

    const result = await service.findAll(
      { id: 'bp-1', role: 'legal_bp' },
      { group: '待处理', page: 2, size: 10 },
    );

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { OR: [{ legalBpId: 'bp-1' }, { ownerId: 'bp-1' }, { legalBpId: null }] },
          projectGroupWhere('待处理'),
        ],
      },
      skip: 10,
      take: 10,
    }));
    expect(count).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      items: [],
      groupCounts: { 待处理: 23, 合同协作: 6, 已回传: 13, 数字分身处理: 5 },
      total: 23,
      page: 2,
      size: 10,
    });
  });

  it('业务端记录按状态分组服务端分页，并返回当前用户的全量状态统计', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn()
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(8);
    const groupBy = vi.fn().mockResolvedValue([
      { status: ProjectStatus.分析中, _count: { _all: 3 } },
      { status: ProjectStatus.待处理, _count: { _all: 4 } },
      { status: ProjectStatus.待复核, _count: { _all: 1 } },
      { status: ProjectStatus.已回传, _count: { _all: 16 } },
      { status: ProjectStatus.已取消, _count: { _all: 3 } },
    ]);
    const service = new ProjectQueryService(
      { project: { findMany, count, groupBy } } as any,
      { listScope: vi.fn() } as any,
    );

    const result = await service.findAll(
      { id: 'business-1', role: 'business' },
      { mine: true, statusGroup: 'processing', page: 2, size: 10 },
    );

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { creatorId: 'business-1' },
          businessStatusGroupWhere('processing'),
        ],
      },
      skip: 10,
      take: 10,
    }));
    expect(groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { creatorId: 'business-1' },
      _count: { _all: true },
    });
    expect(result).toMatchObject({
      total: 8,
      page: 2,
      size: 10,
      statusCounts: {
        分析中: 3,
        待处理: 4,
        待复核: 1,
        已回传: 16,
        已取消: 3,
      },
    });
  });

  it.each([
    [{ page: 0, size: 20 }, 'page'],
    [{ page: 1.5, size: 20 }, 'page'],
    [{ page: Number.MAX_SAFE_INTEGER, size: 100 }, '分页'],
    [{ page: 1, size: 0 }, 'size'],
    [{ page: 1, size: 101 }, 'size'],
  ])('拒绝非法或不安全分页 %#', async (params, message) => {
    const service = new ProjectQueryService({ project: {} } as any, { listScope: vi.fn() } as any);
    await expect(service.findAll(
      { id: 'bp-1', role: 'legal_bp' },
      params,
    )).rejects.toThrow(message);
  });

  it('legal_bp 未认领项只返回认领摘要，ownerId 指派项仍返回正常列表字段', async () => {
    const base = {
      id: 'p-unassigned', kind: 'consult', title: '待认领', status: '待处理', risk: 'P1',
      route: 'legalbp', isFailed: false, legalBpId: null, ownerId: 'biz-1', result: 'PRIVATE_RESULT',
      requesterName: 'PRIVATE_REQUESTER', creator: { id: 'biz-1', displayName: 'PRIVATE_USER' },
      owner: { id: 'biz-1', displayName: 'PRIVATE_USER' }, legalBp: null,
      createdAt: new Date(), updatedAt: new Date(), extra: { secret: true },
    };
    const findMany = vi.fn().mockResolvedValue([
      base,
      { ...base, id: 'p-owned', title: '已指派', ownerId: 'bp-1', result: '正常可见' },
    ]);
    const count = vi.fn().mockResolvedValue(0);
    const service = new ProjectQueryService(
      { project: { findMany, count } } as any,
      { listScope: vi.fn().mockReturnValue({}) } as any,
    );

    const result = await service.findAll({ id: 'bp-1', role: 'legal_bp' }, { page: 1, size: 20 });

    expect(result.items[0]).toEqual({
      id: 'p-unassigned', kind: 'consult', title: '待认领', status: '待处理', risk: 'P1',
      route: 'legalbp', legalBpId: null, createdAt: base.createdAt, updatedAt: base.updatedAt,
    });
    expect(result.items[0]).not.toHaveProperty('result');
    expect(result.items[0]).not.toHaveProperty('creator');
    expect(result.items[1]).toMatchObject({ id: 'p-owned', ownerId: 'bp-1', result: '正常可见' });
    expect(result.groups['待处理'].map((item) => item.id)).toEqual(['p-unassigned', 'p-owned']);
  });

  it('未认领数字分身摘要仍进入数字分身分组，与数据库分组计数一致', async () => {
    const updatedAt = new Date('2026-09-08T00:00:00.000Z');
    const item = {
      id: 'p-unassigned-llm', kind: 'consult', title: 'AI处理中', status: '分析中', risk: 'P2',
      route: 'llm', isFailed: false, legalBpId: null, ownerId: 'biz-1', result: 'PRIVATE_RESULT',
      creator: { id: 'biz-1' }, owner: { id: 'biz-1' }, legalBp: null,
      createdAt: updatedAt, updatedAt, extra: null,
    };
    const service = new ProjectQueryService(
      {
        project: {
          findMany: vi.fn().mockResolvedValue([item]),
          count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1),
        },
      } as any,
      { listScope: vi.fn().mockReturnValue({}) } as any,
    );

    const result = await service.findAll(
      { id: 'bp-1', role: 'legal_bp' },
      { group: '数字分身处理', page: 1, size: 20 },
    );

    expect(result.groupCounts['数字分身处理']).toBe(1);
    expect(result.groups['数字分身处理']).toEqual(result.items);
    expect(result.items[0]).toMatchObject({ id: item.id, route: 'llm', updatedAt });
    expect(result.items[0]).not.toHaveProperty('result');
  });
});
