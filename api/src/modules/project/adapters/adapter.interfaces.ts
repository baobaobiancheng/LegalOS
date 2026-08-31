// CRM 上下文
export interface CrmContext {
  customer: string;
  reference: string;
  opportunity?: string;
  businessType?: string;
}

export interface CrmDeliveryFile {
  id: string;
  originalName: string;
  mimeType?: string | null;
  size: number;
  /** 适配器内部读取的服务端文件路径，不对外暴露。 */
  path: string;
}

export interface CrmReviewResultDelivery {
  sourceAppId: string;
  crmTaskId: string;
  contractNo: string | null;
  projectId: string;
  conclusion: string;
  reviewCompletedAt: string;
  file: CrmDeliveryFile;
}

// 钉钉群信息
export interface DingTalkGroup {
  chatId: string;
  title: string;
  members: string[];
}

// 通讯录同步条目（user/list 分页拉取；department=钉钉部门名,2026-08-11 组织架构身份映射）
export interface ContactInfo {
  userId: string;
  name: string;
  mobile?: string;
  avatarUrl?: string;
  department?: string;
  /** 同一员工可同时隶属多个钉钉部门；department 为后续业务选定的有效部门。 */
  departments?: string[];
}

/** 通讯录同步结构化结果（P1-07）：complete=false 时不允许失效对账/自动绑定 */
export interface ContactSyncResult {
  contacts: ContactInfo[];
  complete: boolean;
  departmentCount: number;
  pageCount: number;
  warnings: string[];
}

/** 同步不完整（P1-07）：深度/分页达到上限、空结果 → 抛此错误，批次标记 failed，旧快照不受影响 */
export class DingTalkSyncIncompleteError extends Error {
  constructor(
    message: string,
    readonly detail?: { departmentCount: number; pageCount: number; truncatedDepth: boolean; truncatedPage: boolean },
  ) {
    super(message);
    this.name = 'DingTalkSyncIncompleteError';
  }
}

export interface CrmAdapter {
  getContext(customerId: string, params?: Record<string, string>): Promise<CrmContext>;
  /** 审核结果交付必须以 crmTaskId 幂等；返回即表示 CRM 已明确接收。 */
  writeBack(delivery: CrmReviewResultDelivery): Promise<void>;
}

export interface DingTalkAdapter {
  /** 拉群：members 为钉钉 userid 数组；ownerUserId 群主（必填参数），缺省取第一个成员；dedupKey 建群去重业务ID（同一工单只建一个群，P1-03） */
  createGroup(members: string[], projectTitle: string, ownerUserId?: string, dedupKey?: string): Promise<DingTalkGroup>;
  /** 转派加人：新 BP 进群（旧成员不移除，工程评审决策 #15） */
  addMember(chatId: string, userId: string): Promise<void>;
  /** 发群消息（机器人） */
  sendNotification(chatId: string, message: string): Promise<void>;
  /** 通讯录同步：部门树遍历 + 分页 + userid 去重；不完整（深度/分页/空）抛 DingTalkSyncIncompleteError */
  syncContacts(): Promise<ContactSyncResult>;
}

export const CRM_ADAPTER = 'CRM_ADAPTER';
export const DINGTALK_ADAPTER = 'DINGTALK_ADAPTER';
