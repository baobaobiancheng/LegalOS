// CRM 上下文
export interface CrmContext {
  customer: string;
  reference: string;
  opportunity?: string;
  businessType?: string;
}

// 钉钉群信息
export interface DingTalkGroup {
  chatId: string;
  title: string;
  members: string[];
}

export interface CrmAdapter {
  getContext(customerId: string, params?: Record<string, string>): Promise<CrmContext>;
  writeBack(projectId: string, result: string): Promise<void>;
}

export interface DingTalkAdapter {
  createGroup(members: string[], projectTitle: string): Promise<DingTalkGroup>;
  sendNotification(chatId: string, message: string): Promise<void>;
}

export const CRM_ADAPTER = 'CRM_ADAPTER';
export const DINGTALK_ADAPTER = 'DINGTALK_ADAPTER';
