import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuditActor, AuditRequestContext } from '../../common/audit/audit.types';
import { LEGAL_RESPONSIBILITIES } from './legal-responsibility.catalog';

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
        const issue = !userReady ? '需唯一、启用、绑定钉钉的 CAS 普通法务账号，且姓名一致'
          : department?.name !== scope.name ? '请同步钉钉通讯录并核对部门 ID/名称' : null;
        const active = rules.some(rule => rule.id === id && rule.isActive && rule.userId === user?.id && rule.departmentId === scope.id);
        return { ...scope, ruleId: id, userId: user?.id ?? null, issue, state: issue ? 'blocked' : active ? 'active' : 'ready' };
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
