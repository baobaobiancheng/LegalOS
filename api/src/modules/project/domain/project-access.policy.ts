import { ForbiddenException, Injectable } from '@nestjs/common';
import { ProjectAction, ProjectActor, ProjectLike } from './project-access.types';
import { Prisma } from '@prisma/client';

/**
 * 统一工单对象级权限策略（P1-01，任务书 5.2 权限矩阵）。
 *
 * 所有工单详情、消息、更新、回传、取消、转派、合同审查、附件接口都通过本策略判断，
 * Controller 的 @Roles() 只做角色粗筛，不能替代对象级授权。
 *
 * 权限矩阵（business / legal_bp / legal_lead / admin）：
 *   - 查看列表    : 仅自己创建 / 仅 legalBpId 指派给自己 / 全部 / 全部
 *   - 查看详情    : 仅自己创建 / 仅 legalBpId 指派给自己 / 全部 / 全部
 *   - 发送普通消息: 仅自己创建 / 仅已指派给自己 / 全部 / 全部
 *   - 更新状态/风险/结果: 禁止 / 仅已指派给自己（字段受限）/ 全部 / 全部
 *   - 认领        : 禁止 / 禁止 / 允许 / 允许
 *   - 转派        : 禁止 / 禁止 / 允许 / 允许
 *   - 法务正式回传: 禁止 / 仅已指派给自己 / 允许 / 允许
 *   - 取消        : 仅创建者且未完成 / 禁止 / 允许 / 允许
 *   - 合同审查    : 禁止 / 仅已指派给自己 / 允许 / 允许
 *   - 附件操作    : 仅自己创建 / 仅已指派给自己 / 全部 / 全部
 *
 * 未命中自动分配规则的工单由法务领导分配，普通 BP 不参与公共池认领。
 * ownerId 在建单时也可能是申请人，不能作为法务处理权限的替代凭据。
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

  /** 法务处理权限只认明确的指派字段，不从创建者/历史 owner 推断。 */
  private isAssigned(actor: ProjectActor, project: ProjectLike): boolean {
    return project.legalBpId === actor.id;
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
      case ProjectAction.List:
        return true; // 列表范围由 listScope 服务端生成
      case ProjectAction.Claim:
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
   * - legal_bp：仅 legalBpId 指派给自己
   * - legal_lead / admin：全部
   */
  listScope(actor: ProjectActor): Prisma.ProjectWhereInput {
    switch (actor.role) {
      case 'admin':
      case 'legal_lead':
        return {};
      case 'business':
        return { creatorId: actor.id };
      case 'legal_bp':
        return { legalBpId: actor.id };
      default:
        return { creatorId: actor.id };
    }
  }
}
