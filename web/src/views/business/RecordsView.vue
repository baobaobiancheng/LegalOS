<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'
import { useRouter } from 'vue-router'
import { request } from '../../api/client'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import ErrorState from '../../components/ErrorState.vue'
import { useRemoteData } from '../../composables/useRemoteData'
import { buildPagination } from '../../domain/legal-research'
import { statusClass } from '../../domain/project-status'
import type { ProjectKind, ProjectListResponse, ProjectStatus } from '../../types'

const PAGE_SIZE = 10
type RecordGroup = '' | 'processing' | 'completed' | 'cancelled'

const router = useRouter()
const pageRoot = ref<HTMLElement | null>(null)
const activeGroup = ref<RecordGroup>('')
const currentPage = ref(1)
const kind = ref<'' | ProjectKind>('')
const searchDraft = ref('')
const searchQuery = ref('')
let animationContext: gsap.Context | null = null

const requestUrl = computed(() => {
  const params = new URLSearchParams({
    page: String(currentPage.value),
    size: String(PAGE_SIZE),
  })
  if (activeGroup.value) params.set('group', activeGroup.value)
  if (kind.value) params.set('kind', kind.value)
  if (searchQuery.value) params.set('query', searchQuery.value)
  return `/projects/mine?${params.toString()}`
})

const remote = useRemoteData(() => request<ProjectListResponse>(requestUrl.value))
const loading = computed(() => remote.status.value === 'loading')
const items = computed(() => remote.data.value?.items ?? [])
const total = computed(() => remote.data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const pagination = computed(() => buildPagination(currentPage.value, totalPages.value))
const emptyStatusCounts: Record<ProjectStatus, number> = {
  分析中: 0,
  待处理: 0,
  待复核: 0,
  已回传: 0,
  已取消: 0,
}
const statusCounts = computed(() => remote.data.value?.statusCounts ?? emptyStatusCounts)
const processingCount = computed(() =>
  statusCounts.value.分析中 + statusCounts.value.待处理 + statusCounts.value.待复核,
)
const allCount = computed(() => Object.values(statusCounts.value).reduce((sum, count) => sum + count, 0))
const groups = computed<Array<{ key: RecordGroup; label: string; count: number }>>(() => [
  { key: '', label: '全部', count: allCount.value },
  { key: 'processing', label: '处理中', count: processingCount.value },
  { key: 'completed', label: '已回传', count: statusCounts.value.已回传 },
  { key: 'cancelled', label: '已取消', count: statusCounts.value.已取消 },
])
const summary = computed(() => [
  { label: '全部记录', count: allCount.value },
  { label: '处理中', count: processingCount.value },
  { label: '已回传', count: statusCounts.value.已回传 },
  { label: '已取消', count: statusCounts.value.已取消 },
])

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

async function animateRows() {
  if (reducedMotion()) return
  await nextTick()
  animationContext?.add(() => {
    gsap.fromTo(
      '.record-row',
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: .38, stagger: .035, ease: 'power2.out', overwrite: true },
    )
  })
}

async function loadRecords() {
  await remote.load()
  const maximumPage = Math.max(1, Math.ceil((remote.data.value?.total ?? 0) / PAGE_SIZE))
  if (currentPage.value > maximumPage) {
    currentPage.value = maximumPage
    await remote.load()
  }
  await animateRows()
}

async function selectGroup(group: RecordGroup) {
  if (loading.value || group === activeGroup.value) return
  activeGroup.value = group
  currentPage.value = 1
  await loadRecords()
}

async function selectKind() {
  currentPage.value = 1
  await loadRecords()
}

async function applySearch() {
  if (loading.value) return
  const value = searchDraft.value.trim()
  if (value === searchQuery.value) return
  searchQuery.value = value
  currentPage.value = 1
  await loadRecords()
}

async function clearSearchWhenEmpty() {
  if (!searchDraft.value && searchQuery.value) await applySearch()
}

async function goToPage(page: number) {
  if (loading.value || page === currentPage.value || page < 1 || page > totalPages.value) return
  currentPage.value = page
  await loadRecords()
  pageRoot.value?.querySelector('.records-toolbar')?.scrollIntoView({
    behavior: reducedMotion() ? 'auto' : 'smooth',
    block: 'start',
  })
}

const kindLabel = (value: ProjectKind) => ({
  consult: '咨询',
  contract: '合同',
  research: '检索',
  draft: '文书',
})[value]

const formatTime = (value: string) => {
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}  ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

onMounted(async () => {
  if (pageRoot.value) {
    animationContext = gsap.context(() => {
      if (reducedMotion()) return
      gsap.from('.records-heading > *', {
        autoAlpha: 0,
        y: 18,
        duration: .58,
        stagger: .08,
        ease: 'power2.out',
      })
      gsap.from('.summary-cell', {
        autoAlpha: 0,
        y: 14,
        duration: .46,
        stagger: .06,
        delay: .12,
        ease: 'power2.out',
      })
    }, pageRoot.value)
  }
  await loadRecords()
})

onBeforeUnmount(() => animationContext?.revert())
</script>

<template>
  <BusinessSidebarLayout active-key="records">
    <div
      ref="pageRoot"
      class="records-page"
    >
      <header class="records-heading">
        <p class="breadcrumb">
          业务工作台 <span>/</span> 我的记录
        </p>
        <div class="heading-row">
          <div class="heading-copy">
            <h1>我的记录</h1>
            <span class="heading-divider" />
            <p>集中查看法律咨询与合同协作进度，快速回到未完成事项</p>
          </div>
          <button
            class="new-consult-button"
            @click="router.push('/business/consult')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            ><path d="M12 5v14M5 12h14" /></svg>
            发起新咨询
          </button>
        </div>
      </header>

      <section
        class="summary-grid"
        aria-label="记录统计"
      >
        <div
          v-for="stat in summary"
          :key="stat.label"
          class="summary-cell"
        >
          <span>{{ stat.label }}</span>
          <strong>{{ stat.count }}</strong>
        </div>
      </section>

      <div class="records-toolbar">
        <nav aria-label="记录状态">
          <button
            v-for="group in groups"
            :key="group.key || 'all'"
            :class="{ active: activeGroup === group.key }"
            :aria-current="activeGroup === group.key ? 'page' : undefined"
            :disabled="loading"
            @click="selectGroup(group.key)"
          >
            {{ group.label }} <span>{{ group.count }}</span>
          </button>
        </nav>
        <div class="filters">
          <label class="search-field">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            ><circle
              cx="11"
              cy="11"
              r="7"
            /><path d="m20 20-4-4" /></svg>
            <input
              v-model="searchDraft"
              type="search"
              placeholder="搜索记录标题"
              :disabled="loading"
              @keydown.enter="applySearch"
              @input="clearSearchWhenEmpty"
            >
          </label>
          <label class="kind-filter">
            <span class="sr-only">记录类型</span>
            <select
              v-model="kind"
              :disabled="loading"
              @change="selectKind"
            >
              <option value="">
                全部类型
              </option>
              <option value="consult">
                法律咨询
              </option>
              <option value="contract">
                合同
              </option>
              <option value="research">
                检索
              </option>
              <option value="draft">
                文书
              </option>
            </select>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="m7 10 5 5 5-5" /></svg>
          </label>
        </div>
      </div>

      <section class="records-table-section">
        <div
          v-if="loading"
          class="records-table loading-table"
          aria-label="正在加载记录"
        >
          <div class="table-head">
            <span>类型</span><span>标题</span><span>风险</span><span>创建时间</span><span>更新时间</span><span>状态</span><span />
          </div>
          <div
            v-for="index in PAGE_SIZE"
            :key="index"
            class="skeleton-row"
          >
            <i
              v-for="cell in 7"
              :key="cell"
            />
          </div>
        </div>

        <ErrorState
          v-else-if="remote.status.value === 'error'"
          :message="remote.error.value?.payload.error || '记录加载失败，请重试'"
          :request-id="remote.requestId.value"
          :on-retry="loadRecords"
        />

        <div
          v-else-if="items.length === 0"
          class="empty-state"
        >
          <span class="empty-icon">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>
          </span>
          <strong>没有找到匹配记录</strong>
          <p>调整状态、类型或标题关键词后再试。</p>
        </div>

        <div
          v-else
          class="records-table"
          role="table"
          aria-label="我的记录列表"
        >
          <div
            class="table-head"
            role="row"
          >
            <span role="columnheader">类型</span>
            <span role="columnheader">标题</span>
            <span role="columnheader">风险</span>
            <span role="columnheader">创建时间</span>
            <span role="columnheader">更新时间</span>
            <span role="columnheader">状态</span>
            <span role="columnheader" />
          </div>
          <button
            v-for="record in items"
            :key="record.id"
            class="record-row"
            role="row"
            :aria-label="`查看记录：${record.title}`"
            @click="router.push('/business/records/' + record.id)"
          >
            <span role="cell"><i :class="['kind-tag', `kind-${record.kind}`]">{{ kindLabel(record.kind) }}</i></span>
            <span
              class="record-title"
              role="cell"
            >{{ record.title }}</span>
            <span role="cell"><i :class="['risk-tag', `risk-${record.risk}`]">{{ record.risk }}</i></span>
            <span role="cell">{{ formatTime(record.createdAt) }}</span>
            <span role="cell">{{ formatTime(record.updatedAt || record.createdAt) }}</span>
            <span
              :class="['status-cell', statusClass(record.status)]"
              role="cell"
            >{{ record.status }}</span>
            <span
              class="row-arrow"
              role="cell"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              ><path d="m9 18 6-6-6-6" /></svg>
            </span>
          </button>
        </div>

        <footer
          v-if="!loading && remote.status.value === 'success'"
          class="pagination-footer"
        >
          <span>第 {{ currentPage }} / {{ totalPages }} 页&nbsp;&nbsp;·&nbsp;&nbsp;共 {{ total }} 条&nbsp;&nbsp;·&nbsp;&nbsp;每页 {{ PAGE_SIZE }} 条</span>
          <nav aria-label="记录分页">
            <button
              aria-label="上一页"
              :disabled="currentPage <= 1"
              @click="goToPage(currentPage - 1)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              ><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <template
              v-for="item in pagination"
              :key="item.key"
            >
              <span
                v-if="item.type === 'ellipsis'"
                class="ellipsis"
              >…</span>
              <button
                v-else
                :class="{ active: item.page === currentPage }"
                :aria-current="item.page === currentPage ? 'page' : undefined"
                @click="goToPage(item.page)"
              >
                {{ item.page }}
              </button>
            </template>
            <button
              aria-label="下一页"
              :disabled="currentPage >= totalPages"
              @click="goToPage(currentPage + 1)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              ><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </nav>
        </footer>
      </section>
    </div>
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'RecordsView' }</script>

<style scoped>
.records-page { width: min(100%, 1540px); min-height: 100vh; margin: 0 auto; padding: 34px 38px 48px; overflow-y: auto; color: #111827; }
.records-heading { margin-bottom: 28px; }
.breadcrumb { margin: 0 0 30px; color: #53627a; font-size: 13px; }
.breadcrumb span { margin: 0 10px; color: #a8b1bf; }
.heading-row { display: flex; align-items: center; justify-content: space-between; gap: 28px; }
.heading-copy { display: flex; min-width: 0; align-items: center; gap: 18px; }
.heading-copy h1 { margin: 0; color: #0b1222; font-size: clamp(34px, 3.2vw, 46px); font-weight: 680; letter-spacing: -.045em; line-height: 1; white-space: nowrap; }
.heading-divider { width: 1px; height: 36px; flex: 0 0 auto; background: #cbd5e1; }
.heading-copy p { margin: 0; color: #526174; font-size: 14px; white-space: nowrap; }
.new-consult-button { display: inline-flex; min-width: 136px; height: 44px; padding: 0 16px; align-items: center; justify-content: center; gap: 8px; border: 1px solid #0f5fff; border-radius: 6px; background: #0f5fff; color: #fff; font: inherit; font-size: 14px; font-weight: 620; cursor: pointer; transition: background 160ms ease, transform 160ms ease; }
.new-consult-button:hover { transform: translateY(-1px); background: #004dcc; }
.new-consult-button svg { width: 18px; height: 18px; }
.summary-grid { display: grid; overflow: hidden; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 24px; border: 1px solid #dce3ec; border-radius: 8px; background: #fff; }
.summary-cell { position: relative; display: grid; min-height: 112px; padding: 24px 34px; align-content: space-between; gap: 14px; }
.summary-cell + .summary-cell::before { position: absolute; inset: 22px auto 22px 0; width: 1px; background: #dce3ec; content: ""; }
.summary-cell span { color: #526174; font-size: 13px; }
.summary-cell strong { color: #0f172a; font-size: 34px; font-weight: 620; letter-spacing: -.04em; line-height: 1; }
.records-toolbar { display: flex; scroll-margin-top: 20px; margin-bottom: 12px; align-items: stretch; justify-content: space-between; gap: 24px; }
.records-toolbar > nav { display: grid; min-width: 560px; overflow: hidden; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #d7dfea; border-radius: 7px; background: #fff; }
.records-toolbar > nav button { position: relative; min-height: 52px; border: 0; border-left: 1px solid #e5eaf1; background: #fff; color: #4b5568; font: inherit; font-size: 14px; cursor: pointer; }
.records-toolbar > nav button:first-child { border-left: 0; }
.records-toolbar > nav button::after { position: absolute; inset: auto 0 0; height: 3px; background: transparent; content: ""; }
.records-toolbar > nav button:hover:not(:disabled) { background: #f8fafc; color: #2563eb; }
.records-toolbar > nav button.active { color: #2563eb; }
.records-toolbar > nav button.active::after { background: #2563eb; }
.records-toolbar > nav button span { margin-left: 7px; font-weight: 600; }
.filters { display: flex; min-width: 430px; gap: 12px; }
.search-field,
.kind-filter { display: flex; height: 52px; align-items: center; border: 1px solid #d7dfea; border-radius: 7px; background: #fff; color: #66758b; }
.search-field { min-width: 268px; padding: 0 14px; gap: 9px; }
.search-field svg { width: 18px; height: 18px; flex: 0 0 auto; }
.search-field input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: #24324a; font: inherit; font-size: 13px; }
.search-field input::placeholder { color: #8a96a8; }
.kind-filter { position: relative; min-width: 150px; }
.kind-filter select { width: 100%; height: 100%; padding: 0 38px 0 16px; appearance: none; border: 0; outline: 0; background: transparent; color: #334155; font: inherit; font-size: 13px; cursor: pointer; }
.kind-filter > svg { position: absolute; right: 13px; width: 17px; height: 17px; pointer-events: none; }
.records-table-section { min-width: 0; }
.records-table { overflow-x: auto; border: 1px solid #dce3ec; border-radius: 7px 7px 0 0; background: #fff; }
.table-head,
.record-row,
.skeleton-row { display: grid; min-width: 1050px; grid-template-columns: 82px minmax(280px, 2.4fr) 76px 168px 168px 92px 24px; align-items: center; column-gap: 18px; }
.table-head { min-height: 48px; padding: 0 24px; border-bottom: 1px solid #e5eaf1; color: #69768a; font-size: 12px; font-weight: 650; }
.record-row { width: 100%; min-height: 58px; padding: 0 24px; border: 0; border-bottom: 1px solid #e8edf3; background: #fff; color: #40506a; font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: background 150ms ease, box-shadow 150ms ease; }
.record-row:last-child { border-bottom: 0; }
.record-row:hover,
.record-row:focus-visible { position: relative; z-index: 1; outline: 0; background: #f7faff; box-shadow: inset 3px 0 0 #2563eb, 0 0 0 1px #2563eb; }
.record-title { overflow: hidden; color: #1f2937; font-size: 13px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.kind-tag,
.risk-tag { display: inline-flex; width: max-content; min-width: 37px; min-height: 25px; padding: 0 7px; align-items: center; justify-content: center; border-radius: 5px; font-style: normal; font-size: 11px; font-weight: 650; }
.kind-consult { background: #eaf3ff; color: #2563eb; }
.kind-contract { background: #eaf8ef; color: #159447; }
.kind-research { background: #eef0ff; color: #4f5edb; }
.kind-draft { background: #fff4e5; color: #b86a00; }
.risk-tag { min-width: 32px; min-height: 23px; border: 1px solid currentColor; background: #fff; }
.risk-P0 { color: #e11d48; }
.risk-P1 { color: #f97316; }
.risk-P2 { color: #2563eb; }
.status-cell { font-weight: 650; }
.status-info,
.status-warning { color: #2563eb; }
.status-success { color: #159447; }
.status-neutral { color: #64748b; }
.row-arrow { display: grid; place-items: center; color: #64748b; }
.row-arrow svg { width: 17px; height: 17px; }
.loading-table { min-height: 628px; }
.skeleton-row { min-height: 58px; padding: 0 24px; border-bottom: 1px solid #e8edf3; }
.skeleton-row i { height: 11px; border-radius: 3px; background: linear-gradient(90deg, #edf1f5 25%, #f8fafc 50%, #edf1f5 75%); background-size: 200% 100%; animation: loading-shimmer 1.25s linear infinite; }
@keyframes loading-shimmer { to { background-position: -200% 0; } }
.empty-state { display: grid; min-height: 420px; place-items: center; align-content: center; gap: 8px; border: 1px solid #dce3ec; border-radius: 7px 7px 0 0; background: #fff; text-align: center; }
.empty-icon { display: grid; width: 48px; height: 48px; margin-bottom: 4px; border: 1px solid #d7e1f0; border-radius: 9px; place-items: center; background: #f5f8fc; color: #2563eb; }
.empty-icon svg { width: 24px; height: 24px; }
.empty-state strong { color: #334155; font-size: 15px; }
.empty-state p { margin: 0; color: #7b8798; font-size: 12px; }
.pagination-footer { display: flex; min-height: 60px; padding: 10px 18px; align-items: center; justify-content: space-between; gap: 18px; border: 1px solid #dce3ec; border-top: 0; border-radius: 0 0 7px 7px; background: #fff; }
.pagination-footer > span { color: #718096; font-size: 12px; }
.pagination-footer nav { display: flex; align-items: center; gap: 7px; }
.pagination-footer button { display: grid; min-width: 34px; height: 34px; padding: 0 9px; border: 1px solid #d7dfea; border-radius: 6px; place-items: center; background: #fff; color: #475569; font: inherit; font-size: 12px; }
.pagination-footer button:hover:not(:disabled) { border-color: #8da8d7; color: #2563eb; }
.pagination-footer button.active { border-color: #2563eb; color: #2563eb; box-shadow: inset 0 0 0 1px #2563eb; }
.pagination-footer button:disabled { opacity: .4; cursor: not-allowed; }
.pagination-footer svg { width: 16px; height: 16px; }
.ellipsis { min-width: 24px; color: #94a3b8; text-align: center; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 1220px) {
  .records-page { padding-right: 26px; padding-left: 26px; }
  .heading-copy p,
  .heading-divider { display: none; }
  .records-toolbar { align-items: stretch; flex-direction: column; }
  .records-toolbar > nav { min-width: 0; }
  .filters { min-width: 0; justify-content: flex-end; }
}

@media (max-width: 760px) {
  .records-page { padding: 24px 18px 38px; }
  .breadcrumb { margin-bottom: 24px; }
  .heading-copy h1 { font-size: 32px; }
  .new-consult-button { min-width: 44px; padding: 0 12px; font-size: 0; }
  .new-consult-button svg { width: 20px; height: 20px; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-cell { min-height: 96px; padding: 20px; }
  .summary-cell:nth-child(3)::before { display: none; }
  .records-toolbar > nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filters { flex-direction: column; }
  .search-field,
  .kind-filter { min-width: 0; width: 100%; }
  .pagination-footer { align-items: flex-start; flex-direction: column; }
}
</style>
