<template>
  <BusinessSidebarLayout active-key="records">
    <template #topbar>
      <div class="tb-left">
        <small class="tb-path">Business OS</small>
        <strong class="tb-title">我的记录</strong>
      </div>
      <div class="tb-right">
        <span
          v-if="!loading"
          class="tb-count"
        >{{ filterLabel }} · {{ items.length }} 条</span>
        <button
          class="new-btn"
          @click="router.push('/business/consult')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          ><line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
          /><line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
          /></svg>
          新咨询
        </button>
      </div>
    </template>
    <!-- 统计概览 = 筛选入口 -->
    <div class="stats-row">
      <div
        v-for="s in stats"
        :key="s.label"
        :class="['stat-card', 'glass-card', { active: filter === s.filter }]"
        @click="filter = s.filter"
      >
        <div
          class="stat-icon"
          :style="{ background: s.bg, color: s.color }"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              v-if="s.icon === 'all'"
              d="M22 12h-6l-2 3h-4l-2-3H2"
            /><path
              v-if="s.icon === 'all'"
              d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"
            />
            <circle
              v-if="s.icon === 'process'"
              cx="12"
              cy="12"
              r="9"
            /><path
              v-if="s.icon === 'process'"
              d="M12 8v4l3 3"
            />
            <path
              v-if="s.icon === 'done'"
              d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
            /><polyline
              v-if="s.icon === 'done'"
              points="22 4 12 14.01 9 11.01"
            />
            <circle
              v-if="s.icon === 'cancel'"
              cx="12"
              cy="12"
              r="9"
            /><line
              v-if="s.icon === 'cancel'"
              x1="15"
              y1="9"
              x2="9"
              y2="15"
            /><line
              v-if="s.icon === 'cancel'"
              x1="9"
              y1="9"
              x2="15"
              y2="15"
            />
          </svg>
        </div>
        <div class="stat-body">
          <span
            class="stat-value"
            :style="{ color: s.color }"
          >{{ s.count }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <template v-if="loading">
      <div
        v-for="i in 3"
        :key="'sk-'+i"
        class="record-card glass-card"
        style="cursor:default;transform:none"
      >
        <div
          class="rc-icon skeleton"
          style="width:42px;height:42px;border-radius:12px"
        />
        <div
          class="rc-main"
          style="flex:1"
        >
          <div
            class="skeleton"
            style="width:60%;height:16px;margin-bottom:10px"
          />
          <div
            class="skeleton"
            style="width:30%;height:12px"
          />
        </div>
      </div>
    </template>

    <!-- Empty -->
    <div
      v-else-if="items.length === 0"
      class="welcome-hero"
    >
      <div class="welcome-icon">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#86868b"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" /></svg>
      </div>
      <h2 class="text-h2">
        {{ filter === '' ? '暂无记录' : '该分类暂无记录' }}
      </h2>
      <p class="text-body">
        您的法律咨询和合同协作记录将显示在这里
      </p>
      <button
        class="btn-primary"
        style="margin-top:20px"
        @click="router.push('/business/consult')"
      >
        发起咨询
      </button>
    </div>

    <!-- List -->
    <div
      v-else
      class="card-stack"
    >
      <article
        v-for="(r, idx) in items"
        :key="r.id"
        :class="['record-card', 'glass-card', 'risk-' + r.risk]"
        :style="{ animationDelay: idx * 0.04 + 's' }"
        @click="router.push('/business/records/' + r.id)"
      >
        <div
          class="rc-icon"
          :class="'kind-' + r.kind"
          v-html="kindIcon(r.kind)"
        />
        <div class="rc-main">
          <div class="rc-title-row">
            <span class="rc-title">{{ r.title }}</span>
            <span :class="['status-chip', 'status-' + r.status]">{{ r.status }}</span>
          </div>
          <div class="rc-sub-row">
            <span class="rc-kind">{{ kindLabel(r.kind) }}</span>
            <span :class="['risk-chip', 'risk-' + r.risk + '-bg']">{{ r.risk }}</span>
            <span class="rc-time">{{ fmtTime(r.createdAt) }}</span>
          </div>
        </div>
        <svg
          class="rc-arrow"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#c7c7cc"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><path d="M9 18l6-6-6-6" /></svg>
      </article>
    </div>
  </BusinessSidebarLayout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { request } from '../../api/client'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import type { ProjectListItem } from '../../types'

const router = useRouter()
const loading = ref(true)
const allItems = ref<ProjectListItem[]>([])
const filter = ref('')  // ''全部 | process处理中 | 已回传 | 已取消

// 当前筛选后的展示列表
const items = computed(() => {
  if (filter.value === '') return allItems.value
  if (filter.value === 'process') {
    return allItems.value.filter(i => i.status === '分析中' || i.status === '待复核')
  }
  return allItems.value.filter(i => i.status === filter.value)
})

// 状态统计（基于全部数据）
const statusCount = computed(() => {
  const c: Record<string, number> = { 分析中: 0, 待复核: 0, 已回传: 0, 已取消: 0 }
  for (const i of allItems.value) c[i.status] = (c[i.status] || 0) + 1
  return c
})

const stats = computed(() => [
  { label: '全部记录', count: allItems.value.length, color: '#1d1d1f', icon: 'all', bg: '#f0f0f0', filter: '' },
  { label: '处理中', count: (statusCount.value['分析中'] || 0) + (statusCount.value['待复核'] || 0), color: '#0055B3', icon: 'process', bg: '#e8f0fe', filter: 'process' },
  { label: '已回传', count: statusCount.value['已回传'] || 0, color: '#0E7A3C', icon: 'done', bg: '#e6f4ea', filter: '已回传' },
  { label: '已取消', count: statusCount.value['已取消'] || 0, color: '#5A5A5E', icon: 'cancel', bg: '#f0f0f0', filter: '已取消' },
])

const filterLabel = computed(() =>
  ({ '': '全部记录', process: '处理中', 已回传: '已回传', 已取消: '已取消' })[filter.value] || '全部记录'
)

onMounted(async () => {
  loading.value = true
  try {
    const data = await request<any>('/projects/mine?page=1&size=100')
    allItems.value = data.items
  } catch {}
  loading.value = false
})

const kindLabel = (k: string) => ({ consult: '咨询', contract: '合同', research: '检索', draft: '文书' })[k] || k
const kindIcon = (k: string) => ({
  consult: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  contract: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  research: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  draft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
})[k] || '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>'
// 后端返回 UTC ISO，需转本地时区（slice 截取会差 8 小时）
const fmtTime = (t: string) => {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

</script>

<script lang="ts">export default { name: 'RecordsView' }</script>

<style scoped>
.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.tb-right { display: flex; align-items: center; gap: 14px; }
.tb-count { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
.new-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 16px; border: none; border-radius: 18px;
  background: #1E3A8A; color: #fff;
  font-family: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer; transition: all 0.3s var(--spring);
}
.new-btn:hover { background: #1E40AF; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(30,58,138,0.25); }

/* ── 统计概览 = 筛选入口 ── */
.stats-row {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px;
  margin-bottom: 28px;
}
.stat-card {
  display: flex; align-items: center; gap: 14px;
  padding: 18px 20px; border-radius: var(--radius-sm);
  cursor: pointer; position: relative;
  border: 1.5px solid transparent;
  transition: all 0.25s var(--spring);
}
.stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
.stat-card.active {
  border-color: #1E3A8A;
  background: rgba(255,255,255,0.95);
  box-shadow: 0 8px 28px rgba(30,58,138,0.12);
}
.stat-card.active::after {
  content: ""; position: absolute; bottom: 0; left: 20px; right: 20px;
  height: 2px; border-radius: 1px; background: #1E3A8A;
}
.stat-icon {
  width: 40px; height: 40px; border-radius: 12px;
  display: grid; place-items: center; flex-shrink: 0;
}
.stat-body { display: flex; flex-direction: column; gap: 2px; }
.stat-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.stat-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
@media (max-width: 640px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
}

/* ── 记录卡片 ── */
.card-stack { display: flex; flex-direction: column; gap: 8px; }
.record-card {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 20px; border-radius: var(--radius-sm);
  cursor: pointer; transition: all 0.3s var(--spring);
  /* 性能修复（2026-08-05）：滚动列表内禁用 backdrop-filter（滚动时每帧重采样背景 → 明显卡顿）；
     背景已是半透明白 rgba(255,255,255,0.80)，视觉近似毛玻璃 */
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.record-card:hover {
  transform: translateX(4px);
  box-shadow: 0 10px 30px rgba(0,0,0,0.08);
}
.record-card:hover .rc-arrow { color: #1E3A8A; transform: translateX(2px); }

.rc-icon {
  width: 42px; height: 42px; border-radius: 12px;
  display: grid; place-items: center; flex-shrink: 0;
}
.rc-icon.kind-consult { background: rgba(0,113,227,0.08); color: #0055B3; }
.rc-icon.kind-contract { background: rgba(52,199,89,0.08); color: #0E7A3C; }
.rc-icon.kind-research { background: rgba(175,82,222,0.08); color: #8B3CC0; }
.rc-icon.kind-draft { background: rgba(255,149,0,0.08); color: #C46200; }

.rc-main { flex: 1; min-width: 0; }
.rc-title-row { display: flex; align-items: center; gap: 10px; }
.rc-title { font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.rc-sub-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.rc-kind { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
.rc-time { font-size: 12px; color: var(--text-tertiary); }

.rc-arrow { flex-shrink: 0; transition: all 0.25s; }
</style>
