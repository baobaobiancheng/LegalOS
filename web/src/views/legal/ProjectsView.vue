<template>
  <div class="app-shell">
    <div class="aurora"><div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" /></div>

    <aside class="app-sidebar sidebar-glass">
      <button class="app-brand" @click="router.push('/legal/projects')">
        <span class="brand-icon">⚖</span>
        <span class="brand-text"><b>法务 Legal OS</b><small>法律团队项目空间</small></span>
      </button>

      <div class="nav-section">
        <span class="nav-label">项目</span>
        <button class="nav-btn active">
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg></span>
          工单管理
        </button>
        <button class="nav-btn" disabled>
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
          法规检索
        </button>
        <button class="nav-btn" @click="router.push('/legal/skills')">
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>
          技能库
        </button>
      </div>
      <div class="nav-section">
        <span class="nav-label">企业能力</span>
        <button class="nav-btn" disabled>知识库 · v0.2.0</button>
        <button class="nav-btn" disabled>数字分身 · v0.2.0</button>
      </div>

      <div class="sidebar-footer">
        <div class="user-avatar">{{ auth.user?.displayName?.[0] || '法' }}</div>
        <div class="user-info">
          <span class="user-name">{{ auth.user?.displayName || '用户' }}</span>
          <span class="user-role">{{ auth.user?.role === 'legal_lead' ? '法务负责人' : '法务 BP' }}</span>
        </div>
        <button class="logout-link" @click="handleLogout" title="退出登录">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <div class="tb-left">
          <small class="tb-path">法务 Legal OS</small>
          <strong class="tb-title">工单管理</strong>
        </div>
        <!-- 2026-08-05：右上角状态徽章（就绪/数量）无信息量，已删除 -->

      </header>

      <div class="app-content animate-in">
        <!-- 统计概览 -->
        <div class="stats-row">
          <div class="stat-card glass-card" v-for="s in stats" :key="s.label">
            <span class="stat-value" :style="{ color: s.color }">{{ s.count }}</span>
            <span class="stat-label">{{ s.label }}</span>
          </div>
        </div>

        <!-- Tabs -->
        <div class="tab-bar">
          <button
            v-for="t in tabs"
            :key="t.key"
            :class="['tab-item', { active: activeTab === t.key }]"
            @click="activeTab = t.key"
          >
            {{ t.label }}<span class="tab-count">{{ groups[t.key]?.length || 0 }}</span>
          </button>
        </div>

        <!-- Loading Skeleton -->
        <template v-if="loading">
          <div v-for="i in 3" :key="'sk-'+i" class="project-card glass-card" style="cursor:default; transform:none">
            <div class="card-main">
              <div class="skeleton" style="width:48px;height:24px;border-radius:20px" />
              <div class="skeleton" style="width:200px;height:18px;margin-left:14px" />
            </div>
            <div class="card-meta-row">
              <div class="skeleton" style="width:32px;height:22px;border-radius:11px" />
              <div class="skeleton" style="width:80px;height:14px;margin-left:12px" />
            </div>
          </div>
        </template>

        <!-- Empty -->
        <div v-else-if="!groups[activeTab]?.length" class="welcome-hero">
          <div class="welcome-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
          </div>
          <h2 class="text-h2">暂无工单</h2>
          <p class="text-body">{{ activeTab }}分区为空，新工单将自动出现在这里</p>
        </div>

        <!-- Project List -->
        <div v-else class="card-stack">
          <article
            v-for="(p, idx) in groups[activeTab]"
            :key="p.id"
            :class="['project-card', 'glass-card', 'risk-' + p.risk]"
            :style="{ animationDelay: idx * 0.04 + 's' }"
            @click="openProject(p.id)"
          >
            <div class="card-main">
              <span :class="['kind-badge', 'kind-' + p.kind]">
                <span class="kind-icon" v-html="kindIcon(p.kind)" />
                {{ kindLabel(p.kind) }}
              </span>
              <span class="card-title">{{ p.title }}</span>
              <span v-if="p.isFailed" class="failed-dot">异常</span>
            </div>
            <div class="card-meta-row">
              <span :class="['risk-chip', 'risk-' + p.risk + '-bg']">{{ p.risk }}</span>
              <span class="card-creator">{{ p.creator.displayName }}</span>
              <span class="card-time">{{ fmtTime(p.createdAt) }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { request } from '../../api/client'
import type { ProjectListResponse, ProjectListItem } from '../../types'

const router = useRouter()
const auth = useAuthStore()
const loading = ref(true)
const activeTab = ref('待处理')

const groups = ref<Record<string, ProjectListItem[]>>({
  待处理: [], 合同协作: [], 已回传: [], 数字分身处理: [],
})

const totalCount = ref(0)

// 统计概览
const stats = computed(() => [
  { label: '全部工单', count: totalCount.value, color: '#1d1d1f' },
  { label: '待处理', count: groups.value['待处理'].length, color: '#C41212' },
  { label: '合同协作', count: groups.value['合同协作'].length, color: '#0055B3' },
  { label: 'AI 处理', count: groups.value['数字分身处理'].length, color: '#0E7A3C' },
])

const tabs = [
  { key: '待处理', label: '待处理' },
  { key: '合同协作', label: '合同协作' },
  { key: '已回传', label: '已回传' },
  { key: '数字分身处理', label: 'AI 处理' },
]

onMounted(async () => {
  try {
    const data = await request<ProjectListResponse>('/projects')
    groups.value = data.groups
    totalCount.value = data.total
  } catch {}
  loading.value = false
})

const kindIcon = (k: string) => ({
  consult: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  contract: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  research: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  draft: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
})[k] || '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>'
const kindLabel = (k: string) => ({ consult: '咨询', contract: '合同', research: '检索', draft: '文书' })[k] || k
// 后端返回 UTC ISO，需转本地时区（slice 截取会差 8 小时）
const fmtTime = (t: string) => {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const openProject = (id: string) => router.push(`/legal/projects/${id}`)
async function handleLogout() { await auth.logout(); await router.replace('/login') }
</script>

<script lang="ts">export default { name: 'ProjectsView' }</script>

<style scoped>
.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.tb-right { display: flex; align-items: center; }
/* ── 统计概览 ── */
.stats-row {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px;
  margin-bottom: 24px;
}
.stat-card {
  display: flex; flex-direction: column; gap: 4px;
  padding: 18px 22px; border-radius: var(--radius-sm);
}
.stat-value { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.stat-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
@media (max-width: 640px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
}

.card-stack { display: flex; flex-direction: column; gap: 6px; }

.card-main { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
.card-title {
  font-size: 15px; font-weight: 600; color: var(--text);
  letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.kind-icon { font-size: 13px; }
.failed-dot {
  padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 700;
  background: rgba(255,59,48,0.10); color: #FF3B30; letter-spacing: 0.02em;
}

.card-meta-row { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.card-creator { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.card-time { font-size: 12px; color: var(--text-tertiary); }
</style>
