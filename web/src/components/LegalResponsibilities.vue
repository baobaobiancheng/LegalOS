<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { request } from '../api/client'
import { useRemoteData } from '../composables/useRemoteData'
import ErrorState from './ErrorState.vue'

type Responsibility = {
  key: string; name: string; businessLines: string[]; description: string; pendingScopes: string[];
  scopes: { id: string; name: string; issue: string | null; state: 'blocked' | 'ready' | 'active' }[];
}
const catalog = useRemoteData(() => request<Responsibility[]>('/admin/members/bp-responsibilities'))
const apply = useRemoteData(() => request<{ applied: number; blocked: number }>('/admin/members/bp-responsibilities/apply', { method: 'POST' }))
const keyword = ref('')
const selectedKey = ref('')
const confirming = ref(false)
const people = computed(() => catalog.data.value ?? [])
const filteredPeople = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  return people.value.filter(person => [person.name, ...person.businessLines, ...person.scopes.map(scope => scope.name)]
    .some(value => value.toLocaleLowerCase().includes(query)))
})
const selected = computed(() => filteredPeople.value.find(person => person.key === selectedKey.value) ?? filteredPeople.value[0])
const scopes = computed(() => people.value.flatMap(person => person.scopes))
const stateLabels = { active: '已启用', ready: '待应用', blocked: '待完善' }
const counts = computed(() => ({
  active: scopes.value.filter(scope => scope.state === 'active').length,
  ready: scopes.value.filter(scope => scope.state === 'ready').length,
  blocked: scopes.value.filter(scope => scope.state === 'blocked').length,
}))
const canApply = computed(() => catalog.status.value === 'success' && scopes.value.length > 0 && apply.status.value !== 'loading')
async function applyCatalog() {
  if (!canApply.value) return
  confirming.value = false
  await apply.load()
  if (apply.status.value === 'success') await catalog.load()
}
onMounted(() => catalog.load())
</script>

<template>
  <section
    class="routing-workspace"
    aria-label="分配与路由"
  >
    <header class="routing-heading">
      <div><span class="eyebrow">Routing policy</span><h2>让问题找到正确的处理方式</h2><p>AI 能力由问题意图选择，人工负责人由业务职责确定。</p></div>
      <span class="policy-note">两条路由 · 独立决策</span>
    </header>
    <div
      class="routing-map"
      aria-label="处理路由说明"
    >
      <div class="routing-entry">
        <span class="step-index">01</span><strong>用户提出问题</strong><small>问题、附件与会话上下文</small>
      </div>
      <div class="routing-branches">
        <section class="routing-branch">
          <span class="branch-label">AI 自助</span><div><strong>识别任务意图</strong><p>通用咨询 ／ AI 搜法 ／ AI 类案</p></div><span class="branch-note">支持手动选择</span>
        </section>
        <section class="routing-branch">
          <span class="branch-label human">人工处理</span><div><strong>匹配业务职责</strong><p>钉钉部门及上级范围 → 对应法务 BP</p></div><span class="branch-note">无匹配或冲突 → 领导待分配</span>
        </section>
      </div>
    </div>
    <p class="routing-boundary">
      风险检查决定是否进入人工流程；意图识别不会指定法务人员，也不会改变工单可见权限。
    </p>

    <header class="directory-heading">
      <div><h3>业务职责目录 <span>{{ people.length }}</span></h3><p>已确认的部分职责范围，不替代其他分工。</p></div>
      <button
        class="apply-button"
        type="button"
        :disabled="!canApply"
        :aria-expanded="confirming"
        @click="confirming = !confirming"
      >
        {{ apply.status.value === 'loading' ? '正在应用…' : '核验并应用规则' }}
      </button>
    </header>
    <div
      v-if="confirming"
      class="confirmation"
      role="region"
      aria-label="确认应用职责规则"
    >
      <div><strong>应用当前目录中的已核验范围？</strong><p>校验通过的范围将启用，校验失败的目录规则将停用。只影响后续分配，不创建账号、不调整角色、不重派历史工单。</p></div>
      <div class="confirmation-actions">
        <button
          type="button"
          @click="confirming = false"
        >
          取消
        </button><button
          class="apply-button"
          type="button"
          :disabled="!canApply"
          @click="applyCatalog"
        >
          确认应用
        </button>
      </div>
    </div>
    <p
      v-if="apply.status.value === 'success'"
      class="result-notice"
      role="status"
    >
      已应用 {{ apply.data.value?.applied }} 条；{{ apply.data.value?.blocked }} 条需完善身份或组织信息。
    </p>
    <ErrorState
      v-if="catalog.error.value"
      :message="catalog.error.value.payload.error"
      :request-id="catalog.requestId.value"
      :on-retry="catalog.load"
    />
    <ErrorState
      v-if="apply.error.value"
      :message="apply.error.value.payload.error"
      :request-id="apply.requestId.value"
    />

    <div
      v-if="catalog.status.value === 'loading' && !catalog.data.value"
      class="directory-loading"
      role="status"
    >
      正在核验法务身份与钉钉组织范围…
    </div>
    <div
      v-else-if="catalog.data.value"
      class="responsibility-directory"
      :aria-busy="catalog.status.value === 'loading'"
    >
      <nav
        class="people-panel"
        aria-label="选择法务职责"
      >
        <label class="people-search"><svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        ><circle
          cx="10.5"
          cy="10.5"
          r="6.5"
        /><path d="m16 16 4 4" /></svg><input
          v-model="keyword"
          type="search"
          placeholder="搜索姓名、业务线或部门"
          aria-label="搜索法务职责"
        ></label>
        <div class="people-list">
          <button
            v-for="person in filteredPeople"
            :key="person.key"
            type="button"
            class="person-option"
            :class="{ selected: selected?.key === person.key }"
            :aria-pressed="selected?.key === person.key"
            @click="selectedKey = person.key"
          >
            <span class="person-avatar">{{ person.name.slice(-2) }}</span>
            <span class="person-copy"><strong>{{ person.name }}</strong><small>{{ person.businessLines.join(' / ') }}</small></span>
            <span class="person-count">{{ person.scopes.filter(scope => scope.state === 'active').length }}<span>启用</span></span>
          </button>
          <p
            v-if="!filteredPeople.length"
            class="empty-directory"
          >
            {{ people.length ? '未找到匹配的职责' : '暂无职责目录' }}
          </p>
        </div>
        <div class="directory-summary">
          <span
            v-for="(label, state) in stateLabels"
            :key="state"
          ><i :class="state" />{{ label }} <b>{{ counts[state] }}</b></span>
        </div>
      </nav>
      <article
        v-if="selected"
        class="responsibility-detail"
        aria-label="法务职责详情"
      >
        <header class="person-heading">
          <div><span class="eyebrow">法务 BP</span><h3>{{ selected.name }}</h3></div><span class="scope-total">{{ selected.scopes.length }} 个明确范围</span>
        </header>
        <div class="business-lines">
          <span
            v-for="line in selected.businessLines"
            :key="line"
          >{{ line }}</span>
        </div>
        <p class="responsibility-description">
          {{ selected.description }}
        </p>
        <div class="scope-heading">
          <h4>钉钉组织范围</h4><span>含下级部门 · 最近范围优先</span>
        </div>
        <ul
          v-if="selected.scopes.length"
          class="scope-list"
        >
          <li
            v-for="scope in selected.scopes"
            :key="scope.id"
          >
            <div class="scope-row">
              <strong>{{ scope.name }}</strong><span
                class="scope-state"
                :class="scope.state"
              ><i />{{ stateLabels[scope.state] }}</span>
            </div>
            <p
              v-if="scope.issue"
              class="scope-issue"
            >
              {{ scope.issue }}
            </p>
          </li>
        </ul>
        <p
          v-else
          class="no-scopes"
        >
          尚无已明确的组织范围，相关工单进入领导待分配队列。
        </p>
        <aside
          v-if="selected.pendingScopes.length"
          class="pending-scopes"
        >
          <h4>待确认的职责边界</h4><ul>
            <li
              v-for="scope in selected.pendingScopes"
              :key="scope"
            >
              {{ scope }}
            </li>
          </ul><p>确认前不启用，不扩大到整条业务线。</p>
        </aside>
      </article>
      <div
        v-else
        class="detail-empty"
      >
        选择一位法务，查看职责与组织范围。
      </div>
    </div>
    <footer class="routing-footnote">
      规则生效需完成钉钉通讯录同步、账号绑定和部门核验。普通法务仅查看分配给自己的工单；未分配工单由法务领导处理。
    </footer>
  </section>
</template>

<style scoped>
.routing-workspace { --routing-line: #e6eaf0; color: #1c293d; padding: 28px 0 8px; }
.routing-workspace h2, .routing-workspace h3, .routing-workspace h4, .routing-workspace p { margin: 0; }
.routing-heading, .directory-heading, .person-heading, .scope-heading, .scope-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.eyebrow { display: block; margin-bottom: 8px; color: #718096; font-size: 11px; font-weight: 600; letter-spacing: .06em; }
.routing-heading h2 { font-size: clamp(20px, 2vw, 26px); font-weight: 600; letter-spacing: -.025em; }
.routing-heading p, .directory-heading p { margin-top: 9px; color: #718096; font-size: 13px; line-height: 1.6; }
.policy-note { color: #718096; white-space: nowrap; font-size: 12px; }
.routing-map { display: grid; grid-template-columns: minmax(165px, .8fr) 3fr; margin-top: 24px; border: 1px solid var(--routing-line); border-radius: 14px; overflow: hidden; background: #fff; }
.routing-entry { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 24px; background: #f0f4fa; border-right: 1px solid var(--routing-line); }
.step-index { color: #8493a8; font-size: 12px; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
.routing-entry strong { font-size: 15px; font-weight: 600; }
.routing-entry small { margin-top: 8px; color: #718096; font-size: 11px; }
.routing-branch { display: flex; align-items: center; gap: 22px; padding: 20px 24px; }
.routing-branch + .routing-branch { border-top: 1px solid var(--routing-line); }
.branch-label { color: #2563eb; background: #edf3ff; border-radius: 5px; padding: 5px 8px; font-size: 11px; white-space: nowrap; }
.branch-label.human { color: #53647b; background: #f1f4f8; }
.routing-branch strong { font-size: 13px; font-weight: 600; }
.routing-branch p { margin-top: 6px; font-size: 12px; color: #718096; line-height: 1.6; }
.branch-note { margin-left: auto; font-size: 11px; color: #7b889b; }
.routing-boundary { margin-top: 11px !important; color: #7b889b; font-size: 11px; line-height: 1.7; }
.directory-heading { margin: 32px 0 18px; }
.directory-heading h3 { font-size: 17px; font-weight: 600; }
.directory-heading h3 span { margin-left: 8px; color: #8290a2; font-size: 13px; font-weight: 400; }
.routing-workspace button { font-family: inherit; cursor: pointer; transition: background .18s, border-color .18s; }
.routing-workspace button:disabled { opacity: .45; cursor: not-allowed; }
.routing-workspace button:focus-visible, .people-search:focus-within { outline: 2px solid #2563eb; outline-offset: 3px; }
.apply-button { border: 1px solid #2563eb; background: #2563eb; color: #fff; padding: 10px 15px; border-radius: 7px; font-size: 12px; white-space: nowrap; }
.apply-button:hover:not(:disabled) { background: #1d4ed8; }
.responsibility-directory { display: grid; grid-template-columns: minmax(230px, 30%) minmax(0, 1fr); border: 1px solid var(--routing-line); border-radius: 14px; overflow: hidden; background: #fff; }
.people-panel { background: #fafbfd; border-right: 1px solid var(--routing-line); display: flex; flex-direction: column; }
.people-search { display: flex; gap: 8px; align-items: center; margin: 18px 16px 10px; padding: 9px 10px; border: 1px solid var(--routing-line); background: #fff; border-radius: 7px; }
.people-search svg { width: 16px; height: 16px; flex-shrink: 0; color: #8493a8; }
.people-search input { min-width: 0; width: 100%; border: 0; background: none; outline: 0; font: inherit; font-size: 11px; color: #24344b; }
.people-list { padding: 0 8px 16px; }
.person-option { display: flex; width: 100%; gap: 11px; text-align: left; align-items: center; border: 1px solid transparent; background: none; color: inherit; padding: 14px 10px; border-radius: 8px; margin: 3px 0; }
.person-option:hover { background: #f0f3f8; }.person-option.selected { background: #edf3ff; border-color: #dce7fd; }
.person-avatar { flex-shrink: 0; display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid #e6eaf0; border-radius: 11px; background: #fff; color: #62718a; font-size: 11px; }
.selected .person-avatar { color: #2563eb; border-color: #dce7fd; }
.person-copy { flex: 1; min-width: 0; }.person-copy strong { display: block; font-size: 13px; font-weight: 600; }
.person-copy small { display: block; margin-top: 5px; font-size: 10px; color: #7b889b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.person-count { font-size: 14px; color: #738197; text-align: center; font-variant-numeric: tabular-nums; }.person-count span { display: block; margin-top: 3px; font-size: 9px; }
.directory-summary { margin-top: auto; padding: 18px 16px; border-top: 1px solid var(--routing-line); display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: #7b889b; }
.directory-summary b { font-weight: 500; color: #43536b; font-variant-numeric: tabular-nums; }
.directory-summary i, .scope-state i { display: inline-block; height: 5px; width: 5px; border-radius: 50%; background: currentColor; margin-right: 5px; }
.directory-summary .active { color: #3f8b70; }.directory-summary .ready { color: #2563eb; }.directory-summary .blocked { color: #bb9456; }
.responsibility-detail { padding: 26px 30px 30px; min-width: 0; }.person-heading h3 { font-size: 25px; font-weight: 600; letter-spacing: -.03em; }.scope-total { font-size: 11px; color: #8493a8; }
.business-lines { display: flex; flex-wrap: wrap; gap: 7px; margin: 16px 0; }.business-lines span { font-size: 11px; color: #526682; background: #f1f4f8; padding: 5px 8px; border-radius: 4px; }
.responsibility-description { color: #66758b; font-size: 12px; line-height: 1.9; max-width: 65ch; }
.scope-heading { margin-top: 25px; padding-bottom: 13px; border-bottom: 1px solid var(--routing-line); }.scope-heading h4, .pending-scopes h4 { font-size: 12px; font-weight: 600; }.scope-heading > span { color: #8493a8; font-size: 10px; }
.scope-list { list-style: none; padding: 0; margin: 0; }.scope-list li { padding: 16px 0; border-bottom: 1px solid #f0f2f6; }.scope-row strong { font-size: 12px; font-weight: 500; }
.scope-state { font-size: 10px; white-space: nowrap; }.scope-state.active { color: #34775f; }.scope-state.ready { color: #2563eb; }.scope-state.blocked { color: #946d33; }
.scope-issue { margin-top: 8px !important; color: #8b7d68; font-size: 11px; line-height: 1.6; }
.pending-scopes { margin-top: 22px; padding: 15px 17px; background: #faf8f3; border-radius: 7px; color: #897450; }.pending-scopes ul { margin: 9px 0; padding-left: 16px; font-size: 11px; line-height: 1.8; }.pending-scopes p { font-size: 10px; color: #9b8b70; }
.routing-footnote { margin-top: 15px; color: #8493a8; font-size: 11px; line-height: 1.8; }
.no-scopes, .detail-empty, .empty-directory, .directory-loading { padding: 26px 14px; color: #8493a8; font-size: 12px; line-height: 1.8; }.detail-empty { align-self: center; text-align: center; }
.confirmation { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px; background: #edf3ff; border: 1px solid #dce7fd; border-radius: 10px; margin-bottom: 16px; }.confirmation strong { font-size: 13px; }.confirmation p { margin-top: 7px; font-size: 12px; line-height: 1.7; color: #62718a; }
.confirmation-actions { display: flex; gap: 8px; flex-shrink: 0; }.confirmation-actions > button:not(.apply-button) { border: 0; background: none; color: #62718a; }
.result-notice { padding: 12px 0; font-size: 12px; color: #34775f; }
@media (max-width: 1050px) { .branch-note { display: none; }.routing-branch { gap: 12px; padding: 18px; }.responsibility-detail { padding: 24px; } }
@media (max-width: 700px) { .policy-note { display: none; }.routing-map { grid-template-columns: 1fr; }.routing-entry { border-right: 0; padding: 18px; }.step-index { display: none; }.routing-entry small { margin-top: 5px; }.responsibility-directory { grid-template-columns: 1fr; }.people-panel { border-right: 0; border-bottom: 1px solid var(--routing-line); }.people-list { display: flex; overflow-x: auto; padding-bottom: 8px; }.person-option { min-width: 170px; }.person-count, .person-copy small { display: none; }.directory-summary { justify-content: flex-start; gap: 20px; padding: 12px 18px; }.responsibility-detail { padding: 22px 18px; }.confirmation { flex-direction: column; align-items: stretch; }.confirmation-actions { justify-content: flex-end; }.directory-heading { align-items: flex-start; }.directory-heading p { max-width: 23ch; }.scope-heading { align-items: flex-start; }.scope-heading > span { text-align: right; } }
</style>
