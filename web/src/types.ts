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
