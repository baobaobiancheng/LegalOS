/**
 * P2-03：前端 API 日志适配器。
 * 只记录可排障的元数据，不记录请求体、响应体、Authorization 或 Cookie。
 */
export type ApiLogContext = Record<string, unknown>

const SENSITIVE_KEY = /(authorization|cookie|token|password|secret|api[-_]?key|credential|body|payload)/i

const redact = (value: unknown, key = '', depth = 0): unknown => {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (depth > 2 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 10).map(item => redact(item, '', depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, depth + 1)]),
  )
}

export const redactApiLogContext = (context: ApiLogContext = {}): ApiLogContext => redact(context) as ApiLogContext

export const apiLogger = {
  warn(event: string, context: ApiLogContext = {}) {
    console.warn(`[api] ${event}`, redactApiLogContext(context))
  },
  error(event: string, context: ApiLogContext = {}) {
    console.error(`[api] ${event}`, redactApiLogContext(context))
  },
}
