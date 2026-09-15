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
