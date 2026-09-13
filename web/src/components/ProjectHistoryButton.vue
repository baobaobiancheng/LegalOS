<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { request } from '../api/client'
import type { ProjectDetail } from '../types'

const props = defineProps<{ projectId: string; cursors?: ProjectDetail['history']; disabled?: boolean }>()
const emit = defineEmits<{ loaded: [page: ProjectDetail] }>()
const loading = ref(false)
const error = ref('')
const hasMore = computed(() => Boolean(props.cursors?.beforeMessageId || props.cursors?.beforeEventId))
let controller: AbortController | null = null
onBeforeUnmount(() => controller?.abort())

async function loadOlder() {
  if (loading.value || !hasMore.value || props.disabled) return
  const id = props.projectId
  const cursors = props.cursors!
  const query = new URLSearchParams()
  if (cursors.beforeMessageId) query.set('beforeMessageId', cursors.beforeMessageId)
  if (cursors.beforeEventId) query.set('beforeEventId', cursors.beforeEventId)
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const page = await request<ProjectDetail>(`/projects/${encodeURIComponent(id)}?${query}`, { signal: controller.signal })
    if (id !== props.projectId || controller.signal.aborted) return
    emit('loaded', {
      ...page,
      messages: cursors.beforeMessageId ? page.messages : [],
      events: cursors.beforeEventId ? page.events : [],
      history: {
        beforeMessageId: cursors.beforeMessageId ? page.history?.beforeMessageId ?? null : null,
        beforeEventId: cursors.beforeEventId ? page.history?.beforeEventId ?? null : null,
      },
    })
  } catch {
    if (!controller.signal.aborted) error.value = '历史记录加载失败，请重试；当前记录已保留。'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div
    v-if="hasMore"
    class="history-control"
  >
    <button
      type="button"
      :disabled="loading || disabled"
      @click="loadOlder"
    >
      {{ loading ? '加载中…' : '加载更早记录' }}
    </button>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.history-control { padding: 12px; text-align: center; }
button { padding: 6px 12px; color: inherit; background: transparent; border: 1px solid #d6dae1; border-radius: 6px; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
p { margin: 8px 0 0; color: #a12c2c; font-size: 13px; }
</style>
