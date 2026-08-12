import { ProjectStatus, Role } from '@prisma/client';

/**
 * 操作者（工单对象级授权）。Controller 从 @CurrentUser 提取 id/role 后传给 Service，
 * 禁止 Service 在缺少操作者时执行受保护动作。
 */
export interface ProjectActor {
  id: string;
  role: Role;
}

/**
 * 权限策略所需的最小工单形状。ContractService 等传入完整 Project 亦可（结构兼容）。
 * 不使用 `Project` 全类型，避免对 Prisma 生成的类型产生不必要的耦合。
 */
export interface ProjectLike {
  id: string;
  creatorId: string;
  ownerId: string;
  legalBpId: string | null;
  status?: ProjectStatus;
}

/** 工单对象级动作枚举（P1-01）。Controller 的 @Roles() 只做角色粗筛，不能替代对象级授权。 */
export enum ProjectAction {
  List = 'list',
  Read = 'read',
  SendMessage = 'send-message',
  Update = 'update',
  Claim = 'claim',
  Transfer = 'transfer',
  Reply = 'reply',
  Cancel = 'cancel',
  ReviewContract = 'review-contract',
  ManageFile = 'manage-file',
  /** business 发起法务审阅（仅自己创建的合同工单） */
  SubmitReview = 'submit-review',
  /** 用户申请升级人工处理（business 仅自己创建、未取消；lead/admin 全部） */
  Escalate = 'escalate',
}
