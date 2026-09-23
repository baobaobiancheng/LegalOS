import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, ParseUUIDPipe } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';

@Injectable()
export class ProjectFileAccessGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectAccessPolicy) private readonly policy: ProjectAccessPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request<{ id: string }> & { user: ProjectActor }>();
    // 参数 Pipe 在拦截器之后运行；必须在 Guard 中校验，才能阻止 Multer 落盘。
    const id = await new ParseUUIDPipe().transform(request.params.id, { type: 'param', data: 'id' });
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.policy.assertCan(request.user, ProjectAction.ManageFile, project);
    return true;
  }
}
