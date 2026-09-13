import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRepository } from '../src/modules/project/infrastructure/outbox.repository';
import { OutboxWorker } from '../src/modules/project/infrastructure/outbox.worker';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P1-04 Outbox 租约/认领单测：
 * - 认领基于条件更新（status=pending 到可执行 / processing 租约过期可回收），不做先查再写
 * - 两个 Worker 竞争同一任务只有一个拿到
 * - 完成/失败带 id + claimToken 条件（旧 Worker 不覆盖新 Worker）
 * - 指数退避 + 超最大次数进入 dead
 * - 建群幂等：已有真实群 / 已取消 → 跳过不建群；dedupKey=legalos-${projectId}
 * - 数据库再也不会出现 dingtalk_chat_id='PENDING'
 */

const makeConfig = (over: Record<string, string> = {}) => ({
  get: vi.fn((key: string, dflt?: unknown) => (key in over ? over[key] : dflt)),
});

const makePrisma = () => ({
  outboxEvent: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  contractFile: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
  projectEvent: { create: vi.fn() },
});

const CANDIDATE = {
  id: 'e1',
  eventType: 'dingtalk.group.create',
  aggregateType: 'project',
  aggregateId: 'p1',
  dedupKey: 'project:p1:dingtalk-group:create:v1',
  payload: { projectId: 'p1' },
  status: 'pending',
  attempts: 0,
  availableAt: new Date(),
  claimedAt: null,
  claimToken: null,
  lastError: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  projectId: 'p1',
};

describe('OutboxRepository 认领/租约', () => {
  let prisma: any;
  let repo: OutboxRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new OutboxRepository(prisma, makeConfig() as any);
  });

  it('认领：条件更新 + 随机 claimToken + attempts 自增', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([CANDIDATE]);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const claims = await repo.claimNext(10);

    expect(claims).toHaveLength(1);
    expect(claims[0].claimToken).toBeTruthy();
    expect(claims[0].claimToken).toHaveLength(32); // 16 bytes hex
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'e1', OR: expect.any(Array) }),
        data: expect.objectContaining({ status: 'processing', attempts: { increment: 1 } }),
      }),
    );
  });

  it('两个 Worker 竞争同一任务：只有一个认领成功', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([CANDIDATE]);
    prisma.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 1 }) // worker1 认领
      .mockResolvedValueOnce({ count: 0 }); // worker2 已被认领

    const repo2 = new OutboxRepository(prisma, makeConfig() as any);
    const [claims1, claims2] = await Promise.all([repo.claimNext(10), repo2.claimNext(10)]);

    expect(claims1).toHaveLength(1);
    expect(claims2).toHaveLength(0);
  });

  it('租约过期可回收：processing 且 claimedAt < leaseExpiry 进入认领候选', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([
      { ...CANDIDATE, status: 'processing', claimedAt: new Date(Date.now() - 120_000) },
    ]);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await repo.claimNext(10);

    const where = prisma.outboxEvent.findMany.mock.calls[0][0].where;
    const pendingBranch = where.OR[0];
    const processingBranch = where.OR[1];
    expect(pendingBranch).toMatchObject({ status: 'pending', availableAt: { lte: expect.any(Date) } });
    expect(processingBranch).toMatchObject({ status: 'processing', claimedAt: { lt: expect.any(Date) } });
  });

  it('完成：必须带 id + claimToken 条件（旧 Worker 返回不覆盖新 Worker）', async () => {
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    const ok = await repo.markSucceeded('e1', 'tok-new');
    expect(ok).toBe(true);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e1', claimToken: 'tok-new' },
        data: expect.objectContaining({ status: 'succeeded' }),
      }),
    );

    // 旧 token → 更新失败（不覆盖新 Worker 结果）
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    const stale = await repo.markSucceeded('e1', 'tok-old');
    expect(stale).toBe(false);
  });

  it('失败：指数退避 + 抖动，未达上限回到 pending', async () => {
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    const res = await repo.markFailed('e1', 'tok', 'errcode=50001', 2);
    expect(res).toBe('pending');
    const data = prisma.outboxEvent.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
    expect(data.availableAt.getTime()).toBeGreaterThan(Date.now() + 1000); // ≥2s 退避
    expect(data.lastError).toBe('errcode=50001');
  });

  it('失败：超过最大次数进入 dead，保留 lastError', async () => {
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    const res = await repo.markFailed('e1', 'tok', 'boom', 8);
    expect(res).toBe('dead');
    expect(prisma.outboxEvent.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'dead',
      lastError: 'boom',
    });
  });

  it('旧 Worker 的 claimToken 已失效时返回 null，不得触发后续业务状态改写', async () => {
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.markFailed('e1', 'tok-stale', 'late failure', 8)).resolves.toBeNull();
  });
});

describe('OutboxWorker 钉钉建群幂等', () => {
  let prisma: any;
  let outbox: any;
  let dingtalk: any;
  let crm: any;
  let worker: OutboxWorker;
  let contractStorageDir: string;

  const claim = (over: any = {}) => ({
    event: { ...CANDIDATE, ...over },
    claimToken: 'tok',
  });

  beforeEach(() => {
    prisma = makePrisma();
    outbox = {
      claimNext: vi.fn().mockResolvedValue([]),
      markSucceeded: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(),
    };
    dingtalk = {
      createGroup: vi.fn().mockResolvedValue({ chatId: 'g1', title: '群', members: ['U1', 'B1'] }),
      addMember: vi.fn().mockResolvedValue(undefined),
      sendNotification: vi.fn().mockResolvedValue(undefined),
    };
    crm = { writeBack: vi.fn().mockResolvedValue(undefined) };
    contractStorageDir = mkdtempSync(join(tmpdir(), 'legalos-crm-delivery-'));
    worker = new OutboxWorker(
      prisma as any,
      outbox as any,
      dingtalk as any,
      crm as any,
      makeConfig({ CONTRACT_STORAGE_DIR: contractStorageDir }) as any,
    );
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      where.id === 'u1'
        ? { dingtalkUserId: 'U1', displayName: '业务', isActive: true, role: 'business' }
        : { dingtalkUserId: 'B1', displayName: '彭宇欣', isActive: true, role: 'legal_bp' },
    );
  });

  afterEach(() => {
    rmSync(contractStorageDir, { recursive: true, force: true });
  });

  it('已有真实群 → 不再建群，标记 succeeded', async () => {
    outbox.claimNext.mockResolvedValue([claim()]);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', dingtalkChatId: 'c1', status: '分析中', title: '测试', risk: 'P1', legalBpId: 'bp1', creatorId: 'u1', requesterName: null,
    });
    await worker.pollOnce();
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('工单已取消 → 跳过建群，标记 succeeded', async () => {
    outbox.claimNext.mockResolvedValue([claim()]);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', dingtalkChatId: null, status: '已取消', title: '测试', risk: 'P1', legalBpId: 'bp1', creatorId: 'u1', requesterName: null,
    });
    await worker.pollOnce();
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('建群：dedupKey=legalos-{projectId}，成员按最新指派关系生成', async () => {
    outbox.claimNext.mockResolvedValue([claim()]);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', dingtalkChatId: null, status: '分析中', title: '测试工单', risk: 'P1', legalBpId: 'bp1', creatorId: 'u1', requesterName: null,
    });
    await worker.pollOnce();
    expect(dingtalk.createGroup).toHaveBeenCalledWith(
      ['U1', 'B1'],
      expect.stringContaining('工单#'),
      'U1',
      'legalos-p1',
    );
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ dingtalkChatId: 'g1' }),
      }),
    );
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('无法务成员 → 不建群 + 记录请人工建群事件，标记 succeeded', async () => {
    outbox.claimNext.mockResolvedValue([claim()]);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', dingtalkChatId: null, status: '分析中', title: '测试', risk: 'P1', legalBpId: null, creatorId: 'u1', requesterName: null,
    });
    await worker.pollOnce();
    expect(dingtalk.createGroup).not.toHaveBeenCalled();
    expect(prisma.projectEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ text: expect.stringContaining('请人工建群') }) }),
    );
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('处理抛错 → markFailed（claimToken 守卫），不出现 PENDING 哨兵', async () => {
    outbox.claimNext.mockResolvedValue([claim()]);
    prisma.project.findUnique.mockRejectedValue(new Error('db down'));
    await worker.pollOnce();
    expect(outbox.markFailed).toHaveBeenCalledWith('e1', 'tok', expect.stringContaining('db down'), 1);
    // 建群路径从未写 dingtalkChatId='PENDING'
    const updateCalls = prisma.project.update.mock.calls.map((c: any) => c[1]?.data?.dingtalkChatId);
    expect(updateCalls).not.toContain('PENDING');
  });

  it('补拉新 BP：由 Worker 调钉钉并更新成员快照，且事件成功', async () => {
    outbox.claimNext.mockResolvedValue([
      claim({
        eventType: 'dingtalk.member.add',
        payload: { projectId: 'p1', userId: 'bp1' },
      }),
    ]);
    prisma.project.findUnique.mockResolvedValue({
      dingtalkChatId: 'g1',
      dingtalkMembers: '["U1"]',
      status: '待复核',
      legalBpId: 'bp1',
    });
    prisma.user.findUnique.mockResolvedValue({ dingtalkUserId: 'B1', displayName: '法务BP', isActive: true, role: 'legal_bp' });

    await worker.pollOnce();

    expect(dingtalk.addMember).toHaveBeenCalledWith('g1', 'B1');
    expect(prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', dingtalkMembers: '["U1"]' },
      data: { dingtalkMembers: '["U1","B1"]' },
    });
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it.each([
    { isActive: false, role: 'legal_bp', legalBpId: 'bp1' },
    { isActive: true, role: 'business', legalBpId: 'bp1' },
    { isActive: true, role: 'legal_bp', legalBpId: 'bp2' },
  ])('延迟邀请跳过停用、降权或过期指派 %#', async (state) => {
    outbox.claimNext.mockResolvedValue([claim({
      eventType: 'dingtalk.member.add', payload: { projectId: 'p1', userId: 'bp1' },
    })]);
    prisma.project.findUnique.mockResolvedValue({
      dingtalkChatId: 'g1', dingtalkMembers: '[]', status: '待复核', legalBpId: state.legalBpId,
    });
    prisma.user.findUnique.mockResolvedValue({ ...state, dingtalkUserId: 'B1', displayName: '法务' });
    await worker.pollOnce();
    expect(dingtalk.addMember).not.toHaveBeenCalled();
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('CRM 交付：收到成功回执后才标记 delivered', async () => {
    const projectDir = join(contractStorageDir, 'p1');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'final.docx'), 'file-bytes');
    outbox.claimNext.mockResolvedValue([
      claim({
        eventType: 'crm.review-result.deliver',
        payload: { projectId: 'p1', contractFileId: 'f1' },
      }),
    ]);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', sourceAppId: 'crm-legal', crmTaskId: 'task-1', contractNo: 'HT-1', crmReference: null,
      crmDeliveryStatus: 'pending', crmDeliveryFileId: 'f1',
      reviewCompletedAt: new Date('2026-08-31T00:00:00Z'), result: '审核通过',
    });
    prisma.contractFile.findFirst.mockResolvedValue({
      id: 'f1', projectId: 'p1', storedName: 'final.docx', originalName: '定稿.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10,
      uploader: { role: 'legal_bp' },
    });

    await worker.pollOnce();

    expect(crm.writeBack).toHaveBeenCalledWith(expect.objectContaining({
      sourceAppId: 'crm-legal', crmTaskId: 'task-1', contractNo: 'HT-1', projectId: 'p1', conclusion: '审核通过',
      file: expect.objectContaining({ id: 'f1', originalName: '定稿.docx' }),
    }));
    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ crmDeliveryStatus: 'delivered' }),
    }));
    expect(outbox.markSucceeded).toHaveBeenCalledWith('e1', 'tok');
  });

  it('CRM 交付失败：保留内部审核完成状态，交付单独标记 failed 并重试', async () => {
    const projectDir = join(contractStorageDir, 'p1');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'final.docx'), 'file-bytes');
    outbox.claimNext.mockResolvedValue([
      claim({
        eventType: 'crm.review-result.deliver',
        payload: { projectId: 'p1', contractFileId: 'f1' },
      }),
    ]);
    outbox.markFailed.mockResolvedValue('pending');
    crm.writeBack.mockRejectedValue(new Error('CRM 503'));
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', sourceAppId: 'crm-legal', crmTaskId: 'task-1', contractNo: 'HT-1', crmReference: null,
      crmDeliveryStatus: 'pending', crmDeliveryFileId: 'f1',
      reviewCompletedAt: new Date('2026-08-31T00:00:00Z'), result: '审核通过',
    });
    prisma.contractFile.findFirst.mockResolvedValue({
      id: 'f1', projectId: 'p1', storedName: 'final.docx', originalName: '定稿.docx', mimeType: null, size: 10,
      uploader: { role: 'legal_bp' },
    });

    await worker.pollOnce();

    expect(outbox.markFailed).toHaveBeenCalledWith('e1', 'tok', 'CRM 503', 1);
    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'p1', crmDeliveryStatus: { not: 'delivered' } },
      data: expect.objectContaining({ crmDeliveryStatus: 'failed', crmDeliveryLastError: 'CRM 503' }),
    }));
  });

  it('CRM 交付事件引用的文件与法务确认绑定不一致时拒绝外发', async () => {
    outbox.claimNext.mockResolvedValue([
      claim({
        eventType: 'crm.review-result.deliver',
        payload: { projectId: 'p1', contractFileId: 'stale-file' },
      }),
    ]);
    outbox.markFailed.mockResolvedValue('pending');
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', sourceAppId: 'crm-legal', crmTaskId: 'task-1',
      crmDeliveryStatus: 'pending', crmDeliveryFileId: 'confirmed-file',
      reviewCompletedAt: new Date('2026-08-31T00:00:00Z'), result: '审核通过',
    });

    await worker.pollOnce();

    expect(crm.writeBack).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(
      'e1',
      'tok',
      'CRM 交付文件与法务确认版本不一致',
      1,
    );
  });

  it('旧 Worker 交付失败但 claimToken 已失效时，不覆盖新 Worker 的交付状态', async () => {
    outbox.claimNext.mockResolvedValue([
      claim({
        eventType: 'crm.review-result.deliver',
        payload: { projectId: 'p1', contractFileId: 'stale-file' },
      }),
    ]);
    outbox.markFailed.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', sourceAppId: 'crm-legal', crmTaskId: 'task-1',
      crmDeliveryStatus: 'sending', crmDeliveryFileId: 'confirmed-file',
      reviewCompletedAt: new Date('2026-08-31T00:00:00Z'), result: '审核通过',
    });

    await worker.pollOnce();

    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.projectEvent.create).not.toHaveBeenCalled();
  });
});
