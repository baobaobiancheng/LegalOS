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
      dingTalkContactStaging: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      dingTalkSyncBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }), update: vi.fn().mockResolvedValue({}) },
      user: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: 'u' }),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      bpDomainMap: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
      project: { count: vi.fn() },
      $transaction: vi.fn(async (arg: any) => {
        if (typeof arg === 'function') return arg(prisma);
        return Promise.all(arg);
      }),
    };
    dingtalk = { syncContacts: vi.fn() };
    service = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (k: string) => ({ CAS_ROLE_MAP: '', CAS_DEPT_MAP: '' })[k] ?? undefined } as any,
    );
  });

  it('syncContacts：staging 批处理 + 软失效 + 唯一姓名自动绑定 + 重名跳过', async () => {
    dingtalk.syncContacts.mockResolvedValue({
      contacts: [
        { userId: 'U-1', name: '彭宇欣', mobile: '138', avatarUrl: 'https://img.example/u-1.png' },
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
    prisma.dingTalkContactStaging.findMany.mockResolvedValue([
      { userId: 'U-1', name: '彭宇欣', mobile: '138', avatarUrl: 'https://img.example/u-1.png' },
      { userId: 'U-2', name: '重名用户', mobile: '139' },
    ]);

    const result = await service.syncContacts();

    // 批量 staging（一次 createMany，不逐条）
    expect(prisma.dingTalkContactStaging.createMany).toHaveBeenCalledTimes(1);
    // 软失效：updateMany 置 isActive=false（P1-07 不再硬删除）
    expect(prisma.dingTalkContact.updateMany).toHaveBeenCalled();
    // 彭宇欣唯一匹配 → 自动绑定
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-bp' },
        data: expect.objectContaining({
          dingtalkUserId: 'U-1',
          avatarUrl: 'https://img.example/u-1.png',
        }),
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

  it('syncContacts：记录触发管理员、自动绑定前后值和同步批次', async () => {
    dingtalk.syncContacts.mockResolvedValue({
      contacts: [{ userId: 'U-1', name: '彭宇欣', mobile: '138', department: '法务部' }],
      complete: true,
      departmentCount: 1,
      pageCount: 1,
      warnings: [],
    });
    prisma.dingTalkContactStaging.findMany.mockResolvedValue([
      { userId: 'U-1', name: '彭宇欣', mobile: '138', department: '法务部' },
    ]);
    prisma.user.findMany
      .mockResolvedValueOnce([{
        id: 'u-bp', username: 'staff', displayName: '彭宇欣', casUsername: 'staff',
        role: 'business', department: null,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const audit = {
      record: vi.fn().mockResolvedValue({}),
      fingerprint: vi.fn().mockReturnValue('ding-hash'),
      digestCanonical: vi.fn().mockReturnValue('error-hash'),
    };
    const audited = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '法务部:legal_bp' : '' } as any,
      audit as any,
    );

    await audited.syncContacts(
      { id: 'admin-1', role: 'admin' },
      { requestId: 'request-sync-1' },
    );

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.bind',
      actor: { id: 'admin-1', role: 'admin' },
      source: 'dingtalk',
      before: expect.objectContaining({ dingtalkBound: false, role: 'business' }),
      after: expect.objectContaining({ dingtalkBound: true, role: 'legal_bp' }),
      metadata: expect.objectContaining({ automatic: true, batchId: 'batch-1' }),
    }), prisma);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.directory.sync',
      resourceId: 'batch-1',
      outcome: 'success',
    }), prisma);
  });

  it('syncContacts：多部门成员优先落库命中角色映射的部门', async () => {
    dingtalk.syncContacts.mockResolvedValue({
      contacts: [{
        userId: 'dong.chen',
        name: '陈东',
        avatarUrl: 'https://img.example/dong.png',
        department: '华西南法务BP',
        departments: ['华西南法务BP', '合规一组'],
      }],
      complete: true,
      departmentCount: 2,
      pageCount: 2,
      warnings: [],
    });
    prisma.dingTalkContactStaging.findMany.mockResolvedValue([
      {
        userId: 'dong.chen',
        name: '陈东',
        mobile: null,
        avatarUrl: 'https://img.example/dong.png',
        department: '合规一组',
      },
    ]);
    prisma.user.findMany
      .mockResolvedValueOnce([{
        id: 'u-dong', username: 'dong.chen', displayName: '陈东', casUsername: 'dong.chen',
        role: 'business', avatarUrl: null, department: '华西南法务BP',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const multiDepartmentService = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '合规一组:legal_bp' : '' } as any,
    );

    const result = await multiDepartmentService.syncContacts();

    expect(result.complete).toBe(true);
    expect(prisma.dingTalkContactStaging.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        userId: 'dong.chen',
        avatarUrl: 'https://img.example/dong.png',
        department: '合规一组',
      })],
    });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u-dong' },
      data: expect.objectContaining({
        avatarUrl: 'https://img.example/dong.png',
        department: '合规一组',
        role: 'legal_bp',
      }),
    }));
  });

  it('bind：快照不存在拒绝', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue(null);
    await expect(service.bind('u-1', 'U-nope')).rejects.toThrow('请先同步');
  });

  it('bind：成功写入 userid + phone（联系人 active 且未被占用）', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'U-1',
      mobile: '138',
      avatarUrl: 'https://img.example/u-1.png',
      isActive: true,
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣' });
    prisma.user.findFirst.mockResolvedValue(null); // 联系人未被其他用户绑定
    prisma.user.update.mockResolvedValue({ id: 'u-1', displayName: '彭宇欣', dingtalkUserId: 'U-1' });

    const r = await service.bind('u-1', 'U-1');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dingtalkUserId: 'U-1', id: { not: 'u-1' } } }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dingtalkUserId: 'U-1',
          dingtalkPhone: '138',
          avatarUrl: 'https://img.example/u-1.png',
          role: 'business', // 手动绑定应用组织架构角色映射（review 2026-08-11）
        }),
      }),
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

  it('provision：首次登录前创建 CAS 用户、绑定钉钉部门并计算角色', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'DING-1', name: '王君', mobile: '138', avatarUrl: 'https://img.example/wang.png', department: '合规一组', isActive: true,
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-new', username: 'jun.wang1', casUsername: 'jun.wang1', displayName: '王君',
      role: 'legal_bp', avatarUrl: 'https://img.example/wang.png', department: '合规一组', dingtalkUserId: 'DING-1', dingtalkPhone: '138',
    });
    const provisionService = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '合规一组:legal_bp' : '' } as any,
    );

    const result = await provisionService.provision(' Jun.Wang1 ', 'DING-1');

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        username: 'jun.wang1',
        casUsername: 'jun.wang1',
        displayName: '王君',
        role: 'legal_bp',
        department: '合规一组',
        dingtalkUserId: 'DING-1',
        avatarUrl: 'https://img.example/wang.png',
      }),
    });
    expect(result).toMatchObject({
      id: 'user-new',
      avatarUrl: 'https://img.example/wang.png',
      loginStatus: 'pending',
      role: 'legal_bp',
    });
  });

  it('provision：CAS 账号已存在时拒绝重复预开通', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'DING-1', name: '王君', department: '合规一组', isActive: true,
    });
    prisma.user.findFirst
      .mockResolvedValueOnce({ id: 'existing-user' })
      .mockResolvedValueOnce(null);

    await expect(service.provision('jun.wang1', 'DING-1')).rejects.toThrow('CAS 账号已存在');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('provision：写入管理员、身份摘要和待登录状态审计', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'DING-1', name: '王君', mobile: '138', department: '合规一组', isActive: true,
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-new', casUsername: 'jun.wang1', displayName: '王君', role: 'legal_bp',
      department: '合规一组', dingtalkUserId: 'DING-1', dingtalkPhone: '138',
    });
    const audit = {
      record: vi.fn().mockResolvedValue({}),
      fingerprint: vi.fn((value: string) => `hash:${value}`),
    };
    const audited = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '合规一组:legal_bp' : '' } as any,
      audit as any,
    );

    await audited.provision(
      'jun.wang1',
      'DING-1',
      { id: 'admin-1', role: 'admin' },
      { requestId: 'request-provision-1' },
    );

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.provision',
      actor: { id: 'admin-1', role: 'admin' },
      resourceId: 'user-new',
      after: expect.objectContaining({ loginStatus: 'pending', role: 'legal_bp' }),
      metadata: {
        casIdentityHash: 'hash:jun.wang1',
        dingtalkIdentityHash: 'hash:DING-1',
      },
    }), prisma);
  });

  it('listUsers：预开通且尚无登录审计的 CAS 用户显示待首次登录', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'user-pending', username: 'jun.wang1', casUsername: 'jun.wang1', displayName: '王君',
        role: 'legal_bp', avatarUrl: 'https://img.example/wang.png', department: '合规一组', dingtalkUserId: 'DING-1', loginAudits: [],
      },
      {
        id: 'user-active', username: 'dong.chen', casUsername: 'dong.chen', displayName: '陈东',
        role: 'legal_bp', department: '合规一组', dingtalkUserId: 'DING-2', loginAudits: [{ id: 'login-1' }],
      },
    ]);

    const result = await service.listUsers();

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'user-pending',
        avatarUrl: 'https://img.example/wang.png',
        loginStatus: 'pending',
      }),
      expect.objectContaining({ id: 'user-active', loginStatus: 'active' }),
    ]);
    expect(result.items[0]).not.toHaveProperty('loginAudits');
  });

  it('listContacts：只返回在岗且未被其他系统用户占用的钉钉联系人', async () => {
    prisma.user.findMany.mockResolvedValue([{ dingtalkUserId: 'DING-USED' }]);
    prisma.dingTalkContact.findMany.mockResolvedValue([]);

    await service.listContacts('王');

    expect(prisma.dingTalkContact.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        userId: { notIn: ['DING-USED'] },
        OR: [{ name: { contains: '王' } }, { mobile: { contains: '王' } }],
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
  });

  it('bind：管理员、前后状态与请求标识在同一事务写入统一审计', async () => {
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'U-1', mobile: '138', department: '法务部', isActive: true,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1', username: 'staff', displayName: '成员', role: 'business',
      department: null, dingtalkUserId: null, casUsername: 'staff',
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({
      id: 'u-1', displayName: '成员', role: 'legal_bp', department: '法务部', dingtalkUserId: 'U-1',
    });
    const audit = { record: vi.fn().mockResolvedValue({}), fingerprint: vi.fn().mockReturnValue('ding-hash') };
    const audited = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '法务部:legal_bp' : '' } as any,
      audit as any,
    );

    await audited.bind(
      'u-1',
      'U-1',
      { id: 'admin-1', role: 'admin' },
      { requestId: 'request-bind-1', ip: '10.0.0.1' },
    );

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'member.bind',
      actor: { id: 'admin-1', role: 'admin' },
      resourceId: 'u-1',
      changes: expect.objectContaining({
        dingtalkBound: { from: false, to: true },
        role: { from: 'business', to: 'legal_bp' },
      }),
      metadata: { dingtalkIdentityHash: 'ding-hash' },
    }), prisma);
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

  it('syncContacts：联系人移出通讯录(软失效) → 回收部门 + 重算角色（review P1）', async () => {
    dingtalk.syncContacts.mockResolvedValue({
      contacts: [{ userId: 'U-1', name: '彭宇欣', mobile: '138', department: '法务部' }],
      complete: true,
      departmentCount: 1,
      pageCount: 1,
      warnings: [],
    });
    prisma.dingTalkContactStaging.findMany.mockResolvedValue([
      { userId: 'U-1', name: '彭宇欣', mobile: '138', department: '法务部' },
    ]);
    // autoBind:未绑定用户=[] + 占用联系人=[];refreshBoundRoles:用户绑定 U-X(不在本批通讯录)
    prisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'u-old',
          username: 'old.staff',
          dingtalkUserId: 'U-X',
          casUsername: null,
          role: 'legal_bp',
          avatarUrl: 'https://img.example/old.png',
          department: '法务部',
        },
      ]);

    const result = await service.syncContacts();

    expect(result.complete).toBe(true);
    // 旧联系人绑定的用户:清部门 + 角色回落到 business（CAS 映射空）
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-old' },
        data: expect.objectContaining({ avatarUrl: null, department: null, role: 'business' }),
      }),
    );
    // staging 清理:成功保留本批、删旧批
    expect(prisma.dingTalkContactStaging.deleteMany).toHaveBeenCalledWith({
      where: { batchId: { not: 'batch-1' } },
    });
  });

  it('bind：本地应急账号角色固定，法务账号不再走种子例外', async () => {
    service = new MembersService(
      prisma as any,
      dingtalk as any,
      { get: (key: string) => key === 'CAS_DEPT_MAP' ? '法务部:legal_bp' : '' } as any,
    );
    prisma.dingTalkContact.findUnique.mockResolvedValue({
      userId: 'U-1', mobile: '138', department: '法务部', isActive: true,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-seed', username: 'business', displayName: '种子业务', role: 'business',
    });
    prisma.user.findFirst.mockResolvedValue(null);

    await service.bind('u-seed', 'U-1');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'business' }),
      }),
    );
  });

  it('unbind：种子测试账号角色固定,不回落（review P2）', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-seed', username: 'business', displayName: '种子业务', role: 'business' });

    await service.unbind('u-seed');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dingtalkUserId: null,
          avatarUrl: null,
          department: null,
          role: 'business',
        }),
      }),
    );
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
