/** 认证域类型 — 严格对齐设计文档 */

export const Role = {
  LEGAL_BP: 'legal_bp',
  LEGAL_LEAD: 'legal_lead',
  BUSINESS: 'business',
  ADMIN: 'admin',
} as const
export type Role = (typeof Role)[keyof typeof Role]

/** 三端首页映射（设计文档「三端首页映射」） */
export const HOME_BY_ROLE: Record<Role, string> = {
  business: '/business/consult',
  legal_bp: '/legal/projects',
  legal_lead: '/legal/projects',
  admin: '/admin/dashboard',
}

export const ROLE_LABEL: Record<Role, string> = {
  legal_bp: '法务 BP',
  legal_lead: '法务负责人',
  business: '业务人员',
  admin: '系统管理员',
}

export type User = {
  id: string
  username: string
  role: Role
  displayName: string
}

export type ApiError = {
  error: string
  code: string
  statusCode: number
  lockedUntil?: string
}

// ── 工单类型 ──
export type ProjectKind = 'consult' | 'contract' | 'research' | 'draft'
export type ProjectStatus = '分析中' | '待处理' | '待复核' | '已回传' | '已取消'
export type RiskLevel = 'P0' | 'P1' | 'P2'

export type ProjectListItem = {
  id: string
  kind: ProjectKind
  title: string
  status: ProjectStatus
  risk: RiskLevel
  route: string
  isFailed: boolean
  creator: UserBrief
  owner: UserBrief
  legalBp?: UserBrief
  requesterName?: string
  createdAt: string
  updatedAt: string
}

export type ProjectDetail = ProjectListItem & {
  skillId?: string
  skillName?: string
  model?: string
  result?: string
  crmReference?: string
  crmCustomer?: string
  contractTemplateSlug?: string
  files?: ContractFile[]
  messages: MessageDto[]
  events: EventDto[]
}

export type UserBrief = {
  id: string
  username: string
  displayName: string
  role: Role
}

export type MessageDto = {
  id: string
  role: 'user' | 'assistant' | 'legal' | 'event'
  text: string
  label?: string
  createdAt: string
}

export type EventDto = {
  id: string
  text: string
  createdAt: string
}

export type ProjectListResponse = {
  items: ProjectListItem[]
  groups: Record<string, ProjectListItem[]>
  total: number
  page: number
  size: number
}

// ── 合同协作类型 ──
import type { ContractDocStyle } from './utils/markdown-to-docx'

export type ContractElementField = {
  key: string
  label: string
  type: 'text' | 'textarea'
  required?: boolean
  placeholder?: string
  /** 表单分组：basic=基本信息（默认显示）/ details=详细信息（可折叠） */
  group?: 'basic' | 'details'
}

export type ContractTemplate = {
  slug: string
  name: string
  category: string
  description?: string
  /** 导出样式（每模板独立：字体/字号/页边距/行距） */
  style?: ContractDocStyle
  /** 合同要素表单 schema（前端动态渲染） */
  elementsSchema?: ContractElementField[]
}

export type ContractFile = {
  id: string
  kind: 'revised' | 'final'
  originalName: string
  size: number
  createdAt: string
  uploader?: { displayName: string }
}
