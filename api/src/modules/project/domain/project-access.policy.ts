import { ForbiddenException, Injectable } from '@nestjs/common';
import { ProjectAction, ProjectActor, ProjectLike } from './project-access.types';

/**
 * 统一工单对象级权限策略（P1-01，任务书 5.2 权限矩阵）。
 *
 * 所有工单详情、消息、更新、回传、取消、转派、合同审查、附件接口都通过本策略判断，
 * Controller 的 @Roles() 只做角色粗筛，不能替代对象级授权。
 *
 * 权限矩阵（business / legal_bp / legal_lead / admin）：
 *   - 查看列表    : 仅自己创建 / 仅指派给自己 + 未分配认领摘要 / 全部 / 全部
 *   - 查看详情    : 仅自己创建 / 仅 legalBpId 或 ownerId 为自己 / 全部 / 全部
 *   - 发送普通消息: 仅自己创建 / 仅已指派给自己 / 全部 / 全部
 *   - 更新状态/风险/结果: 禁止 / 仅已指派给自己（字段受限）/ 全部 / 全部
 *   - 认领        : 禁止 / 允许（原子条件更新）/ 允许 / 允许
 *   - 转派        : 禁止 / 禁止 / 允许 / 允许
 *   - 法务正式回传: 禁止 / 仅已指派给自己 / 允许 / 允许
 *   - 取消        : 仅创建者且未完成 / 禁止 / 允许 / 允许
 *   - 合同审查    : 禁止 / 仅已指派给自己 / 允许 / 允许
 *   - 附件操作    : 仅自己创建 / 仅已指派给自己 / 全部 / 全部
 *
 * 产品决策说明：默认按最小权限执行上表。若产品明确要求"法务 BP 可互相转派/可直接
 * 回传认领未分配工单"，需产品确认后调整，本版本不回退为宽松语义。
 */
@Injectable()
export class ProjectAccessPolicy {
  /** 无权限时统一抛 ForbiddenException；读取类接口也保持 403（与既有行为一致，项目内统一）。 */
  assertCan(actor: ProjectActor, action: ProjectAction, project: ProjectLike): void {
    if (!this.can(actor, action, project)) {
      throw new ForbiddenException('无权执行此操作');
    }
  }

  can(actor: ProjectActor, action: ProjectAction, project: ProjectLike): boolean {
    switch (actor.role) {
      case 'admin':
      case 'legal_lead':
        return this.canLead(actor, action, project);
      case 'legal_bp':
        return this.canLegalBp(actor, action, project);
      case 'business':
        return this.canBusiness(actor, action, project);
      default:
        return false;
    }
  }

  /** 是否已指派给该法务 BP（legalBpId 或 ownerId 为自己） */
  private isAssigned(actor: ProjectActor, project: ProjectLike): boolean {
    return project.legalBpId === actor.id || project.ownerId === actor.id;
  }

  private canLead(_actor: ProjectActor, _action: ProjectAction, _project: ProjectLike): boolean {
    return true;
  }

  private canLegalBp(actor: ProjectActor, action: ProjectAction, project: ProjectLike): boolean {
    switch (action) {
      case ProjectAction.Read:
      case ProjectAction.SendMessage:
      case ProjectAction.Update:
      case ProjectAction.Reply:
      case ProjectAction.ReviewContract:
      case ProjectAction.ManageFile:
        return this.isAssigned(actor, project);
      case ProjectAction.Claim:
        return project.legalBpId === null;
      case ProjectAction.List:
        return true; // 列表范围由 listScope 服务端生成
      case ProjectAction.Transfer:
      case ProjectAction.Cancel:
      case ProjectAction.SubmitReview:
        return false;
      default:
        return false;
    }
  }

  private canBusiness(actor: ProjectActor, action: ProjectAction, project: ProjectLike): boolean {
    switch (action) {
      case ProjectAction.Read:
      case ProjectAction.SendMessage:
      case ProjectAction.ManageFile:
      case ProjectAction.SubmitReview:
        return project.creatorId === actor.id;
      case ProjectAction.Cancel:
        return (
          project.creatorId === actor.id &&
          project.status !== '已取消' &&
          project.status !== '已回传'
        );
      case ProjectAction.Escalate:
        // 仅自己创建、且未取消的工单可申请升级（AI 已回传的 P2 允许升级）
        return project.creatorId === actor.id && project.status !== '已取消';
      case ProjectAction.List:
        return true; // 列表范围由 listScope 服务端生成
      case ProjectAction.Claim:
      case ProjectAction.Transfer:
      case ProjectAction.Update:
      case ProjectAction.Reply:
      case ProjectAction.ReviewContract:
        return false;
      default:
        return false;
    }
  }

  /**
   * 列表服务端范围（5.3.4）：禁止客户端提交任意 creatorId/ownerId/legalBpId 绕过范围。
   * - business：仅自己创建
   * - legal_bp：仅指派给自己 + 未分配（可认领摘要）
   * - legal_lead / admin：全部
   */
  listScope(actor: ProjectActor): Record<string, unknown> {
    switch (actor.role) {
      case 'admin':
      case 'legal_lead':
        return {};
      case 'business':
        return { creatorId: actor.id };
      case 'legal_bp':
        return { OR: [{ legalBpId: actor.id }, { legalBpId: null }] };
      default:
        return { creatorId: actor.id };
    }
  }
}
