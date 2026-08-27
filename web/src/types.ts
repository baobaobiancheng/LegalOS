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
  /** P2-03：服务端请求 ID(响应头 X-Request-ID / 错误体 requestId),用于排查与展示 */
  requestId?: string
}

// ── 工单类型 ──
export type ProjectKind = 'consult' | 'contract' | 'research' | 'draft'
export type ProjectStatus = '分析中' | '待处理' | '待复核' | '已回传' | '已取消'
export type RiskLevel = 'P0' | 'P1' | 'P2'
export type ProjectGroupKey = '待处理' | '合同协作' | '已回传' | '数字分身处理'

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
  research?: {
    capability: 'law_search' | 'similar_case'
    trace: ResearchTraceV1
  }
}

export type ResearchTraceV1 = {
  schemaVersion: 1
  capability: 'law_search' | 'similar_case'
  status: 'success_hit' | 'success_empty'
  dshSessionId: string
  calls: Array<{ tool: string; query: string; recordIds: string[]; records: Array<Record<string, unknown>> }>
  report?: AiLawResearchReportV1
  limitations: string[]
}

export type AiLawResearchSectionV1 = {
  id: string
  title: string
  content: string
  sourceIds: string[]
}

export type AiLawResearchSourceV1 = {
  recordId: string
  lawName: string
  issuingOrgan: string | null
  issuingNo: string | null
  releaseDate: string | null
  implementDate: string | null
  timeliness: string | null
  articles: Array<{ article: string; text: string }>
}

export type AiLawResearchReportV1 = {
  schemaVersion: 1
  query: string
  title: string
  scope: string
  summary: string
  sections: AiLawResearchSectionV1[]
  sources: AiLawResearchSourceV1[]
  limitations: string[]
  generatedAt: string
  metrics: {
    candidateCount: number
    verifiedSourceCount: number
    citedSourceCount: number
  }
}

export type EventDto = {
  id: string
  text: string
  createdAt: string
}

export type ProjectListResponse = {
  items: ProjectListItem[]
  groups: Record<ProjectGroupKey, ProjectListItem[]>
  groupCounts: Record<ProjectGroupKey, number>
  statusCounts: Record<ProjectStatus, number>
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

// ── 技能库类型（2026-08-04 技能库模块） ──
export type SkillVisibility = 'private' | 'pending' | 'public'

export type Skill = {
  id: string
  slug: string
  name: string
  group: string
  description: string
  /** 列表接口对 business 剥离（后端保证）；法务详情可见 */
  prompt?: string
  visibility: SkillVisibility
  isActive: boolean
  creator?: UserBrief
  approver?: UserBrief
  approvedAt?: string
  /** append-only 审核记录（我的技能列表与法务详情可见）：[{action, reviewerId, reason?, at}] */
  reviewLog?: { action: 'approve' | 'reject'; reviewerId: string; reason?: string; at: string }[]
  createdAt: string
  updatedAt: string
}

/** 最近一次驳回原因（审核历史可查，设计文档 §2） */
export const lastRejectReason = (s: Skill): string | undefined =>
  [...(s.reviewLog || [])].reverse().find((l) => l.action === 'reject')?.reason

/** 技能组白名单（与后端 skill.constants 同源） */
export const SKILL_GROUPS = [
  '合规法务',
  '合同与交易',
  '劳动法务',
  '争议法务',
  '法律研究',
  '知识运营',
] as const

/** prompt 长度上限（与后端 skill.constants SKILL_PROMPT_MAX_LENGTH 同源） */
export const SKILL_PROMPT_MAX_LENGTH = 4000

/** 兜底技能（不落库：选中提交 skillId=null，后端不注入） */
export const GENERAL_SKILL = { slug: 'general', name: '通用法务咨询' }
