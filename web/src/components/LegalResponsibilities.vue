<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { request } from '../api/client'
import { useRemoteData } from '../composables/useRemoteData'
import { scopeStateLabels, scopeStatusLabel, type LegalResponsibility } from '../domain/legal-responsibility'
import ErrorState from './ErrorState.vue'

const catalog = useRemoteData(() => request<LegalResponsibility[]>('/admin/members/bp-responsibilities'))
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
    <details class="routing-policy">
      <summary>
        <span class="policy-summary"><strong>AI 按意图选择能力</strong><span class="policy-divider">/</span><strong>人工按业务职责分配</strong></span>
        <span class="policy-toggle">路由说明 <span aria-hidden="true">⌄</span></span>
      </summary>
      <div class="policy-detail">
        <p><strong>AI 自助</strong>识别问题意图，选择通用咨询、AI 搜法或 AI 类案；支持手动选择。</p>
        <p><strong>人工处理</strong>按申请人的钉钉部门及上级范围匹配法务 BP；无匹配或冲突时交法务领导。</p>
        <p>风险检查决定是否进入人工流程。意图识别不会指定法务人员，也不会改变工单可见权限。</p>
      </div>
    </details>

    <div
      v-if="confirming"
      class="confirmation"
      role="region"
      aria-label="确认应用职责规则"
    >
      <div>
        <strong>应用当前目录中的已核验范围？</strong>
        <p>校验通过的范围将启用，校验失败的目录规则将停用。只影响后续分配，不创建账号、不调整角色、不重派历史工单。</p>
      </div>
      <div class="confirmation-actions">
        <button
          type="button"
          class="secondary-button"
          @click="confirming = false"
        >
          取消
        </button>
        <button
          type="button"
          class="apply-button"
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
      已应用 {{ apply.data.value?.applied }} 条；{{ apply.data.value?.blocked }} 条仍需完成账号或组织关联。
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
      <span class="loading-line" /><span class="loading-line" /><span class="loading-line" />
      正在读取职责与系统关联状态…
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
        <header class="people-heading">
          <h2>法务人员 <span>{{ people.length }}</span></h2><span>业务职责目录</span>
        </header>
        <label class="people-search">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          ><circle
            cx="10.5"
            cy="10.5"
            r="6.5"
          /><path d="m16 16 4 4" /></svg>
          <input
            v-model="keyword"
            type="search"
            placeholder="搜索姓名、业务线或部门"
            aria-label="搜索法务职责"
          >
        </label>
        <div class="people-list">
          <button
            v-for="person in filteredPeople"
            :key="person.key"
            type="button"
            class="person-option"
            :class="{ selected: selected?.key === person.key }"
            :aria-pressed="selected?.key === person.key"
            :title="person.businessLines.join(' / ')"
            @click="selectedKey = person.key"
          >
            <span
              class="person-avatar"
              aria-hidden="true"
            >{{ person.name.slice(-2) }}</span>
            <span class="person-copy"><strong>{{ person.name }}</strong><small>{{ person.businessLines.join(' / ') }}</small></span>
            <svg
              class="person-chevron"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            ><path d="m8 5 5 5-5 5" /></svg>
          </button>
          <p
            v-if="!filteredPeople.length"
            class="empty-directory"
          >
            {{ people.length ? '未找到匹配的职责' : '暂无职责目录' }}
          </p>
        </div>
        <div
          class="directory-summary"
          aria-label="规则关联统计"
        >
          <span
            v-for="(label, state) in scopeStateLabels"
            :key="state"
          ><i :class="state" />{{ label }} <b>{{ counts[state] }}</b></span>
        </div>
      </nav>

      <div class="detail-panel">
        <header class="detail-toolbar">
          <span>{{ people.length ? '业务职责已记录' : '业务职责目录' }} <span class="toolbar-note">· 仅影响后续工单</span></span>
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
        <article
          v-if="selected"
          class="responsibility-detail"
          aria-label="法务职责详情"
        >
          <header class="person-heading">
            <div><h3>{{ selected.name }}</h3><span class="person-role">法务 BP</span></div>
            <span class="scope-total">{{ selected.scopes.length }} 个部门范围</span>
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

          <section
            class="organization-mapping"
            aria-label="业务范围与组织关联"
          >
            <header class="scope-heading">
              <h4>业务范围与组织关联</h4><span>含下级部门 · 最近范围优先</span>
            </header>
            <p
              v-if="selected.scopes.some(scope => scope.state === 'blocked')"
              class="mapping-notice"
            >
              以下业务范围已明确。未启用项需完成系统关联，无需重复填写职责。
            </p>
            <table
              v-if="selected.scopes.length"
              class="scope-table"
            >
              <thead>
                <tr>
                  <th scope="col">
                    已明确的业务范围
                  </th><th scope="col">
                    系统关联状态
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="scope in selected.scopes"
                  :key="scope.id"
                >
                  <th scope="row">
                    <strong>{{ scope.name }}</strong><small>钉钉部门 ID · {{ scope.id }}</small><p
                      v-if="scope.issue"
                      class="scope-issue"
                    >
                      {{ scope.issue }}
                    </p>
                  </th>
                  <td>
                    <span
                      class="scope-state"
                      :class="scope.state"
                    ><i />{{ scopeStatusLabel(scope) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p
              v-else
              class="no-scopes"
            >
              职责说明已保留，尚未对应到具体钉钉部门或人员；相关工单先交法务领导。
            </p>
          </section>

          <aside
            v-if="selected.pendingScopes.length"
            class="pending-scopes"
          >
            <h4>尚未对应到具体部门或人员的范围</h4>
            <ul>
              <li
                v-for="scope in selected.pendingScopes"
                :key="scope"
              >
                {{ scope }}
              </li>
            </ul>
            <p>保留上述职责描述，确认组织节点或人员边界后再启用，不扩大分配范围。</p>
          </aside>
          <details class="mapping-help">
            <summary>如何让已明确的范围生效？</summary>
            <ol><li>同步钉钉通讯录，取得有效部门树。</li><li>核验法务账号绑定，以及部门 ID 与名称。</li><li>点击“核验并应用规则”，确认后启用校验通过的范围。</li></ol>
          </details>
        </article>
        <div
          v-else
          class="detail-empty"
        >
          选择一位法务，查看职责与组织范围。
        </div>
      </div>
    </div>
    <footer class="routing-footnote">
      普通法务仅查看分配给自己的工单；未匹配或冲突的工单交法务领导处理。
    </footer>
  </section>
</template>

<style scoped>
.routing-workspace {
  --routing-line: #e3e8f0;
  --routing-ink: #1c293d;
  --routing-muted: #596b82;
  --routing-accent: #315bd6;
  padding-top: 12px;
  color: var(--routing-ink);
  font-size: 14px;
  line-height: 1.6;
}
.routing-workspace h2, .routing-workspace h3, .routing-workspace h4, .routing-workspace p { margin: 0; }
.routing-workspace button { font: inherit; cursor: pointer; transition: background .18s, border-color .18s; }
.routing-workspace button:disabled { opacity: .45; cursor: not-allowed; }
.routing-workspace button:focus-visible, .routing-workspace summary:focus-visible, .people-search:focus-within { outline: 2px solid var(--routing-accent); outline-offset: 3px; }
.routing-workspace summary { cursor: pointer; }
.routing-policy { margin-bottom: 12px; border: 1px solid #dfe7f6; border-radius: 8px; background: #f0f4fc; }
.routing-policy > summary { display: flex; min-height: 42px; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 16px; list-style: none; }
.routing-policy > summary::-webkit-details-marker { display: none; }
.policy-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 13px; }
.policy-summary strong { font-weight: 500; }
.policy-divider { color: #8191a8; }
.policy-toggle { flex-shrink: 0; color: var(--routing-accent); font-size: 12px; }
.policy-toggle > span { display: inline-block; margin-left: 4px; }
.routing-policy[open] .policy-toggle > span { transform: rotate(180deg); }
.policy-detail { padding: 4px 16px 16px; color: var(--routing-muted); font-size: 13px; }
.policy-detail p + p { margin-top: 8px; }
.policy-detail strong { margin-right: 12px; color: var(--routing-ink); font-weight: 600; }
.responsibility-directory { display: grid; grid-template-columns: minmax(248px, 29%) minmax(0, 1fr); align-items: start; gap: 16px; }
/* Keep people reachable in the page flow; no fixed-height list or horizontal-only carousel. */
.people-panel { min-width: 0; position: sticky; top: 0; border: 1px solid var(--routing-line); border-radius: 10px; background: #fff; }
.people-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 16px 10px; }
.people-heading h2 { font-size: 15px; font-weight: 600; white-space: nowrap; }
.people-heading h2 span { margin-left: 6px; color: var(--routing-muted); font-size: 13px; font-variant-numeric: tabular-nums; font-weight: 400; }
.people-heading > span { color: var(--routing-muted); font-size: 11px; }
.people-search { display: flex; gap: 8px; align-items: center; margin: 0 12px 8px; padding: 8px 10px; border: 1px solid var(--routing-line); background: #fafbfd; border-radius: 6px; }
.people-search svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--routing-muted); }
.people-search input { min-width: 0; width: 100%; border: 0; background: none; outline: 0; font: inherit; font-size: 12px; color: var(--routing-ink); }
.people-search input::placeholder { color: #63758b; }
.people-list { display: grid; gap: 2px; padding: 0 6px 8px; }
.person-option { display: flex; width: 100%; min-width: 0; gap: 10px; text-align: left; align-items: center; border: 1px solid transparent; background: none; color: inherit; padding: 8px; border-radius: 6px; }
.person-option:hover { background: #f4f6fa; }
.person-option.selected { background: #edf2ff; border-color: #dbe5fc; }
.person-avatar { flex-shrink: 0; display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--routing-line); border-radius: 9px; background: #f7f9fc; color: #536984; font-size: 12px; }
.selected .person-avatar { color: var(--routing-accent); background: #fff; border-color: #cfddfa; }
.person-copy { flex: 1; min-width: 0; }
.person-copy strong { display: block; font-size: 14px; font-weight: 600; }
.person-copy small { display: block; font-size: 11px; line-height: 1.7; color: var(--routing-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.person-chevron { width: 16px; height: 16px; flex-shrink: 0; color: #8291a6; }
.selected .person-chevron { color: var(--routing-accent); }
.directory-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--routing-line); font-size: 11px; color: var(--routing-muted); }
.directory-summary b { font-weight: 600; color: var(--routing-ink); font-variant-numeric: tabular-nums; }
.directory-summary i, .scope-state i { display: inline-block; height: 5px; width: 5px; border-radius: 50%; background: currentColor; margin-right: 5px; }
.directory-summary .active { color: #34775f; }
.directory-summary .ready { color: var(--routing-accent); }
.directory-summary .blocked { color: #96661b; }
.detail-panel { min-width: 0; border: 1px solid var(--routing-line); border-radius: 10px; background: #fff; }
.detail-toolbar { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 22px; border-bottom: 1px solid var(--routing-line); }
.detail-toolbar > span { font-size: 12px; color: var(--routing-muted); }
.toolbar-note { color: #64748b; }
.apply-button, .secondary-button { min-height: 38px; border: 1px solid var(--routing-accent); background: var(--routing-accent); color: #fff; padding: 7px 13px; border-radius: 6px; font-size: 12px !important; white-space: nowrap; }
.apply-button:hover:not(:disabled) { background: #2549b2; }
.secondary-button { background: #fff; border-color: var(--routing-line); color: var(--routing-muted); }
.secondary-button:hover { background: #f5f7fa; }
.responsibility-detail { padding: 20px 22px; min-width: 0; }
.person-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.person-heading > div { display: flex; align-items: center; gap: 12px; }
.person-heading h3 { font-size: 25px; font-weight: 600; letter-spacing: -.02em; line-height: 1.3; }
.person-role, .scope-total { font-size: 12px; color: var(--routing-muted); }
.business-lines { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
.business-lines span { font-size: 12px; line-height: 1.6; color: #50637e; background: #f2f5fa; padding: 3px 8px; border-radius: 4px; }
.responsibility-description { color: #52647a; font-size: 13px; line-height: 1.85; max-width: 76ch; text-wrap: pretty; }
.organization-mapping { margin-top: 22px; }
.scope-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.scope-heading h4, .pending-scopes h4 { font-size: 14px; font-weight: 600; }
.scope-heading > span { color: var(--routing-muted); font-size: 11px; }
.mapping-notice { padding: 10px 12px; margin-bottom: 12px !important; border-left: 2px solid #c89b52; background: #fcf8ef; color: #795821; font-size: 12px; line-height: 1.7; }
.scope-table { width: 100%; border: 1px solid var(--routing-line); border-collapse: separate; border-spacing: 0; border-radius: 6px; overflow: hidden; font-size: 13px; }
.scope-table th { text-align: left; font-weight: 500; }
.scope-table thead th { background: #f6f8fb; color: var(--routing-muted); font-size: 12px; padding: 9px 12px; }
.scope-table tbody th, .scope-table td { border-top: 1px solid var(--routing-line); padding: 12px; vertical-align: top; }
.scope-table tbody th strong { font-weight: 600; }
.scope-table tbody th small { display: block; margin-top: 4px; font-size: 11px; color: var(--routing-muted); font-variant-numeric: tabular-nums; }
.scope-table td { width: 120px; }
.scope-state { display: inline-flex; align-items: center; font-size: 12px; white-space: nowrap; padding: 3px 8px; border-radius: 4px; }
.scope-state.active { color: #296c52; background: #eef7f2; }
.scope-state.ready { color: #315bd6; background: #eef3ff; }
.scope-state.blocked { color: #825819; background: #faf3e7; }
.scope-issue { margin-top: 8px !important; color: #6b6251; font-size: 12px; font-weight: 400; line-height: 1.7; }
.pending-scopes { margin-top: 18px; padding: 14px 16px; background: #f7f8fb; border-radius: 6px; color: #55667c; }
.pending-scopes ul { margin: 8px 0; padding-left: 18px; font-size: 12px; line-height: 1.8; }
.pending-scopes p { font-size: 12px; }
.mapping-help { margin-top: 18px; color: var(--routing-muted); font-size: 12px; }
.mapping-help summary { width: fit-content; color: var(--routing-accent); }
.mapping-help ol { padding-left: 20px; margin: 10px 0 0; line-height: 1.9; }
.routing-footnote { padding: 12px 0; color: var(--routing-muted); font-size: 12px; line-height: 1.8; }
.no-scopes, .detail-empty, .empty-directory, .directory-loading { padding: 24px 12px; color: var(--routing-muted); font-size: 13px; line-height: 1.8; }
.detail-empty { padding: 80px 20px; text-align: center; }
.directory-loading { padding: 24px; border: 1px solid var(--routing-line); background: #fff; border-radius: 10px; }
.loading-line { display: block; height: 16px; width: 65%; margin-bottom: 16px; background: #eef1f6; border-radius: 4px; }
.loading-line:nth-child(2) { width: 85%; }
.confirmation { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px; background: #edf3ff; border: 1px solid #dce7fd; border-radius: 8px; margin-bottom: 12px; }
.confirmation strong { font-size: 14px; }
.confirmation p { margin-top: 6px; font-size: 13px; line-height: 1.7; color: var(--routing-muted); }
.confirmation-actions { display: flex; gap: 8px; flex-shrink: 0; }
.result-notice { padding: 12px 0; font-size: 13px; color: #296c52; }
@media (max-width: 1100px) {
  .responsibility-directory { grid-template-columns: minmax(224px, 31%) minmax(0, 1fr); gap: 12px; }
  .toolbar-note { display: none; }
  .detail-toolbar, .responsibility-detail { padding-left: 16px; padding-right: 16px; }
  .scope-heading { align-items: flex-start; }
  .scope-heading > span { text-align: right; }
}
@media (max-width: 900px) {
  .responsibility-directory { grid-template-columns: minmax(0, 1fr); }
  .people-panel { position: static; }
  .people-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .people-search { max-width: 400px; }
  .directory-summary { justify-content: flex-start; gap: 18px; }
}
@media (max-width: 600px) {
  .routing-policy > summary { padding: 10px 12px; align-items: flex-start; gap: 8px; }
  .policy-summary { display: grid; gap: 2px; font-size: 12px; }
  .policy-divider { display: none; }
  .policy-toggle { font-size: 11px; padding-top: 2px; }
  .people-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .person-option { min-height: 48px; gap: 7px; }
  .person-avatar { width: 30px; height: 30px; font-size: 11px; }
  .person-copy strong { font-size: 13px; }
  .person-copy small, .person-chevron { display: none; }
  .people-heading { padding: 12px; }
  .detail-toolbar { flex-wrap: wrap; gap: 8px; padding: 12px; }
  .responsibility-detail { padding: 16px 12px; }
  .person-heading h3 { font-size: 22px; }
  .person-heading > div { gap: 8px; }
  .scope-total { font-size: 11px; }
  .scope-heading { display: block; }
  .scope-heading > span { display: block; margin-top: 4px; text-align: left; }
  .scope-table thead th, .scope-table tbody th, .scope-table td { padding: 10px 8px; }
  .scope-table td { width: 98px; }
  .scope-state { font-size: 11px; padding: 3px 4px; }
  .confirmation { flex-direction: column; align-items: stretch; }
  .confirmation-actions { justify-content: flex-end; }
}
@media (prefers-reduced-motion: reduce) {
  .routing-workspace button { transition: none; }
}
</style>
