import type {
  AiLawResearchReportV1,
  AiLawResearchSectionV1,
  AiLawResearchSourceV1,
} from '../types'

export type PaginationItem =
  | { type: 'page'; page: number; key: string }
  | { type: 'ellipsis'; key: string }

export function buildPagination(currentPage: number, totalPages: number): PaginationItem[] {
  const total = Math.max(0, Math.floor(totalPages))
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => ({
      type: 'page' as const,
      page: index + 1,
      key: `page-${index + 1}`,
    }))
  }

  const current = Math.min(total, Math.max(1, Math.floor(currentPage)))
  const pages = new Set([1, total, current - 1, current, current + 1])
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b)
  const items: PaginationItem[] = []
  let previous = 0
  for (const page of sorted) {
    if (page - previous > 1) items.push({ type: 'ellipsis', key: `ellipsis-${previous}-${page}` })
    items.push({ type: 'page', page, key: `page-${page}` })
    previous = page
  }
  return items
}

export type AiLawReportDraftEvent =
  | { type: 'report_start'; report: Omit<AiLawResearchReportV1, 'summary' | 'sections' | 'sources' | 'limitations'> }
  | { type: 'report_summary'; summary: string }
  | { type: 'report_section'; section: AiLawResearchSectionV1 }
  | { type: 'report_source'; source: AiLawResearchSourceV1 }
  | { type: 'report_limitations'; limitations: string[] }
  | { type: 'report_completed' }

export type AiLawReportDraftTransition = {
  draft: AiLawResearchReportV1 | null
  completed?: AiLawResearchReportV1
  invalidCompletion?: boolean
}

/**
 * 报告分段事件只组装临时草稿；只有 report_completed 能将它提交为可追问报告。
 * 断流时丢弃 draft 即可，不会覆盖上一份已完成报告。
 */
export function advanceAiLawReportDraft(
  draft: AiLawResearchReportV1 | null,
  event: AiLawReportDraftEvent,
): AiLawReportDraftTransition {
  if (event.type === 'report_start') {
    return {
      draft: { ...event.report, summary: '', sections: [], sources: [], limitations: [] },
    }
  }
  if (event.type === 'report_completed') {
    return draft
      ? { draft: null, completed: draft }
      : { draft: null, invalidCompletion: true }
  }
  if (!draft) return { draft: null }
  if (event.type === 'report_summary') {
    return { draft: { ...draft, summary: event.summary } }
  }
  if (event.type === 'report_section') {
    return { draft: { ...draft, sections: [...draft.sections, event.section] } }
  }
  if (event.type === 'report_source') {
    return { draft: { ...draft, sources: [...draft.sources, event.source] } }
  }
  return { draft: { ...draft, limitations: event.limitations } }
}
