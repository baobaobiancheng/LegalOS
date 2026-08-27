import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { auditRequestContext } from '../../common/audit/audit-request';
import {
  AiLawReportDownloadDto,
  AiLawResearchDto,
  LawDetailParamsDto,
  LawDetailQueryDto,
  SearchCasesDto,
  SearchLawsDto,
} from './dto/legal-research.dto';
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

  @Get('laws/:lawId')
  getLawDetail(@Param() params: LawDetailParamsDto, @Query() query: LawDetailQueryDto) {
    return this.research.getLawDetail(params.lawId, query.refresh);
  }

  @Get('cases')
  searchCases(@Query() dto: SearchCasesDto) {
    return this.research.searchCases(dto);
  }

  @Post('ai')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  aiSearch(
    @Body() dto: AiLawResearchDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    const abort = new AbortController();
    const onAborted = () => abort.abort();
    request.once('aborted', onAborted);
    return this.research.aiSearch(
      dto,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
      abort.signal,
    ).finally(() => request.off('aborted', onAborted));
  }

  @Post('ai/downloads')
  @HttpCode(204)
  recordAiReportDownload(
    @Body() dto: AiLawReportDownloadDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
  ) {
    return this.research.recordAiReportDownload(
      dto,
      { id: actorId, role: actorRole },
      auditRequestContext(request),
    );
  }
}
