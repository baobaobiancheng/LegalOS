import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../domain/project-access.types';

/**
 * P2-01 认领用例：未分配工单认领。
 * 权限(P1-01) + 原子条件更新(仅 legalBpId=null 可认领) + 事件。
 */
@Injectable()
export class ClaimProjectUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: ProjectAccessPolicy,
  ) {}

  async execute(id: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Claim, project);

    const res = await this.prisma.project.updateMany({
      where: { id, legalBpId: null },
      data: { legalBpId: actor.id, ownerId: actor.id },
    });
    if (res.count === 0) {
      const fresh = await this.prisma.project.findUnique({ where: { id }, select: { legalBpId: true } });
      if (!fresh) throw new NotFoundException('工单不存在');
      throw new ConflictException('该工单已被认领或已指派');
    }

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    await this.prisma.projectEvent.create({
      data: { projectId: id, text: `${hh}:${mm} · 工单已认领` },
    });

    return this.prisma.project.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, username: true, displayName: true, role: true } },
        owner: { select: { id: true, username: true, displayName: true, role: true } },
        legalBp: { select: { id: true, username: true, displayName: true, role: true } },
      },
    });
  }
}
