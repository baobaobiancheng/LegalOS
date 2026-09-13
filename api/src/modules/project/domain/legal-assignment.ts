import { Prisma } from '@prisma/client';

export interface AssignmentRule {
  id: string;
  departmentId: string;
  includeDescendants: boolean;
  userId: string;
}
export interface AssignmentDepartment { id: string; parentId: string | null }
export interface LegalAssignment {
  legalBpId: string | null;
  reason: 'assigned' | 'no_org' | 'no_rule' | 'ambiguous' | 'no_candidate';
  ruleIds: string[];
}

/** 每个兼职部门沿父链选最近范围；不同部门命中不同团队时交领导，不按遍历顺序猜。 */
export function matchAssignmentRules(
  memberships: string[], departments: AssignmentDepartment[], rules: AssignmentRule[],
): AssignmentRule[] {
  const tree = new Map(departments.map(department => [department.id, department]));
  const matches = new Map<string, AssignmentRule>();
  for (const membership of memberships) {
    let departmentId: string | null = membership;
    const visited = new Set<string>();
    while (departmentId && tree.has(departmentId) && !visited.has(departmentId)) {
      visited.add(departmentId);
      const matched = rules.filter(rule => rule.departmentId === departmentId
        && (departmentId === membership || rule.includeDescendants));
      if (matched.length) {
        for (const rule of matched) matches.set(rule.id, rule);
        break;
      }
      departmentId = tree.get(departmentId)!.parentId;
    }
  }
  return [...matches.values()];
}

/** 必须在写入指派的同一个 ReadCommitted 事务内调用；模型/钉钉网络请求不进入该事务。 */
export async function assignLegalBp(tx: Prisma.TransactionClient, requesterId: string): Promise<LegalAssignment> {
  const requester = await tx.user.findUnique({ where: { id: requesterId }, select: { dingtalkUserId: true } });
  if (!requester?.dingtalkUserId) return { legalBpId: null, reason: 'no_org', ruleIds: [] };
  const contact = await tx.dingTalkContact.findUnique({
    where: { userId: requester.dingtalkUserId }, select: { isActive: true, departmentIds: true },
  });
  if (!contact?.isActive || !Array.isArray(contact.departmentIds) || !contact.departmentIds.length) {
    return { legalBpId: null, reason: 'no_org', ruleIds: [] };
  }
  const departments = await tx.dingTalkDepartment.findMany({
    where: { isActive: true }, select: { id: true, parentId: true },
  });
  const rules = await tx.legalAssignmentRule.findMany({
    where: { isActive: true, department: { isActive: true } },
    select: { id: true, departmentId: true, includeDescendants: true, userId: true },
  });
  const matched = matchAssignmentRules(contact.departmentIds.filter((id): id is string => typeof id === 'string'), departments, rules);
  const ruleIds = matched.map(rule => rule.id).sort();
  if (!matched.length) return { legalBpId: null, reason: 'no_rule', ruleIds };
  const ids = [...new Set(matched.map(rule => rule.userId))];
  if (ids.length !== 1) {
    return { legalBpId: null, reason: 'ambiguous', ruleIds };
  }
  // 锁住唯一目标至工单提交，避免停用/角色调整与自动分配并发产生无效指派。
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
  const eligible = await tx.user.findMany({
    where: { id: { in: ids }, isActive: true, role: 'legal_bp' }, select: { id: true }, orderBy: { id: 'asc' },
  });
  return { legalBpId: eligible[0]?.id ?? null, reason: eligible.length ? 'assigned' : 'no_candidate', ruleIds };
}

export function assignmentEvent(assignment: LegalAssignment): string {
  return assignment.legalBpId
    ? `系统按业务职责自动分配法务（规则：${assignment.ruleIds.join('、')}）`
    : `工单进入法务领导待分配队列（${{
      no_org: '缺少有效钉钉组织信息', no_rule: '未命中职责范围', ambiguous: '职责范围冲突', no_candidate: '无启用的普通法务候选人', assigned: '',
    }[assignment.reason]}）`;
}
