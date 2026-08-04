import { Module } from '@nestjs/common';
import { ContractController } from './contract.controller';
import { ContractService } from './contract.service';
import { ContractTemplateService } from './contract-template.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CodexService } from '../../common/services/codex.service';
import { MockDingTalkAdapter } from '../project/adapters/mock-dingtalk.adapter';
import { DINGTALK_ADAPTER } from '../project/adapters/adapter.interfaces';

@Module({
  imports: [PrismaModule],
  controllers: [ContractController],
  providers: [
    ContractService,
    ContractTemplateService,
    CodexService,
    { provide: DINGTALK_ADAPTER, useClass: MockDingTalkAdapter },
  ],
})
export class ContractModule {}
