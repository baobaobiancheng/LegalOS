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

// 通讯录同步条目（user/list 分页拉取）
export interface ContactInfo {
  userId: string;
  name: string;
  mobile?: string;
}

export interface CrmAdapter {
  getContext(customerId: string, params?: Record<string, string>): Promise<CrmContext>;
  writeBack(projectId: string, result: string): Promise<void>;
}

export interface DingTalkAdapter {
  /** 拉群：members 为钉钉 userid 数组；ownerUserId 群主（必填参数），缺省取第一个成员 */
  createGroup(members: string[], projectTitle: string, ownerUserId?: string): Promise<DingTalkGroup>;
  /** 转派加人：新 BP 进群（旧成员不移除，工程评审决策 #15） */
  addMember(chatId: string, userId: string): Promise<void>;
  /** 发群消息（机器人） */
  sendNotification(chatId: string, message: string): Promise<void>;
  /** 通讯录同步：部门树遍历 + 分页 + userid 去重 */
  syncContacts(): Promise<ContactInfo[]>;
}

export const CRM_ADAPTER = 'CRM_ADAPTER';
export const DINGTALK_ADAPTER = 'DINGTALK_ADAPTER';
