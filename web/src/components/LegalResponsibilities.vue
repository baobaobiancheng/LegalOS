<script setup lang="ts">
import { onMounted } from 'vue'
import { request } from '../api/client'
import { useRemoteData } from '../composables/useRemoteData'
import ErrorState from './ErrorState.vue'

type Responsibility = {
  key: string; name: string; businessLines: string[]; description: string; pendingScopes: string[];
  scopes: { id: string; name: string; issue: string | null; state: 'blocked' | 'ready' | 'active' }[];
}
const catalog = useRemoteData(() => request<Responsibility[]>('/admin/members/bp-responsibilities'))
const apply = useRemoteData(() => request<{ applied: number; blocked: number }>('/admin/members/bp-responsibilities/apply', { method: 'POST' }))
async function applyCatalog() {
  await apply.load()
  if (apply.status.value === 'success') await catalog.load()
}
onMounted(() => catalog.load())
</script>

<template>
  <section
    class="responsibilities"
    aria-label="业务职责分配规则"
  >
    <h2>按业务职责自动分配</h2>
    <p>以申请人的钉钉部门及其上级范围匹配；无候选或范围冲突交法务领导。以下是部分清单，不替代其他职责。</p>
    <p>先同步钉钉通讯录，再核对下表并应用。只启用校验通过的范围，不创建账号、不调整角色、不重派历史工单。</p>
    <button
      type="button"
      :disabled="catalog.status.value !== 'success' || apply.status.value === 'loading'"
      @click="applyCatalog"
    >
      {{ apply.status.value === 'loading' ? '正在应用…' : '确认应用已核验职责' }}
    </button>
    <p
      v-if="apply.status.value === 'success'"
      role="status"
    >
      已应用 {{ apply.data.value?.applied }} 条，{{ apply.data.value?.blocked }} 条需完善身份或组织信息。
    </p>
    <ErrorState
      v-if="catalog.error.value"
      :message="catalog.error.value.payload.error"
      :on-retry="catalog.load"
    />
    <ErrorState
      v-if="apply.error.value"
      :message="apply.error.value.payload.error"
      :request-id="apply.requestId.value"
    />
    <article
      v-for="person in catalog.data.value"
      :key="person.key"
    >
      <h3>{{ person.name }} <small>{{ person.businessLines.join(' / ') }}</small></h3>
      <p>{{ person.description }}</p>
      <ul>
        <li
          v-for="scope in person.scopes"
          :key="scope.id"
        >
          {{ scope.name }}（含下级部门）— {{ { active: '已启用', ready: '待应用', blocked: '未启用' }[scope.state] }}
          <span v-if="scope.issue">：{{ scope.issue }}</span>
        </li>
        <li
          v-for="scope in person.pendingScopes"
          :key="scope"
        >
          待确认，未启用：{{ scope }}
        </li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.responsibilities { margin: 20px 0; line-height: 1.7; }
.responsibilities article { margin: 16px 0; padding: 16px; border: 1px solid var(--line, #dbe2ec); border-radius: 10px; }
.responsibilities h2, .responsibilities h3 { margin: 0; }
.responsibilities small { display: block; font-size: 13px; font-weight: normal; }
.responsibilities p { margin: 8px 0; }
.responsibilities button { min-height: 36px; padding: 6px 14px; border: 1px solid var(--line, #dbe2ec); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.responsibilities button:disabled { opacity: .5; cursor: default; }
</style>
