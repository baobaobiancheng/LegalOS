import type { CrmDeliveryStatus, ProjectStatus } from '../types'

/**
 * P2-02：前端唯一工单状态配置。
 * 页面不得各自维护状态数组/颜色/分组/动作；新增状态时 `satisfies Record<ProjectStatus, ...>`
 * 会让 TypeScript 在配置缺失时编译失败。
 */
export type ProjectStatusGroup = 'processing' | 'completed' | 'cancelled'
export type ProjectStatusAction = 'view' | 'cancel' | 'reply' | 'transfer'

export interface ProjectStatusMeta {
  label: string
  group: ProjectStatusGroup
  tone: 'info' | 'warning' | 'success' | 'neutral'
  terminal: boolean
  actions: readonly ProjectStatusAction[]
}

export const PROJECT_STATUS_META = {
  分析中: { label: '分析中', group: 'processing', tone: 'info', terminal: false, actions: ['view', 'cancel'] },
  待处理: { label: '待处理', group: 'processing', tone: 'warning', terminal: false, actions: ['view', 'cancel'] },
  待复核: { label: '待复核', group: 'processing', tone: 'warning', terminal: false, actions: ['view', 'cancel', 'reply', 'transfer'] },
  已回传: { label: '已完成', group: 'completed', tone: 'success', terminal: true, actions: ['view'] },
  已取消: { label: '已取消', group: 'cancelled', tone: 'neutral', terminal: true, actions: ['view'] },
} satisfies Record<ProjectStatus, ProjectStatusMeta>

/** 五种状态穷尽断言：新增状态后若未在配置中处理,这里会编译失败 */
export const ALL_PROJECT_STATUSES: ProjectStatus[] = Object.keys(PROJECT_STATUS_META) as ProjectStatus[]

/** 归组：processing = 分析中/待处理/待复核 */
export function isStatusInGroup(status: ProjectStatus, group: ProjectStatusGroup): boolean {
  return PROJECT_STATUS_META[status].group === group
}

/** 状态是否允许某动作（仅供前端显示控制；真实鉴权始终以服务端 ProjectAccessPolicy 为准） */
export function statusAllowsAction(status: ProjectStatus, action: ProjectStatusAction): boolean {
  // actions 被 satisfies 推断为字面量元组,显式按 ProjectStatusAction[] 判断
  return (PROJECT_STATUS_META[status].actions as readonly ProjectStatusAction[]).includes(action)
}

/** 穷尽 switch 辅助：处理完所有分支后返回,避免静默吞掉新状态 */
export function assertNever(value: never): never {
  throw new Error(`未处理的状态分支: ${String(value)}`)
}

/** 状态 → 稳定 CSS class(避免业务中文值直接参与动态 class) */
export function statusClass(status: ProjectStatus): string {
  return `status-${PROJECT_STATUS_META[status].tone}`
}

/** Legacy 状态值“已回传”只表示平台内审核完成，界面不把它表述为 CRM 已送达。 */
export function statusLabel(status: ProjectStatus): string {
  return PROJECT_STATUS_META[status].label
}

const CRM_DELIVERY_LABELS: Record<CrmDeliveryStatus, string> = {
  pending: 'CRM 待交付',
  sending: 'CRM 交付中',
  delivered: 'CRM 已送达',
  failed: 'CRM 交付失败，等待重试',
  dead: 'CRM 交付已停止，需人工处理',
}

export function crmDeliveryStatusLabel(status: CrmDeliveryStatus): string {
  return CRM_DELIVERY_LABELS[status]
}
