import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { SearchCasesDto, SearchLawsDto } from './dto/legal-research.dto';
import { LegalResearchService } from './legal-research.service';

@Controller('legal-research')
@Roles(Role.admin, Role.legal_bp, Role.legal_lead)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class LegalResearchController {
  constructor(private readonly research: LegalResearchService) {}

  @Get('laws')
  searchLaws(@Query() dto: SearchLawsDto) {
    return this.research.searchLaws(dto);
  }

  @Get('cases')
  searchCases(@Query() dto: SearchCasesDto) {
    return this.research.searchCases(dto);
  }
}
