import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Request, Response } from 'express';
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

  /**
   * 独立 AI 搜法的事件流：先推真实检索/核验阶段，证据闸门通过后再按报告结构逐段输出。
   * 原 POST /ai 保留为兼容接口；当前 Web 页面只使用本 SSE 端点。
   */
  @Post('ai/stream')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async aiSearchStream(
    @Body() dto: AiLawResearchDto,
    @CurrentUser('id') actorId: string,
    @CurrentUser('role') actorRole: Role,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const abort = new AbortController();
    let ended = false;
    let seq = 0;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const write = (event: Record<string, unknown>) => {
      if (ended || response.destroyed || response.writableEnded) return;
      response.write(`data: ${JSON.stringify({ ...event, seq: ++seq })}\n\n`);
      (response as Response & { flush?: () => void }).flush?.();
    };
    const heartbeat = setInterval(() => {
      if (!ended && !response.destroyed && !response.writableEnded) response.write(': ping\n\n');
    }, 20_000);
    heartbeat.unref?.();
    const cancel = () => {
      if (!ended) abort.abort(new Error('AI 搜法连接已断开'));
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      await this.research.streamAiSearch(
        dto,
        { id: actorId, role: actorRole },
        auditRequestContext(request),
        abort.signal,
        write,
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        const failure = publicStreamError(error);
        write({ type: 'error', runId: '', code: failure.code, message: failure.message, retryable: failure.retryable });
      }
    } finally {
      ended = true;
      clearInterval(heartbeat);
      request.off('aborted', cancel);
      response.off('close', cancel);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }

  @Get('ai/conversations/:conversationId')
  getAiConversation(
    @Param('conversationId') conversationId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.research.getAiConversation(conversationId, actorId);
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

export function publicStreamError(error: unknown): { code: string; message: string; retryable: boolean } {
  const response = error && typeof error === 'object' && 'getResponse' in error
    ? (error as { getResponse: () => unknown }).getResponse()
    : undefined;
  if (response && typeof response === 'object') {
    const value = response as Record<string, unknown>;
    const detail = typeof value.error === 'string'
      ? value.error
      : typeof value.message === 'string' ? value.message : undefined;
    if (detail && typeof value.code === 'string' && PUBLIC_STREAM_ERROR_CODES.has(value.code)) {
      return {
        code: value.code,
        message: detail,
        retryable: typeof value.retryable === 'boolean'
          ? value.retryable
          : value.code !== 'AI_RESEARCH_CONTEXT_CONFLICT',
      };
    }
  }
  return { code: 'AI_RESEARCH_FAILED', message: 'AI 搜法失败，请稍后重试', retryable: true };
}

const PUBLIC_STREAM_ERROR_CODES = new Set([
  'AI_RESEARCH_CONTEXT_CONFLICT',
  'AI_RESEARCH_VALIDATION_FAILED',
  'AI_RESEARCH_UNAVAILABLE',
  'AI_EXECUTION_BUSY',
]);
