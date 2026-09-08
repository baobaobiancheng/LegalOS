import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { publicStreamError } from '../src/modules/legal-research/legal-research.controller';

describe('AI 搜法公开错误契约', () => {
  it('未知 Error 不向 SSE 泄露内部 message', () => {
    const error = publicStreamError(new Error('Prisma DATABASE_URL password=secret'));
    expect(error).toEqual({
      code: 'AI_RESEARCH_FAILED',
      message: 'AI 搜法失败，请稍后重试',
      retryable: true,
    });
  });

  it('只保留有限白名单业务错误契约', () => {
    const allowed = publicStreamError(new BadRequestException({
      code: 'AI_RESEARCH_CONTEXT_CONFLICT',
      error: '检索上下文已变化，请刷新后重试',
      retryable: false,
    }));
    expect(allowed).toMatchObject({ code: 'AI_RESEARCH_CONTEXT_CONFLICT', retryable: false });

    const denied = publicStreamError(new BadRequestException({
      code: 'PRISMA_FAILURE',
      error: 'password=secret',
    }));
    expect(denied.message).toBe('AI 搜法失败，请稍后重试');
  });
});
