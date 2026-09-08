/**
 * 日志用错误标识：只保留类型和机器错误码，不保留 message/stack，
 * 避免把数据库正文、请求参数或凭证带入日志。
 */
export function safeErrorTag(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UnknownError';
  const value = error as { name?: unknown; code?: unknown };
  const name = safeToken(value.name ?? 'Error');
  return value.code === undefined ? name : `${name} code=${safeToken(value.code)}`;
}

function safeToken(value: unknown): string {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || '-';
}
