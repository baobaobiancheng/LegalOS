import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MembersService } from '../src/modules/members/members.service';

/**
 * 管理端成员管理单测（/review 2026-08-05 补齐）：
 * - syncContacts：快照落库 + 姓名自动绑定 + 重名跳过
 * - bind/unbind：快照存在性校验
 * - setBpDomain：白名单校验 + 非法务角色拒绝
 * - failures：route=legalbp 且无群（含合同类，口径修正）
 */

describe('MembersService', () => {
  let prisma: any;
  let dingtalk: any;
  let service: MembersService;

  beforeEach(() => {
    prisma = {
      dingTalkContact: {
        upsert: vi.fn().mockResolvedValue({ id: 'c' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      dingTalkContactStaging: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      dingTalkSyncBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }), update: vi.fn().mockResolvedValue({}) },
      user: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: 'u' }), findFirst: vi.fn() },
      bpDomainMap: { upsert: vi.fn(), deleteMany: vi.fn() },
      project: { count: vi.fn() },
      $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
    };
    dingtalk = { syncContacts: vi.fn() };
    service = new MembersService(prisma as any, dingtalk as any);
  });

  it('syncContacts：staging 批处理 + 软失效 + 唯一姓名自动绑定 + 重名跳过', async () => {
    dingtalk.syncContacts.mockResolvedValue({
      contacts: [
        { userId: 'U-1', name: '彭宇欣', mobile: '138' },
        { userId: 'U-2', name: '重名用户', mobile: '139' },
      ],
      complete: true,
      departmentCount: 2,
      pageCount: 2,
      warnings: [],
    });
    // 第一次 findMany → 未绑定用户；第二次 → 已占用联系人的用户（无）
    prisma.user.findMany
      .mockResolvedValueOnce([
        { id: 'u-bp', displayName: '彭宇欣' },
        { id: 'u-a', displayName: '重名用户' },
        { id: 'u-b', displayName: '重名用户' }, // 同名两人 → 不自动绑定
      ])
      .mockResolvedValueOnce([]);

    const result = await service.syncContacts();

    // 批量 staging（一次 createMany，不逐条）
    expect(prisma.dingTalkContactStaging.createMany).toHaveBeenCalledTimes(1);
    // 软失效：updateMany 置 isActive=false（P1-07 不再硬删除）
    expect(prisma.dingTalkContact.updateMany).toHaveBeenCalled();
    // 彭宇欣唯一匹配 → 自动绑定
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-bp' },
        data: expect.objectContaining({ dingtalkUserId: 'U-1' }),
      }),
    );
    // 系统重名 → 不自动绑定，进 ambiguous
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(result.ambiguous).toContain('重名用户');
    expect(result.autoBound).toBe(1);
    expect(result.complete).toBe(true);
    // 批次标记 complete
    expect(prisma.dingTalkSyncBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'batch-1' }, data: expect.objectContaining({ status: 'complete' }) }),
    );
  });

  it('bind：快照不存在拒绝', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue(null);
    await expect(service.bind('u-1', 'U-nope')).rejects.toThrow('请先同步');
  });

  it('bind：成功写入 userid + phone（联系人 active 且未被占用）', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({ userId: 'U-1', mobile: '138', isActive: true });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣' });
    prisma.user.findFirst.mockResolvedValue(null); // 联系人未被其他用户绑定
    prisma.user.update.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣', dingtalkUserId: 'U-1' });

    const r = await service.bind('u-1', 'U-1');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dingtalkUserId: 'U-1', id: { not: 'u-1' } } }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dingtalkUserId: 'U-1', dingtalkPhone: '138' } }),
    );
    expect(r.dingtalkUserId).toBe('U-1');
  });

  it('bind：联系人已被其他用户绑定 → 409，不覆盖', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({ userId: 'U-1', mobile: '138', isActive: true });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣' });
    prisma.user.findFirst.mockResolvedValue({ id: 'u-other' }); // 已被 u-other 绑定

    await expect(service.bind('u-1', 'U-1')).rejects.toThrow('已绑定其他系统用户');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('setBpDomain：非白名单领域拒绝', async () => {
    await expect(service.setBpDomain('u-1', '税务咨询', true)).rejects.toThrow('不在白名单');
    expect(prisma.bpDomainMap.upsert).not.toHaveBeenCalled();
  });

  it('setBpDomain：非法务角色拒绝', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-biz', role: 'business' });
    await expect(service.setBpDomain('u-biz', '合规法务', true)).rejects.toThrow('仅法务 BP');
  });

  it('setBpDomain：法务 BP 勾选/取消映射', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-bp', role: 'legal_bp' });
    await service.setBpDomain('u-bp', '合规法务', true);
    expect(prisma.bpDomainMap.upsert).toHaveBeenCalled();
    await service.setBpDomain('u-bp', '合规法务', false);
    expect(prisma.bpDomainMap.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-bp', domain: '合规法务' },
    });
  });

  it('failures：route=legalbp 且无群（口径含合同类工单）', async () => {
    prisma.project.count.mockResolvedValue(3);
    const r = await service.failures();
    expect(prisma.project.count).toHaveBeenCalledWith({
      where: { route: 'legalbp', dingtalkChatId: null },
    });
    expect(r.noGroup).toBe(3);
  });
});
