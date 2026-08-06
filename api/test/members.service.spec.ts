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
      dingTalkContact: { upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
      user: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      bpDomainMap: { upsert: vi.fn(), deleteMany: vi.fn() },
      project: { count: vi.fn() },
    };
    dingtalk = { syncContacts: vi.fn() };
    service = new MembersService(prisma as any, dingtalk as any);
  });

  it('syncContacts：快照落库 + 唯一姓名自动绑定 + 重名跳过', async () => {
    dingtalk.syncContacts.mockResolvedValue([
      { userId: 'U-1', name: '彭宇欣', mobile: '138' },
      { userId: 'U-2', name: '重名用户', mobile: '139' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-bp', displayName: '彭宇欣' },
      { id: 'u-a', displayName: '重名用户' },
      { id: 'u-b', displayName: '重名用户' }, // 同名两人 → 不自动绑定
    ]);

    const result = await service.syncContacts();

    expect(prisma.dingTalkContact.upsert).toHaveBeenCalledTimes(2);
    // 清理快照中已不在现网的成员（2026-08-06 对比现网）
    expect(prisma.dingTalkContact.deleteMany).toHaveBeenCalledWith({
      where: { userId: { notIn: ['U-1', 'U-2'] } },
    });
    // 彭宇欣唯一匹配 → 自动绑定
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-bp' },
        data: expect.objectContaining({ dingtalkUserId: 'U-1' }),
      }),
    );
    // 重名 → 不自动绑定
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(result.ambiguous).toContain('重名用户');
    expect(result.autoBound).toBe(1);
  });

  it('bind：快照不存在拒绝', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue(null);
    await expect(service.bind('u-1', 'U-nope')).rejects.toThrow('请先同步');
  });

  it('bind：成功写入 userid + phone', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({ userId: 'U-1', mobile: '138' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣' });
    prisma.user.update.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣', dingtalkUserId: 'U-1' });

    const r = await service.bind('u-1', 'U-1');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dingtalkUserId: 'U-1', dingtalkPhone: '138' } }),
    );
    expect(r.dingtalkUserId).toBe('U-1');
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
