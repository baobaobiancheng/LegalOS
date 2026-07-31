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
        <button class="nav-btn active">工单管理</button>
        <button class="nav-btn" disabled>法规检索</button>
        <button class="nav-btn" disabled>技能库</button>
      </div>
      <div class="nav-section">
        <span class="nav-label">企业能力</span>
        <button class="nav-btn" disabled>知识库 · v0.2.0</button>
        <button class="nav-btn" disabled>数字分身 · v0.2.0</button>
      </div>

      <div class="sidebar-footer">
        <span>{{ auth.user?.displayName }} · {{ auth.user?.role === 'legal_lead' ? '法务负责人' : '法务 BP' }}</span>
        <button class="logout-link" @click="handleLogout">退出</button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <div style="display:flex;align-items:baseline;gap:10px">
          <small style="font-size:11px;color:#aeaeb2;font-weight:590">法务 Legal OS</small>
          <strong style="font-size:14px;font-weight:650;color:#1d1d1f;letter-spacing:-0.01em">工单管理</strong>
        </div>
        <span style="font-size:11px;color:#34C759;font-weight:590">本地优先</span>
      </header>

      <div class="app-content animate-in">
        <div class="placeholder-page glass-card">
          <div class="ph-icon">📋</div>
          <h2 class="text-h2">工单列表</h2>
          <p class="text-body" style="max-width:470px">工单管理功能将在 Phase 2 实现。<br/>当前仅展示空壳首页，用于验证角色路由与 JWT 认证链路。</p>
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

<script lang="ts">export default { name: 'ProjectsView' }</script>
