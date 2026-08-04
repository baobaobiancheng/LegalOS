import { ProjectKind, ProjectStatus, RiskLevel, Role } from '@prisma/client';

// 精简用户信息
export interface UserBrief {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

// 消息
export interface MessageDto {
  id: string;
  role: string;
  text: string;
  label?: string;
  createdAt: string;
}

// 事件
export interface EventDto {
  id: string;
  text: string;
  createdAt: string;
}

// 工单列表项
export interface ProjectListItem {
  id: string;
  kind: ProjectKind;
  title: string;
  status: ProjectStatus;
  risk: RiskLevel;
  route: string;
  isFailed: boolean;
  creator: UserBrief;
  owner: UserBrief;
  legalBp?: UserBrief;
  requesterName?: string;
  createdAt: string;
  updatedAt: string;
}

// 工单详情
export interface ProjectDetail extends ProjectListItem {
  input: string;
  skillId?: string;
  skillName?: string;
  model?: string;
  result?: string;
  crmReference?: string;
  crmCustomer?: string;
  messages: MessageDto[];
  events: EventDto[];
}
