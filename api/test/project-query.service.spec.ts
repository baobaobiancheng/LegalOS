import { ProjectKind, ProjectStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_GROUP_KEYS,
  ProjectQueryService,
  isProjectGroupKey,
  projectGroupWhere,
} from '../src/modules/project/queries/project-query.service';

describe('ProjectQueryService 工单分组分页', () => {
  it('只接受受支持的分组名称，并保持投影优先级一致', () => {
    expect(PROJECT_GROUP_KEYS).toEqual(['待处理', '合同协作', '已回传', '数字分身处理']);
    expect(isProjectGroupKey('待处理')).toBe(true);
    expect(isProjectGroupKey('其它')).toBe(false);
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
    const listScope = vi.fn().mockReturnValue({ OR: [{ legalBpId: 'bp-1' }, { legalBpId: null }] });
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
          { OR: [{ legalBpId: 'bp-1' }, { legalBpId: null }] },
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
});
