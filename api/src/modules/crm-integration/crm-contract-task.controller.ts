import { Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CrmA1AuthService } from './crm-a1-auth.service';
import { CrmMultipartService } from './crm-multipart.service';
import { CreateCrmContractTaskUseCase } from './create-crm-contract-task.use-case';
import { parseCrmContractTaskPayload } from './dto/crm-contract-task.dto';

type RequestWithId = Request & { requestId?: string };

@Controller('crm/v1/contract-tasks')
export class CrmContractTaskController {
  constructor(
    @Inject(CrmA1AuthService) private readonly auth: CrmA1AuthService,
    @Inject(CrmMultipartService) private readonly multipart: CrmMultipartService,
    @Inject(CreateCrmContractTaskUseCase) private readonly createTask: CreateCrmContractTaskUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Public()
  async create(@Req() request: RequestWithId) {
    const headers = this.auth.validatePrelude(request);
    this.auth.verifySignature(headers);
    await this.auth.claimNonce(headers);
    const envelope = await this.multipart.parse(request);
    try {
      this.auth.verifyContentDigests(headers, envelope);
      const payload = await parseCrmContractTaskPayload(envelope.payloadText);
      return await this.createTask.execute({
        headers,
        payload,
        envelope,
        request: {
          requestId: request.requestId,
          ip: request.socket.remoteAddress,
          userAgent: typeof request.headers['user-agent'] === 'string'
            ? request.headers['user-agent']
            : undefined,
        },
      });
    } finally {
      this.multipart.cleanup(envelope);
    }
  }
}
