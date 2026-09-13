import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuditActor, AuditRequestContext } from '../../common/audit/audit.types';
import { LEGAL_RESPONSIBILITIES } from './legal-responsibility.catalog';

const SCOPE_ISSUES = {
  ACCOUNT_NOT_READY: '职责范围已记录。请在系统用户中核验该法务的 CAS 账号、姓名、启用状态、普通法务角色及钉钉绑定。',
  DEPARTMENT_NOT_SYNCED: '职责范围已记录。系统尚无该部门的有效组织记录，请同步钉钉通讯录，无需重复填写职责。',
  DEPARTMENT_MISMATCH: '职责范围已记录。已同步部门的名称与配置不一致，请核对组织变更，不会按相似名称自动扩大范围。',
} as const;

@Injectable()
export class LegalResponsibilityService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async preview(db: Pick<Prisma.TransactionClient, 'user' | 'dingTalkDepartment' | 'legalAssignmentRule'> = this.prisma) {
    const [users, departments, rules] = await Promise.all([
      db.user.findMany({
        where: { OR: [
          { casUsername: { in: LEGAL_RESPONSIBILITIES.flatMap(person => person.casUsername ? [person.casUsername] : []) } },
          { displayName: { in: LEGAL_RESPONSIBILITIES.filter(person => !person.casUsername).map(person => person.name) } },
        ] },
        select: { id: true, casUsername: true, displayName: true, role: true, isActive: true, dingtalkUserId: true },
      }),
      db.dingTalkDepartment.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      db.legalAssignmentRule.findMany({ select: { id: true, userId: true, departmentId: true, isActive: true } }),
    ]);
    return LEGAL_RESPONSIBILITIES.map(person => {
      const matches = users.filter(candidate => person.casUsername
        ? candidate.casUsername === person.casUsername : candidate.displayName === person.name);
      const user = matches.length === 1 ? matches[0] : undefined;
      const userReady = user?.isActive && user.role === 'legal_bp' && user.displayName === person.name
        && user.casUsername && user.dingtalkUserId;
      return { ...person, scopes: person.scopes.map(scope => {
        const id = `${person.key}:${scope.id}`;
        const department = departments.find(department => department.id === scope.id);
        const issueCode = !userReady ? 'ACCOUNT_NOT_READY'
          : !department ? 'DEPARTMENT_NOT_SYNCED'
            : department.name !== scope.name ? 'DEPARTMENT_MISMATCH' : null;
        const issue = issueCode ? SCOPE_ISSUES[issueCode] : null;
        const active = rules.some(rule => rule.id === id && rule.isActive && rule.userId === user?.id && rule.departmentId === scope.id);
        return { ...scope, ruleId: id, userId: user?.id ?? null, issueCode, issue, state: issue ? 'blocked' : active ? 'active' : 'ready' };
      }) };
    });
  }

  /** 仅应用已核验的部分清单，不删除未列入的其他规则，也不创建账号或调整角色。 */
  async apply(actor: AuditActor, request?: AuditRequestContext) {
    return this.prisma.$transaction(async tx => {
      const preview = await this.preview(tx);
      const applied: string[] = [];
      for (const person of preview) {
        for (const scope of person.scopes) {
          if (scope.issue || !scope.userId) {
            await tx.legalAssignmentRule.updateMany({ where: { id: scope.ruleId }, data: { isActive: false } });
            continue;
          }
          const data = {
            name: `${person.name} · ${scope.name}`, description: person.description,
            departmentId: scope.id, userId: scope.userId, includeDescendants: true, isActive: true,
          };
          await tx.legalAssignmentRule.upsert({ where: { id: scope.ruleId }, create: { id: scope.ruleId, ...data }, update: data });
          applied.push(scope.ruleId);
        }
      }
      await this.audit.record({
        actor, action: 'member.assignment_rules.apply', resourceType: 'legal_assignment_rule',
        source: 'web', outcome: 'success', request, metadata: { appliedRuleIds: applied }, retentionClass: 'admin',
      }, tx);
      return { applied: applied.length, blocked: preview.flatMap(person => person.scopes).filter(scope => scope.issue).length };
    });
  }
}
