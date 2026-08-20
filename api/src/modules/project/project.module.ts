import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { OutboxAdminController } from './outbox-admin.controller';
import { ConsultationAttachmentsController } from './consultation-attachments.controller';
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
import { ProjectStateMachine } from './domain/project-state-machine';
import { ClaimProjectUseCase } from './application/claim-project.use-case';
import { EscalateProjectToLegalUseCase } from './application/escalate-project-to-legal.use-case';
import { ConsultationContextBuilder } from './application/consultation-context-builder';
import { ConsultationReplyOrchestrator } from './application/consultation-reply.orchestrator';

@Module({
  imports: [PrismaModule, DingTalkAdapterModule],
  controllers: [ProjectController, OutboxAdminController, ConsultationAttachmentsController],
  providers: [
    ProjectService,
    LLMRiskService,
    ProjectAccessPolicy,
    CreateProjectUseCase,
    OutboxRepository,
    OutboxWorker,
    ProjectQueryService,
    ProjectStateMachine,
    ClaimProjectUseCase,
    EscalateProjectToLegalUseCase,
    ConsultationContextBuilder,
    ConsultationReplyOrchestrator,
    { provide: CRM_ADAPTER, useClass: MockCrmAdapter },
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
