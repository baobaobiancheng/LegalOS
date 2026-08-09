import { describe, it, expect, vi } from 'vitest';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { ProjectAction, ProjectActor, ProjectLike } from '../src/modules/project/domain/project-access.types';

/**
 * P1-01 权限矩阵单测（任务书 5.2/5.4）：
 * - business A 读取/发消息/操作 business B 的工单 → 失败
 * - legal_bp A 读取/修改指派给 legal_bp B 的工单 → 失败
 * - legal_bp 可认领未分配；不可转派/取消；可查看未分配队列摘要
 * - legal_lead/admin 全部放行
 * - listScope 服务端生成查询范围（业务仅自己 / BP 自己+未分配 / 负责人全部）
 */

const policy = new ProjectAccessPolicy();

const actor = (id: string, role: ProjectActor['role']): ProjectActor => ({ id, role });

const project = (over: Partial<ProjectLike> = {}): ProjectLike => ({
  id: 'p1',
  creatorId: 'bizA',
  ownerId: 'bizA',
  legalBpId: null,
  status: '分析中',
  ...over,
});

describe('ProjectAccessPolicy 权限矩阵', () => {
  it('business A 读取 business B 创建的工单 → 失败', () => {
    const p = project({ creatorId: 'bizB' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.Read, p)).toThrow('无权执行此操作');
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.SendMessage, p)).toThrow();
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.ManageFile, p)).toThrow();
  });

  it('business 读/发消息/附件 自己的工单 → 放行', () => {
    const p = project({ creatorId: 'bizA' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.Read, p)).not.toThrow();
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.SendMessage, p)).not.toThrow();
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.ManageFile, p)).not.toThrow();
  });

  it('business 取消：仅创建者且未完成/未取消', () => {
    const own = project({ creatorId: 'bizA', status: '待处理' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.Cancel, own)).not.toThrow();
    const finished = project({ creatorId: 'bizA', status: '已回传' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.Cancel, finished)).toThrow();
    const other = project({ creatorId: 'bizB', status: '待处理' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.Cancel, other)).toThrow();
  });

  it('business 禁止 update / transfer / reply / review / claim', () => {
    const own = project({ creatorId: 'bizA' });
    for (const action of [ProjectAction.Update, ProjectAction.Transfer, ProjectAction.Reply, ProjectAction.ReviewContract, ProjectAction.Claim]) {
      expect(() => policy.assertCan(actor('bizA', 'business'), action, own)).toThrow();
    }
  });

  it('legal_bp A 读取/修改指派给 legal_bp B 的工单 → 失败', () => {
    const p = project({ legalBpId: 'bpB', ownerId: 'bpB' });
    for (const action of [ProjectAction.Read, ProjectAction.SendMessage, ProjectAction.Update, ProjectAction.Reply, ProjectAction.ReviewContract, ProjectAction.ManageFile]) {
      expect(() => policy.assertCan(actor('bpA', 'legal_bp'), action, p)).toThrow();
    }
  });

  it('legal_bp 可操作已指派给自己的工单（legalBpId 或 ownerId）', () => {
    const byLegal = project({ legalBpId: 'bpA', ownerId: 'bpA' });
    const byOwner = project({ legalBpId: 'bpB', ownerId: 'bpA' });
    for (const p of [byLegal, byOwner]) {
      expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Read, p)).not.toThrow();
      expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Update, p)).not.toThrow();
      expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.ReviewContract, p)).not.toThrow();
    }
  });

  it('legal_bp 可认领未分配；已分配则不可认领', () => {
    const unassigned = project({ legalBpId: null });
    expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Claim, unassigned)).not.toThrow();
    const assigned = project({ legalBpId: 'bpB' });
    expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Claim, assigned)).toThrow();
  });

  it('legal_bp 不能转派 / 取消（P1-01：默认最小权限）', () => {
    const own = project({ legalBpId: 'bpA', ownerId: 'bpA' });
    expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Transfer, own)).toThrow();
    expect(() => policy.assertCan(actor('bpA', 'legal_bp'), ProjectAction.Cancel, own)).toThrow();
  });

  it('legal_lead / admin 全部放行（读/发消息/更新/转派/回传/取消/审查/附件）', () => {
    const p = project({ creatorId: 'bizA', legalBpId: 'bpB' });
    for (const role of ['legal_lead', 'admin'] as const) {
      for (const action of [
        ProjectAction.Read, ProjectAction.SendMessage, ProjectAction.Update,
        ProjectAction.Claim, ProjectAction.Transfer, ProjectAction.Reply,
        ProjectAction.Cancel, ProjectAction.ReviewContract, ProjectAction.ManageFile,
      ]) {
        expect(() => policy.assertCan(actor('lead', role), action, p)).not.toThrow();
      }
    }
  });

  it('listScope：business 仅自己创建；legal_bp 自己+未分配；lead/admin 全部', () => {
    expect(policy.listScope(actor('bizA', 'business'))).toEqual({ creatorId: 'bizA' });
    expect(policy.listScope(actor('bpA', 'legal_bp'))).toEqual({
      OR: [{ legalBpId: 'bpA' }, { legalBpId: null }],
    });
    expect(policy.listScope(actor('lead', 'legal_lead'))).toEqual({});
    expect(policy.listScope(actor('admin', 'admin'))).toEqual({});
  });

  it('SubmitReview：business 仅自己创建', () => {
    const own = project({ creatorId: 'bizA' });
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.SubmitReview, own)).not.toThrow();
    expect(() => policy.assertCan(actor('bizA', 'business'), ProjectAction.SubmitReview, project({ creatorId: 'bizB' }))).toThrow();
  });
});
