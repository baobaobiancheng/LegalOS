import { Module } from '@nestjs/common';
import { ContractController } from './contract.controller';
import { ContractService } from './contract.service';
import { ContractFileService } from './contract-file.service';
import { ContractTemplateService } from './contract-template.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MockDingTalkAdapter } from '../project/adapters/mock-dingtalk.adapter';
import { DINGTALK_ADAPTER } from '../project/adapters/adapter.interfaces';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { CreateProjectUseCase } from '../project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../project/application/escalate-project-to-legal.use-case';
import { ContractDocumentWriter } from './application/contract-document.writer';
import { ContractFileProcessor } from './application/contract-file.processor';

@Module({
  imports: [PrismaModule],
  controllers: [ContractController],
  providers: [
    ContractService,
    ContractFileService,
    ContractDocumentWriter,
    ContractFileProcessor,
    ContractTemplateService,
    ProjectAccessPolicy,
    CreateProjectUseCase,
    EscalateProjectToLegalUseCase,
    { provide: DINGTALK_ADAPTER, useClass: MockDingTalkAdapter },
  ],
  exports: [ContractFileProcessor],
})
export class ContractModule {}
