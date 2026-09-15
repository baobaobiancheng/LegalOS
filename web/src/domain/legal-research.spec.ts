import { describe, expect, it } from 'vitest'
import { buildPagination } from './legal-research'

describe('buildPagination', () => {
  it('在页数少时展示全部页码', () => {
    expect(buildPagination(2, 4)).toEqual([
      { type: 'page', page: 1, key: 'page-1' },
      { type: 'page', page: 2, key: 'page-2' },
      { type: 'page', page: 3, key: 'page-3' },
      { type: 'page', page: 4, key: 'page-4' },
    ])
  })

  it('大结果集只展示首尾和当前窗口', () => {
    expect(buildPagination(8, 20).map((item) => item.type === 'page' ? item.page : '…'))
      .toEqual([1, '…', 7, 8, 9, '…', 20])
  })
})
