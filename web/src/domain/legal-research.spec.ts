import { describe, expect, it } from 'vitest'
import { advanceAiLawReportDraft, buildPagination } from './legal-research'
import type { AiLawResearchReportV1 } from '../types'

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

describe('AI 搜法报告流草稿', () => {
  const reportMeta = {
    schemaVersion: 1,
    resultStatus: 'complete',
    query: '经济补偿如何计算',
    title: '经济补偿检索报告',
    scope: '劳动合同法',
    understanding: {
      queryType: 'legal_issue',
      analysis: '需要检索计算规则。',
      retrievalPlan: '检索并读取正文。',
      knownFacts: [],
      legalIssues: ['经济补偿'],
      factChanges: { added: [], corrected: [], removed: [] },
    },
    generatedAt: '2026-08-31T00:00:00.000Z',
    metrics: { candidateCount: 1, verifiedSourceCount: 1, citedSourceCount: 0 },
  } satisfies Omit<AiLawResearchReportV1, 'summary' | 'sections' | 'sources' | 'limitations'>

  it('收到分段事件时只更新草稿，report_completed 后才提交', () => {
    let transition = advanceAiLawReportDraft(null, { type: 'report_start', report: reportMeta })
    expect(transition.completed).toBeUndefined()
    transition = advanceAiLawReportDraft(transition.draft, { type: 'report_summary', summary: '已核验计算规则。' })
    expect(transition.completed).toBeUndefined()

    transition = advanceAiLawReportDraft(transition.draft, { type: 'report_completed' })
    expect(transition.draft).toBeNull()
    expect(transition.completed?.summary).toBe('已核验计算规则。')
  })

  it('没有完整草稿时不接受完成事件', () => {
    expect(advanceAiLawReportDraft(null, { type: 'report_completed' }))
      .toEqual({ draft: null, invalidCompletion: true })
  })
})
