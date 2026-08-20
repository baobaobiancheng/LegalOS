/**
 * 项目时间线事件的统一时间前缀。
 * ProjectEvent.createdAt 是权威时间；text 内只保留面向用户的紧凑 HH:mm。
 */
export function formatEventTime(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
