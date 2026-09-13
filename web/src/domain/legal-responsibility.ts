export type ScopeIssueCode = 'ACCOUNT_NOT_READY' | 'DEPARTMENT_NOT_SYNCED' | 'DEPARTMENT_MISMATCH'
export type ScopeState = 'blocked' | 'ready' | 'active'

export type ResponsibilityScope = {
  id: string
  name: string
  issue: string | null
  issueCode: ScopeIssueCode | null
  state: ScopeState
}

export type LegalResponsibility = {
  key: string
  name: string
  businessLines: string[]
  description: string
  pendingScopes: string[]
  scopes: ResponsibilityScope[]
}

export const scopeStateLabels: Record<ScopeState, string> = {
  active: '已启用', ready: '待应用', blocked: '待关联系统',
}
const issueLabels: Record<ScopeIssueCode, string> = {
  ACCOUNT_NOT_READY: '待关联账号',
  DEPARTMENT_NOT_SYNCED: '待同步组织',
  DEPARTMENT_MISMATCH: '待核验部门',
}

export function scopeStatusLabel(scope: ResponsibilityScope): string {
  return scope.state === 'blocked' && scope.issueCode
    ? issueLabels[scope.issueCode] : scopeStateLabels[scope.state]
}
