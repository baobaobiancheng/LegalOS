import { Module } from '@nestjs/common';
import { LegalResearchController } from './legal-research.controller';
import { LegalResearchService } from './legal-research.service';
import { AiLegalResearchSessionService } from './ai-legal-research-session.service';

@Module({
  controllers: [LegalResearchController],
  providers: [LegalResearchService, AiLegalResearchSessionService],
})
export class LegalResearchModule {}
