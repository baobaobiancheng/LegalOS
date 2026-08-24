import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SearchLawsDto } from '../src/modules/legal-research/dto/legal-research.dto';

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
