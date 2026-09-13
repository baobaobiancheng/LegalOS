import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../domain/project-access.types';
import { queueAssignmentNotification } from './assignment-notification';
import { formatEventTime } from '../../../common/utils/event-time';

/**
 * 领导认领与通知原子提交，避免成功指派却没有通知任务。
 */
@Injectable()
export class ClaimProjectUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: ProjectAccessPolicy,
  ) {}

  async execute(id: string, actor: ProjectActor) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id } });
      if (!project) throw new NotFoundException('工单不存在');
      this.accessPolicy.assertCan(actor, ProjectAction.Claim, project);

      const res = await tx.project.updateMany({
        where: { id, legalBpId: null, route: 'legalbp', status: { notIn: ['已取消', '已回传'] } },
        data: { legalBpId: actor.id, ownerId: actor.id },
      });
      if (res.count === 0) {
        throw new ConflictException('该工单已被认领、已指派或不再需要人工处理');
      }

      await tx.projectEvent.create({
        data: { projectId: id, text: `${formatEventTime()} · 工单已认领` },
      });
      await queueAssignmentNotification(tx, project, actor.id, null);

      return tx.project.findUniqueOrThrow({
        where: { id },
        include: {
          creator: { select: { id: true, username: true, displayName: true, role: true } },
          owner: { select: { id: true, username: true, displayName: true, role: true } },
          legalBp: { select: { id: true, username: true, displayName: true, role: true } },
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
