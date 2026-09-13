import type { EventDto, MessageDto, ProjectDetail } from '../types'

export type ProjectTimelineItem = MessageDto | (EventDto & { _event: true })

/** 新旧分页按消息/事件身份去重，保留当前窗口已有的更新。 */
export function prependProjectHistory(current: ProjectTimelineItem[], page: ProjectDetail): ProjectTimelineItem[] {
  const older: ProjectTimelineItem[] = [...page.messages, ...page.events.map(event => ({ ...event, _event: true as const }))]
  const items = new Map<string, ProjectTimelineItem>()
  for (const [index, item] of [...older, ...current].entries()) {
    const key = item.id ? `${'_event' in item ? 'event' : 'message'}:${item.id}` : `local:${index}`
    items.set(key, item)
  }
  return [...items.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}
