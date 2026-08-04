<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

/**
 * 业务端通用布局（DRY：4 个业务页面共用侧边栏/顶栏/内容骨架）。
 * 用法：
 *   <BusinessSidebarLayout active-key="consult" content-class="chat-content">
 *     <template #topbar>…顶栏内容…</template>
 *     …页面内容…
 *   </BusinessSidebarLayout>
 */
defineProps<{
  activeKey: 'consult' | 'contract' | 'records'
  /** 附加到 .app-content 的页面类（如 chat-content / contract-content） */
  contentClass?: string
}>()

const router = useRouter()
const auth = useAuthStore()

async function handleLogout() { await auth.logout(); await router.replace('/login') }
</script>

<template>
  <div class="app-shell">
    <div class="aurora"><div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" /></div>

    <aside class="app-sidebar sidebar-glass">
      <button class="app-brand" @click="router.push('/business/consult')">
        <span class="brand-icon">💼</span>
        <span class="brand-text"><b>Business OS</b><small>业务法律协同空间</small></span>
      </button>
      <div class="nav-section">
        <span class="nav-label">业务服务</span>
        <button class="nav-btn" :class="{ active: activeKey === 'consult' }" @click="router.push('/business/consult')">
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          法律咨询
        </button>
        <button class="nav-btn" :class="{ active: activeKey === 'contract' }" @click="router.push('/business/contract')">
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>
          合同助手
        </button>
        <button class="nav-btn" :class="{ active: activeKey === 'records' }" @click="router.push('/business/records')">
          <span class="nav-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h18M3 12h18M3 19h12"/></svg></span>
          我的记录
        </button>
      </div>
      <div class="sidebar-footer">
        <div class="user-avatar">{{ auth.user?.displayName?.[0] || '用' }}</div>
        <div class="user-info">
          <span class="user-name">{{ auth.user?.displayName || '用户' }}</span>
          <span class="user-role">业务人员</span>
        </div>
        <button class="logout-link" @click="handleLogout" title="退出登录">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <slot name="topbar" />
      </header>
      <div :class="['app-content', 'animate-in', contentClass]">
        <slot />
      </div>
    </div>
  </div>
</template>
