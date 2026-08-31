import { Module } from '@nestjs/common';
import { ContractModule } from '../contract/contract.module';
import { CrmA1AuthService } from './crm-a1-auth.service';
import { CrmContractTaskController } from './crm-contract-task.controller';
import { CrmMultipartService } from './crm-multipart.service';
import { CreateCrmContractTaskUseCase } from './create-crm-contract-task.use-case';

@Module({
  imports: [ContractModule],
  controllers: [CrmContractTaskController],
  providers: [CrmA1AuthService, CrmMultipartService, CreateCrmContractTaskUseCase],
})
export class CrmIntegrationModule {}
