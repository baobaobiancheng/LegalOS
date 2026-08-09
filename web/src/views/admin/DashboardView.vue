<template>
  <div class="app-shell">
    <div class="aurora">
      <div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" />
    </div>

    <aside class="app-sidebar sidebar-glass">
      <button
        class="app-brand"
        @click="router.push('/admin/dashboard')"
      >
        <span class="brand-icon">⚙</span>
        <span class="brand-text"><b>管理端</b><small>系统管理</small></span>
      </button>

      <div class="nav-section">
        <span class="nav-label">管理工具</span>
        <button class="nav-btn active">
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><line
            x1="12"
            y1="20"
            x2="12"
            y2="10"
          /><line
            x1="18"
            y1="20"
            x2="18"
            y2="4"
          /><line
            x1="6"
            y1="20"
            x2="6"
            y2="16"
          /></svg></span>
          数据看板
        </button>
        <button
          class="nav-btn"
          disabled
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle
            cx="9"
            cy="7"
            r="4"
          /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg></span>
          用户管理
        </button>
        <button
          class="nav-btn"
          disabled
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><circle
            cx="12"
            cy="12"
            r="10"
          /><polyline points="12 6 12 12 16 14" /></svg></span>
          定时任务
        </button>
        <button
          class="nav-btn"
          disabled
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line
            x1="16"
            y1="13"
            x2="8"
            y2="13"
          /><line
            x1="16"
            y1="17"
            x2="8"
            y2="17"
          /></svg></span>
          审计日志
        </button>
      </div>

      <div class="sidebar-footer">
        <div class="user-avatar">
          {{ auth.user?.displayName?.[0] || '管' }}
        </div>
        <div class="user-info">
          <span class="user-name">{{ auth.user?.displayName || '用户' }}</span>
          <span class="user-role">系统管理员</span>
        </div>
        <button
          class="logout-link"
          title="退出登录"
          @click="handleLogout"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line
            x1="21"
            y1="12"
            x2="9"
            y2="12"
          /></svg>
        </button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <div style="display:flex;align-items:baseline;gap:10px">
          <small style="font-size:11px;color:#aeaeb2;font-weight:590">管理端</small>
          <strong style="font-size:14px;font-weight:650;color:#1d1d1f;letter-spacing:-0.01em">数据看板</strong>
        </div>
      </header>

      <div class="app-content animate-in">
        <div class="placeholder-page glass-card">
          <div class="ph-icon">
            📊
          </div>
          <h2 class="text-h2">
            数据看板
          </h2>
          <p
            class="text-body"
            style="max-width:470px"
          >
            管理端功能将在 Phase 2 实现。<br>当前仅展示空壳首页，用于验证角色路由与 JWT 认证链路。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
const router = useRouter()
const auth = useAuthStore()
async function handleLogout() { await auth.logout(); await router.replace('/login') }
</script>

<script lang="ts">export default { name: 'DashboardView' }</script>
