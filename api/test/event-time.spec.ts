import { describe, expect, it } from 'vitest';
import { formatEventTime } from '../src/common/utils/event-time';

describe('formatEventTime', () => {
  it('为项目时间线输出稳定的 HH:mm', () => {
    expect(formatEventTime(new Date(2026, 7, 20, 3, 7, 59))).toBe('03:07');
    expect(formatEventTime(new Date(2026, 7, 20, 23, 59, 0))).toBe('23:59');
  });
});
