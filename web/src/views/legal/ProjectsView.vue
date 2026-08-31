<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'
import { useRouter } from 'vue-router'
import { request } from '../../api/client'
import ErrorState from '../../components/ErrorState.vue'
import LegalWorkspaceLayout from '../../components/LegalWorkspaceLayout.vue'
import { useRemoteData } from '../../composables/useRemoteData'
import { buildPagination } from '../../domain/legal-research'
import { statusLabel } from '../../domain/project-status'
import type { ProjectGroupKey, ProjectListItem, ProjectListResponse } from '../../types'

const PAGE_SIZE = 10
const GROUPS: Array<{ key: ProjectGroupKey; label: string }> = [
  { key: '待处理', label: '待处理' },
  { key: '合同协作', label: '合同协作' },
  { key: '已回传', label: '已完成' },
  { key: '数字分身处理', label: 'AI 处理' },
]

const router = useRouter()
const pageRoot = ref<HTMLElement | null>(null)
const activeGroup = ref<ProjectGroupKey>('待处理')
const currentPage = ref(1)
let animationContext: gsap.Context | null = null

const remote = useRemoteData(() => request<ProjectListResponse>(
  `/projects?group=${encodeURIComponent(activeGroup.value)}&page=${currentPage.value}&size=${PAGE_SIZE}`,
))

const loading = computed(() => remote.status.value === 'loading')
const items = computed(() => remote.data.value?.items ?? [])
const groupCounts = computed<Record<ProjectGroupKey, number>>(() => remote.data.value?.groupCounts ?? {
  待处理: 0,
  合同协作: 0,
  已回传: 0,
  数字分身处理: 0,
})
const allCount = computed(() => Object.values(groupCounts.value).reduce((sum, count) => sum + count, 0))
const totalPages = computed(() => Math.max(1, Math.ceil((remote.data.value?.total ?? 0) / PAGE_SIZE)))
const pagination = computed(() => buildPagination(currentPage.value, totalPages.value))

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

async function animateRows() {
  if (reducedMotion()) return
  await nextTick()
  animationContext?.add(() => {
    gsap.fromTo(
      '.project-row',
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.045, ease: 'power2.out', overwrite: true },
    )
  })
}

async function loadProjects() {
  await remote.load()
  const maximumPage = Math.max(1, Math.ceil((remote.data.value?.total ?? 0) / PAGE_SIZE))
  if (currentPage.value > maximumPage) {
    currentPage.value = maximumPage
    await remote.load()
  }
  await animateRows()
}

async function selectGroup(group: ProjectGroupKey) {
  if (loading.value || group === activeGroup.value) return
  activeGroup.value = group
  currentPage.value = 1
  await loadProjects()
}

async function goToPage(page: number) {
  if (loading.value || page === currentPage.value || page < 1 || page > totalPages.value) return
  currentPage.value = page
  await loadProjects()
  pageRoot.value?.querySelector('.queue-heading')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

const kindLabel = (kind: ProjectListItem['kind']) => ({
  consult: '咨询',
  contract: '合同',
  research: '检索',
  draft: '文书',
})[kind]

const requester = (project: ProjectListItem) => project.requesterName || project.creator.displayName
const assignee = (project: ProjectListItem) => project.legalBp?.displayName || project.owner.displayName

const formatTime = (value: string) => {
  const time = new Date(value).getTime()
  const delta = Date.now() - time
  if (delta >= 0 && delta < 60_000) return '刚刚'
  if (delta >= 0 && delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  if (delta >= 0 && delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

onMounted(async () => {
  if (pageRoot.value) {
    animationContext = gsap.context(() => {
      if (reducedMotion()) return
      gsap.from('.page-heading > *', {
        autoAlpha: 0,
        y: 18,
        duration: 0.62,
        stagger: 0.08,
        ease: 'power2.out',
      })
    }, pageRoot.value)
  }
  await loadProjects()
})

onBeforeUnmount(() => animationContext?.revert())
</script>

<template>
  <LegalWorkspaceLayout active-key="projects">
    <div
      ref="pageRoot"
      class="projects-page"
    >
      <header class="page-heading">
        <p class="breadcrumb">
          法务工作台 <span>/</span> 工单管理
        </p>
        <div class="heading-row">
          <div class="heading-copy">
            <h1>工单管理</h1>
            <span class="workload-total">
              <small>全部工单</small>
              <strong>{{ allCount }}</strong>
            </span>
          </div>
          <button
            class="refresh-button"
            :disabled="loading"
            @click="loadProjects"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><path d="M20 7h-5V2" /><path d="M20 2 9.5 12.5a5 5 0 1 0 7 7L20 16" /></svg>
            {{ loading ? '刷新中' : '刷新工单' }}
          </button>
        </div>
      </header>

      <nav
        class="workflow-tabs"
        aria-label="工单分组"
      >
        <button
          v-for="group in GROUPS"
          :key="group.key"
          :class="{ active: activeGroup === group.key }"
          :aria-current="activeGroup === group.key ? 'page' : undefined"
          :disabled="loading"
          @click="selectGroup(group.key)"
        >
          <span>{{ group.label }}</span>
          <strong>{{ groupCounts[group.key] }}</strong>
        </button>
      </nav>

      <section class="queue-section">
        <div class="queue-heading">
          <h2>{{ activeGroup === '待处理' ? '优先处理' : GROUPS.find(group => group.key === activeGroup)?.label }}</h2>
          <span v-if="remote.data.value">共 {{ remote.data.value.total }} 条，每页 {{ PAGE_SIZE }} 条</span>
        </div>

        <div
          v-if="loading"
          class="project-table loading-table"
          aria-label="正在加载工单"
        >
          <div
            class="table-head"
            aria-hidden="true"
          >
            <span>类型</span><span>标题</span><span>风险</span><span>申请人</span><span>负责人</span><span>更新时间</span><span>状态</span>
          </div>
          <div
            v-for="index in 6"
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
          :message="remote.error.value?.payload.error || '工单加载失败，请重试'"
          :request-id="remote.requestId.value"
          :on-retry="loadProjects"
        />

        <div
          v-else-if="items.length === 0"
          class="empty-state"
        >
          <span
            class="empty-document"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
            ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>
          </span>
          <strong>该分组暂无工单</strong>
          <p>新工单进入该流程后会显示在这里。</p>
        </div>

        <div
          v-else
          class="project-table"
          role="table"
          aria-label="工单列表"
        >
          <div
            class="table-head"
            role="row"
          >
            <span role="columnheader">类型</span>
            <span role="columnheader">标题</span>
            <span role="columnheader">风险</span>
            <span role="columnheader">申请人</span>
            <span role="columnheader">负责人</span>
            <span role="columnheader">更新时间</span>
            <span role="columnheader">状态</span>
          </div>
          <button
            v-for="project in items"
            :key="project.id"
            class="project-row"
            role="row"
            :aria-label="`查看工单：${project.title}`"
            @click="router.push(`/legal/projects/${project.id}`)"
          >
            <span role="cell"><i :class="['kind-tag', `kind-${project.kind}`]">{{ kindLabel(project.kind) }}</i></span>
            <span
              class="project-title"
              role="cell"
            >{{ project.title }}<small v-if="project.isFailed">处理异常</small></span>
            <span role="cell"><i :class="['risk-tag', `risk-${project.risk}`]">{{ project.risk }}</i></span>
            <span role="cell">{{ requester(project) }}</span>
            <span role="cell">{{ assignee(project) }}</span>
            <span role="cell">{{ formatTime(project.updatedAt || project.createdAt) }}</span>
            <span
              class="status-cell"
              role="cell"
            >{{ statusLabel(project.status) }}</span>
          </button>
        </div>

        <footer
          v-if="!loading && remote.status.value === 'success' && remote.data.value && remote.data.value.total > PAGE_SIZE"
          class="pagination-footer"
        >
          <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
          <nav aria-label="工单分页">
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
              ><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </nav>
        </footer>
      </section>
    </div>
  </LegalWorkspaceLayout>
</template>

<script lang="ts">export default { name: 'ProjectsView' }</script>

<style scoped>
.projects-page { width: min(100%, 1540px); min-height: 100vh; margin: 0 auto; padding: 24px 38px 40px; color: #111827; }
.page-heading { margin-bottom: 18px; }
.breadcrumb { margin: 0 0 14px; color: #64748B; font-size: 12px; }
.breadcrumb span { margin: 0 10px; color: #A8B1BF; }
.heading-row { display: flex; align-items: center; justify-content: space-between; gap: 28px; }
.heading-copy { display: flex; min-width: 0; align-items: center; gap: 16px; }
.heading-copy h1 { margin: 0; color: #0B1222; font-size: clamp(32px, 2.7vw, 40px); font-weight: 680; letter-spacing: -0.045em; line-height: 1; white-space: nowrap; }
.workload-total { display: inline-flex; min-height: 34px; padding: 0 11px; align-items: center; gap: 8px; border-left: 1px solid #CBD5E1; color: #64748B; }
.workload-total small { font-size: 12px; font-weight: 520; }
.workload-total strong { color: #1D4ED8; font-size: 18px; font-weight: 680; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.refresh-button { display: inline-flex; min-width: 112px; height: 38px; padding: 0 14px; align-items: center; justify-content: center; gap: 7px; border: 1px solid #C7D2E2; border-radius: 7px; background: #FFFFFF; color: #334155; font: inherit; font-size: 13px; font-weight: 600; transition: border-color 180ms ease, color 180ms ease, transform 180ms ease; }
.refresh-button:hover:not(:disabled) { transform: translateY(-1px); border-color: #93B0E5; color: #2563EB; }
.refresh-button:active:not(:disabled) { transform: translateY(0) scale(.98); }
.refresh-button:focus-visible { outline: 2px solid #93C5FD; outline-offset: 2px; }
.refresh-button:disabled { opacity: 0.55; cursor: wait; }
.refresh-button svg { width: 16px; height: 16px; }
.workflow-tabs { display: grid; overflow: hidden; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 18px; border: 1px solid #D7DFEA; border-radius: 7px; background: #FFFFFF; }
.workflow-tabs button { position: relative; display: flex; min-height: 50px; align-items: center; justify-content: center; gap: 9px; border: 0; border-left: 1px solid #E5EAF1; background: #FFFFFF; color: #4B5568; font: inherit; font-size: 14px; transition: background 180ms ease, color 180ms ease, transform 180ms ease; }
.workflow-tabs button:first-child { border-left: 0; }
.workflow-tabs button::after { position: absolute; inset: auto 0 0; height: 2px; background: transparent; content: ""; }
.workflow-tabs button:hover:not(:disabled) { background: #F8FAFC; color: #2563EB; }
.workflow-tabs button.active { background: #F5F8FF; color: #2563EB; }
.workflow-tabs button.active::after { background: #2563EB; }
.workflow-tabs button:active:not(:disabled) { transform: scale(.99); }
.workflow-tabs button:focus-visible { z-index: 1; outline: 2px solid #93C5FD; outline-offset: -2px; }
.workflow-tabs button strong { min-width: 22px; padding: 2px 6px; border-radius: 4px; background: #F1F5F9; color: #64748B; font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.workflow-tabs button.active strong { background: #DBEAFE; color: #1D4ED8; }
.workflow-tabs button:disabled { cursor: wait; }
.queue-heading { display: flex; scroll-margin-top: 18px; margin: 0 0 10px; align-items: baseline; justify-content: space-between; gap: 20px; }
.queue-heading h2 { margin: 0; color: #111827; font-size: 19px; font-weight: 680; letter-spacing: -0.02em; }
.queue-heading span { color: #7B8798; font-size: 12px; }
.project-table { overflow-x: auto; border: 1px solid #DCE3EC; border-radius: 7px; background: #FFFFFF; }
.table-head, .project-row, .skeleton-row { display: grid; grid-template-columns: 92px minmax(260px, 2.4fr) 88px minmax(100px, .8fr) minmax(100px, .8fr) 126px 98px; align-items: center; column-gap: 18px; }
.table-head { min-width: 1010px; min-height: 46px; padding: 0 22px; border-bottom: 1px solid #E5EAF1; color: #69768A; font-size: 12px; font-weight: 650; }
.project-row { width: 100%; min-width: 1010px; min-height: 62px; padding: 0 22px; border: 0; border-bottom: 1px solid #E8EDF3; background: #FFFFFF; color: #334155; font: inherit; font-size: 13px; text-align: left; transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
.project-row:last-child { border-bottom: 0; }
.project-row:hover, .project-row:focus-visible { position: relative; z-index: 1; outline: 0; background: #F7FAFF; box-shadow: inset 3px 0 0 #2563EB, 0 0 0 1px #2563EB; }
.project-title { overflow: hidden; color: #1F2937; font-size: 14px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.project-title small { margin-left: 10px; color: #DC2626; font-size: 10px; font-weight: 650; }
.kind-tag, .risk-tag { display: inline-flex; width: max-content; min-width: 38px; min-height: 27px; padding: 0 8px; align-items: center; justify-content: center; border-radius: 5px; font-style: normal; font-size: 12px; font-weight: 650; }
.kind-consult { background: #EAF3FF; color: #2563EB; }
.kind-contract { background: #EAF8EF; color: #159447; }
.kind-research { background: #EEF0FF; color: #4F5EDB; }
.kind-draft { background: #FFF4E5; color: #B86A00; }
.risk-tag { min-width: 34px; min-height: 25px; border: 1px solid currentColor; background: #FFFFFF; }
.risk-P0 { color: #E11D48; }
.risk-P1 { color: #F97316; }
.risk-P2 { color: #2563EB; }
.status-cell { color: #2563EB; font-weight: 650; }
.loading-table { min-height: 418px; }
.skeleton-row { min-width: 1010px; min-height: 62px; padding: 0 22px; border-bottom: 1px solid #E8EDF3; }
.skeleton-row i { height: 12px; border-radius: 4px; background: linear-gradient(90deg, #EDF1F5 25%, #F8FAFC 50%, #EDF1F5 75%); background-size: 200% 100%; animation: loading-shimmer 1.25s linear infinite; }
@keyframes loading-shimmer { to { background-position: -200% 0; } }
.empty-state { display: grid; min-height: 360px; place-items: center; align-content: center; gap: 8px; border: 1px solid #DCE3EC; border-radius: 7px; background: #FFFFFF; text-align: center; }
.empty-document { display: grid; width: 48px; height: 48px; margin-bottom: 4px; border: 1px solid #D7E1F0; border-radius: 9px; place-items: center; background: #F5F8FC; color: #2563EB; }
.empty-document svg { width: 24px; height: 24px; }
.empty-state strong { color: #334155; font-size: 15px; }
.empty-state p { margin: 0; color: #7B8798; font-size: 12px; }
.pagination-footer { display: flex; min-height: 58px; padding: 10px 16px; align-items: center; justify-content: space-between; gap: 18px; border: 1px solid #DCE3EC; border-top: 0; border-radius: 0 0 7px 7px; background: #FFFFFF; }
.pagination-footer > span { color: #7B8798; font-size: 12px; }
.pagination-footer nav { display: flex; align-items: center; gap: 7px; }
.pagination-footer button { display: grid; min-width: 34px; height: 34px; padding: 0 9px; border: 1px solid #D7DFEA; border-radius: 6px; place-items: center; background: #FFFFFF; color: #475569; font: inherit; font-size: 12px; }
.pagination-footer button:hover:not(:disabled) { border-color: #8DA8D7; color: #2563EB; }
.pagination-footer button.active { border-color: #2563EB; color: #2563EB; box-shadow: inset 0 0 0 1px #2563EB; }
.pagination-footer button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination-footer svg { width: 16px; height: 16px; }
.ellipsis { min-width: 24px; color: #94A3B8; text-align: center; }
@media (max-width: 1180px) { .projects-page { padding-right: 26px; padding-left: 26px; } }
@media (max-width: 760px) {
  .projects-page { padding: 20px 18px 34px; }
  .breadcrumb { margin-bottom: 14px; }
  .heading-row { align-items: flex-start; }
  .heading-copy h1 { font-size: 32px; }
  .workload-total small { display: none; }
  .refresh-button { min-width: 44px; padding: 0 12px; font-size: 0; }
  .refresh-button svg { width: 18px; height: 18px; }
  .workflow-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workflow-tabs button:nth-child(3) { border-top: 1px solid #E5EAF1; border-left: 0; }
  .workflow-tabs button:nth-child(4) { border-top: 1px solid #E5EAF1; }
  .project-table { overflow-x: auto; }
  .pagination-footer { align-items: flex-start; flex-direction: column; }
}
</style>
