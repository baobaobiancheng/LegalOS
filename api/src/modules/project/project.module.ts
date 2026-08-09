import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { OutboxAdminController } from './outbox-admin.controller';
import { ProjectService } from './project.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { LLMRiskService } from '../../common/services/llm-risk.service';
import { MockCrmAdapter } from './adapters/mock-crm.adapter';
import { DingTalkAdapterModule } from './adapters/dingtalk-adapter.module';
import { CRM_ADAPTER } from './adapters/adapter.interfaces';
import { ProjectAccessPolicy } from './domain/project-access.policy';
import { CreateProjectUseCase } from './application/create-project.use-case';
import { OutboxRepository } from './infrastructure/outbox.repository';
import { OutboxWorker } from './infrastructure/outbox.worker';
import { ProjectQueryService } from './queries/project-query.service';

@Module({
  imports: [PrismaModule, DingTalkAdapterModule],
  controllers: [ProjectController, OutboxAdminController],
  providers: [
    ProjectService,
    LLMRiskService,
    ProjectAccessPolicy,
    CreateProjectUseCase,
    OutboxRepository,
    OutboxWorker,
    ProjectQueryService,
    { provide: CRM_ADAPTER, useClass: MockCrmAdapter },
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
