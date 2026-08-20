import { Module } from '@nestjs/common';
import { LegalResearchController } from './legal-research.controller';
import { LegalResearchService } from './legal-research.service';

@Module({
  controllers: [LegalResearchController],
  providers: [LegalResearchService],
})
export class LegalResearchModule {}
