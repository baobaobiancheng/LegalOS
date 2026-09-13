<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { request } from '../api/client'
import { useRemoteData } from '../composables/useRemoteData'
import ErrorState from './ErrorState.vue'

const props = defineProps<{ projectId: string; assigneeName?: string }>()
const emit = defineEmits<{ assigned: [] }>()
type Assignee = { id: string; displayName: string; role: 'legal_bp' | 'legal_lead' }
const candidates = useRemoteData(() => request<Assignee[]>('/projects/assignees'))
const selectedId = ref('')
const transfer = useRemoteData(() => request(`/projects/${props.projectId}/transfer`, {
  method: 'POST', body: { legalBpId: selectedId.value },
}))

async function assign() {
  if (!selectedId.value || transfer.status.value === 'loading') return
  await transfer.load()
  if (transfer.status.value === 'success') {
    selectedId.value = ''
    emit('assigned')
  }
}

onMounted(() => candidates.load())
</script>

<template>
  <section
    class="assignment"
    aria-label="法务领导分配工单"
  >
    <div class="assignment-summary">
      <strong>工单分配</strong>
      <span>当前法务 <b>{{ assigneeName || '待领导分配' }}</b></span>
    </div>
    <form @submit.prevent="assign">
      <label for="legal-assignee">分配给</label>
      <select
        id="legal-assignee"
        v-model="selectedId"
        :disabled="candidates.status.value === 'loading' || transfer.status.value === 'loading'"
      >
        <option value="">
          {{ candidates.status.value === 'loading' ? '正在加载法务…' : '请选择法务' }}
        </option>
        <option
          v-for="candidate in candidates.data.value"
          :key="candidate.id"
          :value="candidate.id"
        >
          {{ candidate.displayName }}{{ candidate.role === 'legal_lead' ? '（法务领导）' : '' }}
        </option>
      </select>
      <button
        type="submit"
        :disabled="!selectedId || transfer.status.value === 'loading'"
      >
        {{ transfer.status.value === 'loading' ? '分配中…' : '确认分配' }}
      </button>
    </form>
    <p v-if="candidates.status.value === 'success' && candidates.data.value?.length === 0">
      暂无启用的法务账号，请联系管理员。
    </p>
    <p
      v-if="transfer.status.value === 'success'"
      role="status"
    >
      分配已保存
    </p>
    <ErrorState
      v-if="candidates.error.value"
      :message="candidates.error.value.payload.error"
      :request-id="candidates.requestId.value"
      :on-retry="candidates.load"
    />
    <ErrorState
      v-if="transfer.error.value"
      :message="transfer.error.value.payload.error"
      :request-id="transfer.requestId.value"
    />
  </section>
</template>

<style scoped>
.assignment { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 18px 24px; border-bottom: 1px solid #e5e7eb; background: #fff; font-size: 13px; }
.assignment-summary { display: grid; gap: 6px; }
.assignment-summary strong { font-size: 14px; color: #111827; }
.assignment-summary span { color: #6b7280; }
.assignment-summary b { margin-left: 8px; color: #374151; font-weight: 500; }
.assignment form { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.assignment label { color: #6b7280; }
.assignment select, .assignment button { min-height: 38px; padding: 7px 12px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; color: #374151; font: inherit; }
.assignment select { min-width: 160px; }
.assignment button { border-color: #2563eb; background: #2563eb; color: #fff; cursor: pointer; }
.assignment button:hover:not(:disabled) { background: #1d4ed8; }
.assignment button:disabled { border-color: #e5e7eb; background: #f3f4f6; color: #9ca3af; cursor: not-allowed; }
.assignment :is(select, button):focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.assignment p { flex-basis: 100%; margin: 0; font-size: 13px; color: #6b7280; }
.assignment p[role="status"] { color: #15803d; }
@media (max-width: 600px) { .assignment { padding: 16px; } .assignment form { width: 100%; } .assignment select { flex: 1; min-width: 0; } }
</style>
