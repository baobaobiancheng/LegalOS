import { ref, readonly } from 'vue'
import { RequestError } from '../api/client'
import type { ApiError } from '../types'

/**
 * P2-03 统一异步数据状态：idle → loading → success(data) | error(error, requestId, retry)。
 * 列表/详情主数据加载使用;失败与"空数据"严格区分,不伪装成空态。
 */
export function useRemoteData<T>(fetcher: () => Promise<T>) {
  const status = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const data = ref<T | null>(null)
  const error = ref<RequestError | null>(null)
  const requestId = ref<string | undefined>(undefined)

  const load = async () => {
    status.value = 'loading'
    error.value = null
    requestId.value = undefined
    try {
      data.value = await fetcher()
      status.value = 'success'
    } catch (e) {
      const err =
        e instanceof RequestError
          ? e
          : new RequestError({ error: '加载失败,请重试', code: 'UNKNOWN', statusCode: 0 } satisfies ApiError)
      error.value = err
      requestId.value = err.payload.requestId
      status.value = 'error'
    }
  }

  return {
    status: readonly(status),
    data: readonly(data),
    error: readonly(error),
    requestId: readonly(requestId),
    load,
  }
}
