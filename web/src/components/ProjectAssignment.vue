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
    <span>当前法务：{{ assigneeName || '待领导分配' }}</span>
    <form @submit.prevent="assign">
      <label for="legal-assignee">分配给</label>
      <select
        id="legal-assignee"
        v-model="selectedId"
        :disabled="candidates.status.value === 'loading' || transfer.status.value === 'loading'"
      >
        <option value="">
          请选择法务
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
.assignment { padding: 14px 18px; border: 1px solid var(--line, #dbe2ec); border-radius: 12px; background: var(--surface, #fff); }
.assignment form { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.assignment select, .assignment button { min-height: 36px; padding: 6px 12px; border: 1px solid var(--line, #dbe2ec); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.assignment button { cursor: pointer; }
.assignment button:disabled { opacity: .5; cursor: default; }
.assignment p { margin: 8px 0 0; font-size: 13px; }
</style>
