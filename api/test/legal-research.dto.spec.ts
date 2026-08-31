import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AiLawResearchDto, SearchLawsDto } from '../src/modules/legal-research/dto/legal-research.dto';

describe('legal research refresh DTO', () => {
  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
  ])('解析 refresh=%s', async (input, expected) => {
    const dto = plainToInstance(SearchLawsDto, { keyword: '劳动合同', refresh: input });
    expect(await validate(dto)).toEqual([]);
    expect(dto.refresh).toBe(expected);
  });

  it('拒绝未定义的 refresh 值，不静默转成 false', async () => {
    const dto = plainToInstance(SearchLawsDto, { keyword: '劳动合同', refresh: 'force' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'refresh')).toBe(true);
  });
});

describe('AI legal research messageId DTO', () => {
  it('accepts a bounded opaque idempotency key without UUID semantics', async () => {
    const dto = plainToInstance(AiLawResearchDto, {
      query: '离婚财产如何分割？',
      messageId: '1725089400000-a1b2c3d4e5f6',
    });

    expect(await validate(dto)).toEqual([]);
  });

  it.each([
    'too-short',
    '1725089400000 unsafe value',
    '1725089400000/<script>',
  ])('rejects an unsafe or undersized messageId: %s', async (messageId) => {
    const dto = plainToInstance(AiLawResearchDto, {
      query: '离婚财产如何分割？',
      messageId,
    });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'messageId')).toBe(true);
  });
});
