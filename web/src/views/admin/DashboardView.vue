<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'
import { RequestError, request } from '../../api/client'
import LegalWorkspaceLayout from '../../components/LegalWorkspaceLayout.vue'
import ErrorState from '../../components/ErrorState.vue'

type TrendItem = { date: string; created: number; returned: number }
type WorkloadItem = { id: string; name: string; count: number; level: 'busy' | 'normal' | 'idle' }
type ActivityItem = {
  id: string
  tone: 'success' | 'info' | 'warning' | 'danger'
  text: string
  occurredAt: string
}
type DashboardData = {
  period: { days: 7 | 30; from: string; to: string }
  summary: { createdToday: number; pending: number; highRisk: number; aiHandlingRate: number }
  trend: TrendItem[]
  attention: { highRisk: number; stale: number; evidenceFailures: number }
  workload: WorkloadItem[]
  activities: ActivityItem[]
}

const pageRoot = ref<HTMLElement | null>(null)
const days = ref<7 | 30>(30)
const data = ref<DashboardData | null>(null)
const loading = ref(false)
const error = ref<RequestError | null>(null)
let requestSequence = 0
let animationContext: gsap.Context | null = null

const chartWidth = 760
const chartHeight = 220
const chartPadding = { top: 15, right: 14, bottom: 36, left: 42 }

const chart = computed(() => {
  const items = data.value?.trend ?? []
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom
  const highest = Math.max(1, ...items.flatMap(item => [item.created, item.returned]))
  const maximum = highest <= 5 ? 5 : Math.ceil(highest / 10) * 10
  const point = (value: number, index: number) => ({
    x: chartPadding.left + (items.length > 1 ? (index / (items.length - 1)) * plotWidth : plotWidth / 2),
    y: chartPadding.top + plotHeight - (value / maximum) * plotHeight,
  })
  const createdPoints = items.map((item, index) => ({ ...point(item.created, index), value: item.created }))
  const returnedPoints = items.map((item, index) => ({ ...point(item.returned, index), value: item.returned }))
  const path = (points: Array<{ x: number; y: number }>) => points
    .map((item, index) => `${index ? 'L' : 'M'} ${item.x.toFixed(2)} ${item.y.toFixed(2)}`)
    .join(' ')
  const createdPath = path(createdPoints)
  const baseY = chartPadding.top + plotHeight
  const areaPath = createdPoints.length
    ? `${createdPath} L ${createdPoints.at(-1)!.x.toFixed(2)} ${baseY} L ${createdPoints[0].x.toFixed(2)} ${baseY} Z`
    : ''
  const labelStep = Math.max(1, Math.ceil(items.length / 6))
  const xLabels = items
    .map((item, index) => ({ index, x: point(0, index).x, label: item.date.slice(5) }))
    .filter((item, index) => index === 0 || index === items.length - 1 || item.index % labelStep === 0)
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = Math.round((maximum / 4) * (4 - index))
    return { value, y: chartPadding.top + (plotHeight / 4) * index }
  })
  return { createdPath, returnedPath: path(returnedPoints), areaPath, createdPoints, returnedPoints, xLabels, yTicks }
})

const maximumWorkload = computed(() => Math.max(1, ...(data.value?.workload.map(item => item.count) ?? [])))
const attentionItems = computed(() => [
  { label: 'P0 高风险', value: data.value?.attention.highRisk ?? 0, tone: 'danger' },
  { label: '超过 24 小时未更新', value: data.value?.attention.stale ?? 0, tone: 'warning' },
  { label: '证据核验降级 / 失败', value: data.value?.attention.evidenceFailures ?? 0, tone: 'info' },
])

async function loadDashboard() {
  const sequence = ++requestSequence
  loading.value = true
  error.value = null
  try {
    const result = await request<DashboardData>(`/admin/dashboard?days=${days.value}`)
    if (sequence !== requestSequence) return
    data.value = result
    await animateCards()
  } catch (reason) {
    if (sequence !== requestSequence) return
    if (data.value) days.value = data.value.period.days
    error.value = reason instanceof RequestError
      ? reason
      : new RequestError({ error: '看板数据加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

async function changeDays(value: 7 | 30) {
  if (value === days.value || loading.value) return
  days.value = value
  await loadDashboard()
}

async function animateCards() {
  await nextTick()
  if (!pageRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  animationContext?.revert()
  animationContext = gsap.context(() => {
    gsap.from('.dashboard-heading > *, .summary-cell', {
      autoAlpha: 0,
      y: 12,
      duration: .42,
      stagger: .045,
      ease: 'power2.out',
    })
    gsap.from('.dashboard-card', {
      autoAlpha: 0,
      y: 14,
      duration: .48,
      stagger: .06,
      delay: .08,
      ease: 'power2.out',
    })
  }, pageRoot.value)
}

function workloadWidth(count: number) {
  if (!count) return '0%'
  return `${Math.max(10, Math.round((count / maximumWorkload.value) * 100))}%`
}

function levelLabel(level: WorkloadItem['level']) {
  return ({ busy: '繁忙', normal: '适中', idle: '空闲' })[level]
}

function formatActivityTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}


onMounted(loadDashboard)
onBeforeUnmount(() => {
  requestSequence++
  animationContext?.revert()
})
</script>

<template>
  <LegalWorkspaceLayout active-key="dashboard">
    <section
      ref="pageRoot"
      class="dashboard-page"
    >
      <p class="dashboard-breadcrumb">
        管理工作台 <span>/</span> 数据看板
      </p>
      <header class="dashboard-heading">
        <div><h1>数据看板</h1><p>聚合工单、风险、团队负载与平台运行态势</p></div>
        <div class="heading-actions">
          <label class="range-select">
            <span class="sr-only">统计周期</span>
            <select
              v-model.number="days"
              :disabled="loading"
              @change="loadDashboard"
            >
              <option :value="7">近 7 日</option><option :value="30">近 30 日</option>
            </select>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="m7 10 5 5 5-5" /></svg>
          </label>
          <button
            class="refresh-button"
            :disabled="loading"
            @click="loadDashboard"
          >
            <svg
              :class="{ spinning: loading }"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="M20 11a8 8 0 0 0-15-3M4 4v4h4M4 13a8 8 0 0 0 15 3M20 20v-4h-4" /></svg>
            {{ loading ? '正在刷新' : '刷新数据' }}
          </button>
        </div>
      </header>

      <ErrorState
        v-if="error"
        class="dashboard-error"
        :message="error.payload.error"
        :request-id="error.payload.requestId"
        :on-retry="loadDashboard"
      />

      <template v-if="data || !error">
        <section
          class="summary-grid"
          aria-label="平台核心指标"
        >
          <div class="summary-cell">
            <span>今日新建</span><strong>{{ data?.summary.createdToday ?? '—' }}</strong>
          </div>
          <div class="summary-cell">
            <span>待处理</span><strong>{{ data?.summary.pending ?? '—' }}</strong>
          </div>
          <div class="summary-cell danger">
            <span>高风险</span><strong>{{ data?.summary.highRisk ?? '—' }}</strong>
          </div>
          <div class="summary-cell">
            <span>AI 处理率</span><strong>{{ data ? `${data.summary.aiHandlingRate}%` : '—' }}</strong>
          </div>
        </section>

        <section class="dashboard-grid dashboard-grid-primary">
          <article class="dashboard-card trend-card">
            <div class="card-heading">
              <div><h2>工单趋势</h2><span>新建与已完成工单的每日变化</span></div>
              <div
                class="range-tabs"
                aria-label="趋势周期"
              >
                <button
                  :class="{ active: days === 7 }"
                  :disabled="loading"
                  @click="changeDays(7)"
                >
                  近 7 日
                </button>
                <button
                  :class="{ active: days === 30 }"
                  :disabled="loading"
                  @click="changeDays(30)"
                >
                  近 30 日
                </button>
              </div>
            </div>
            <div class="chart-legend">
              <span><i class="created" />新建工单</span><span><i class="returned" />已完成</span>
            </div>
            <div class="chart-shell">
              <svg
                :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
                role="img"
                aria-label="工单趋势折线图"
              >
                <defs>
                  <linearGradient
                    id="created-area"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stop-color="#1764ef"
                      stop-opacity=".16"
                    /><stop
                      offset="100%"
                      stop-color="#1764ef"
                      stop-opacity="0"
                    />
                  </linearGradient>
                </defs>
                <g class="grid-lines">
                  <g
                    v-for="tick in chart.yTicks"
                    :key="tick.value"
                  >
                    <line
                      :x1="chartPadding.left"
                      :x2="chartWidth - chartPadding.right"
                      :y1="tick.y"
                      :y2="tick.y"
                    />
                    <text
                      :x="chartPadding.left - 10"
                      :y="tick.y + 4"
                    >{{ tick.value }}</text>
                  </g>
                </g>
                <path
                  v-if="chart.areaPath"
                  :d="chart.areaPath"
                  fill="url(#created-area)"
                />
                <path
                  v-if="chart.createdPath"
                  class="trend-line created-line"
                  :d="chart.createdPath"
                />
                <path
                  v-if="chart.returnedPath"
                  class="trend-line returned-line"
                  :d="chart.returnedPath"
                />
                <g class="trend-points created-points">
                  <circle
                    v-for="(point, index) in chart.createdPoints"
                    :key="`created-${index}`"
                    :cx="point.x"
                    :cy="point.y"
                    r="2.7"
                  ><title>{{ data?.trend[index]?.date }} 新建 {{ point.value }}</title></circle>
                </g>
                <g class="trend-points returned-points">
                  <circle
                    v-for="(point, index) in chart.returnedPoints"
                    :key="`returned-${index}`"
                    :cx="point.x"
                    :cy="point.y"
                    r="2.4"
                  ><title>{{ data?.trend[index]?.date }} 已完成 {{ point.value }}</title></circle>
                </g>
                <g class="x-labels"><text
                  v-for="item in chart.xLabels"
                  :key="`${item.index}-${item.label}`"
                  :x="item.x"
                  :y="chartHeight - 10"
                >{{ item.label }}</text></g>
              </svg>
              <div
                v-if="!data?.trend.length"
                class="chart-empty"
              >
                暂无趋势数据
              </div>
            </div>
          </article>

          <article class="dashboard-card attention-card">
            <div class="card-heading">
              <div><h2>需要关注</h2><span>当前需要优先处理的平台事项</span></div>
            </div>
            <div class="attention-list">
              <div
                v-for="item in attentionItems"
                :key="item.label"
                :class="['attention-item', item.tone]"
              >
                <span><i />{{ item.label }}</span><strong>{{ item.value }}</strong><em>需关注</em>
              </div>
            </div>
          </article>
        </section>

        <section class="dashboard-grid dashboard-grid-secondary">
          <article class="dashboard-card workload-card">
            <div class="card-heading">
              <div><h2>法务团队负载</h2><span>当前处理中工单数</span></div>
            </div>
            <div
              v-if="data?.workload.length"
              class="workload-table"
            >
              <div class="workload-head">
                <span>成员</span><span>负载数</span><span>负载状态</span>
              </div>
              <div
                v-for="member in data.workload"
                :key="member.id"
                class="workload-row"
              >
                <span class="workload-member"><i>{{ member.name[0] }}</i><strong>{{ member.name }}</strong></span>
                <span class="workload-value"><b>{{ member.count }}</b><i><em :style="{ width: workloadWidth(member.count) }" /></i></span>
                <span :class="['workload-level', member.level]">{{ levelLabel(member.level) }}</span>
              </div>
            </div>
            <div
              v-else
              class="card-empty"
            >
              暂无可展示的法务成员
            </div>
          </article>

          <article class="dashboard-card activity-card">
            <div class="card-heading">
              <div><h2>平台动态</h2><span>来自平台审计事件的最新操作</span></div>
            </div>
            <div
              v-if="data?.activities.length"
              class="activity-list"
            >
              <div
                v-for="activity in data.activities"
                :key="activity.id"
                class="activity-row"
              >
                <i :class="activity.tone" /><span>{{ activity.text }}</span><time :datetime="activity.occurredAt">{{ formatActivityTime(activity.occurredAt) }}</time>
              </div>
            </div>
            <div
              v-else
              class="card-empty"
            >
              暂无平台动态
            </div>
          </article>
        </section>
      </template>
    </section>
  </LegalWorkspaceLayout>
</template>

<script lang="ts">export default { name: 'DashboardView' }</script>

<style scoped>
.dashboard-page{height:100vh;padding:28px 38px 36px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.dashboard-breadcrumb{margin:0 0 22px;color:#5f6e84;font-size:13px}.dashboard-breadcrumb span{margin:0 9px;color:#a4adba}.dashboard-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}.dashboard-heading h1{margin:0 0 8px;color:#0b1222;font-size:38px;font-weight:690;letter-spacing:-.045em}.dashboard-heading p{margin:0;color:#66758a;font-size:13px}.heading-actions{display:flex;align-items:center;gap:10px}.range-select{position:relative;display:flex;width:112px;height:42px;align-items:center;border:1px solid #d4dce7;border-radius:6px;background:#fff}.range-select select{width:100%;height:100%;padding:0 34px 0 14px;appearance:none;border:0;outline:0;background:transparent;color:#405069;font:inherit;font-size:12px;cursor:pointer}.range-select svg{position:absolute;right:11px;width:16px;height:16px;pointer-events:none}.refresh-button{display:flex;height:42px;padding:0 15px;align-items:center;gap:8px;border:1px solid #1764ef;border-radius:6px;background:#1764ef;color:#fff;font:inherit;font-size:12px;font-weight:650;cursor:pointer}.refresh-button:hover:not(:disabled){background:#0755d8}.refresh-button:disabled{opacity:.68;cursor:wait}.refresh-button svg{width:17px;height:17px}.refresh-button svg.spinning{animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.dashboard-error{margin-top:24px}.summary-grid{display:grid;overflow:hidden;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:22px;border:1px solid #dce3ec;border-radius:8px;background:#fff}.summary-cell{position:relative;display:grid;min-height:92px;padding:18px 34px;align-content:space-between}.summary-cell+.summary-cell::before{position:absolute;inset:18px auto 18px 0;width:1px;background:#dfe5ed;content:""}.summary-cell span{color:#617086;font-size:12px}.summary-cell strong{color:#0f172a;font-size:30px;font-weight:650;letter-spacing:-.04em;line-height:1}.summary-cell.danger strong{color:#e23a1d}.dashboard-grid{display:grid;gap:14px;margin-top:14px}.dashboard-grid-primary{grid-template-columns:minmax(0,1.45fr) minmax(330px,.95fr)}.dashboard-grid-secondary{grid-template-columns:minmax(0,1.08fr) minmax(0,1fr)}.dashboard-card{min-width:0;border:1px solid #dce3ec;border-radius:8px;background:#fff}.card-heading{display:flex;min-height:60px;padding:17px 22px 10px;align-items:flex-start;justify-content:space-between;gap:18px}.card-heading h2{margin:0;color:#152033;font-size:15px;font-weight:680}.card-heading span{display:block;margin-top:5px;color:#8792a3;font-size:10px}.range-tabs{display:flex;overflow:hidden;border:1px solid #d4dce7;border-radius:5px}.range-tabs button{height:29px;padding:0 11px;border:0;border-left:1px solid #d4dce7;background:#fff;color:#68758a;font:inherit;font-size:10px;cursor:pointer}.range-tabs button:first-child{border-left:0}.range-tabs button.active{background:#eff5ff;color:#1764ef;box-shadow:inset 0 0 0 1px #1764ef}.range-tabs button:disabled{cursor:wait}.chart-legend{display:flex;padding:0 22px 3px;gap:22px;color:#657389;font-size:10px}.chart-legend span{display:flex;align-items:center;gap:7px}.chart-legend i{width:7px;height:7px;border-radius:50%}.chart-legend i.created{background:#1764ef}.chart-legend i.returned{background:#91b8f6}.chart-shell{position:relative;min-height:232px;padding:0 12px 8px}.chart-shell svg{display:block;width:100%;height:232px;overflow:visible}.grid-lines line{stroke:#e5eaf1;stroke-dasharray:3 4;stroke-width:1}.grid-lines text{fill:#8792a3;font-size:10px;text-anchor:end}.trend-line{fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:2}.created-line{stroke:#1764ef}.returned-line{stroke:#91b8f6}.trend-points circle{stroke:#fff;stroke-width:1.2}.created-points circle{fill:#1764ef}.returned-points circle{fill:#91b8f6}.x-labels text{fill:#8792a3;font-size:9px;text-anchor:middle}.chart-empty{position:absolute;inset:0;display:grid;place-items:center;color:#8792a3;font-size:11px}.attention-list{display:grid;padding:2px 18px 18px;gap:9px}.attention-item{display:grid;min-height:55px;padding:0 16px;grid-template-columns:1fr auto 65px;align-items:center;gap:13px;border:1px solid #dce3ec;border-radius:6px}.attention-item>span{display:flex;align-items:center;gap:11px;color:#273448;font-size:12px;font-weight:620}.attention-item>span i{width:8px;height:8px;border-radius:50%;background:#1764ef}.attention-item strong{font-size:14px;font-weight:680}.attention-item em{color:#1764ef;font-style:normal;font-size:10px;text-align:right}.attention-item.danger>span i{background:#e7311c}.attention-item.danger strong{color:#e7311c}.attention-item.warning>span i{background:#ed760f}.attention-item.warning strong{color:#ed760f}.workload-card,.activity-card{min-height:250px}.workload-table{padding:0 21px 16px}.workload-head,.workload-row{display:grid;grid-template-columns:160px minmax(180px,1fr) 72px;align-items:center;column-gap:20px}.workload-head{height:28px;border-bottom:1px solid #e4e9ef;color:#7b8798;font-size:10px}.workload-row{min-height:44px;border-bottom:1px solid #e9edf3}.workload-row:last-child{border-bottom:0}.workload-member{display:flex;align-items:center;gap:10px;min-width:0}.workload-member i{display:grid;width:28px;height:28px;flex:0 0 auto;border-radius:50%;place-items:center;background:#edf3ff;color:#1764ef;font-style:normal;font-size:10px;font-weight:700}.workload-member strong{overflow:hidden;color:#2c394d;font-size:11px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.workload-value{display:grid;grid-template-columns:22px 1fr;align-items:center;gap:9px}.workload-value b{color:#334155;font-size:11px;font-weight:620}.workload-value>i{display:block;overflow:hidden;height:6px;border-radius:99px;background:#e8edf3}.workload-value>i em{display:block;height:100%;border-radius:inherit;background:#1764ef}.workload-level{font-size:10px;text-align:right}.workload-level.busy{color:#dc4725}.workload-level.normal{color:#ed760f}.workload-level.idle{color:#1764ef}.activity-list{padding:0 21px 16px}.activity-row{display:grid;min-height:42px;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:11px;border-bottom:1px solid #e9edf3}.activity-row:last-child{border-bottom:0}.activity-row>i{width:7px;height:7px;border-radius:50%;background:#1764ef}.activity-row>i.success{background:#1ba765}.activity-row>i.warning{background:#ed760f}.activity-row>i.danger{background:#e7311c}.activity-row span{overflow:hidden;color:#344258;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.activity-row time{color:#8792a3;font-size:10px}.card-empty{display:grid;min-height:165px;place-items:center;color:#8792a3;font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1180px){.dashboard-grid-primary,.dashboard-grid-secondary{grid-template-columns:1fr}.chart-shell svg{height:auto}.workload-card,.activity-card{min-height:0}}
@media(max-width:820px){.dashboard-page{padding:22px 18px 30px}.dashboard-heading h1{font-size:32px}.dashboard-heading p{display:none}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-cell:nth-child(3)::before{display:none}.heading-actions{gap:7px}.refresh-button{width:42px;padding:0;justify-content:center;font-size:0}.workload-head,.workload-row{grid-template-columns:120px minmax(150px,1fr) 54px}}
@media(max-width:560px){.dashboard-heading{align-items:flex-start;flex-direction:column}.heading-actions{width:100%}.range-select{flex:1}.summary-cell{min-height:80px;padding:16px 20px}.summary-cell strong{font-size:25px}.card-heading{padding-right:16px;padding-left:16px}.chart-shell{overflow-x:auto}.chart-shell svg{min-width:620px}.attention-item{grid-template-columns:1fr auto}.attention-item em{display:none}.workload-table{overflow-x:auto}.workload-head,.workload-row{min-width:520px}.activity-row{grid-template-columns:8px minmax(0,1fr)}.activity-row time{grid-column:2}}
</style>
