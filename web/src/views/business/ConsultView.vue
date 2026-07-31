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
        <button class="nav-btn active">法律咨询</button>
        <button class="nav-btn" disabled>合同助手</button>
        <button class="nav-btn" disabled>我的记录</button>
      </div>

      <div class="sidebar-footer">
        <span>{{ auth.user?.displayName }} · 业务人员</span>
        <button class="logout-link" @click="handleLogout">退出</button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <div style="display:flex;align-items:baseline;gap:10px">
          <small style="font-size:11px;color:#aeaeb2;font-weight:590">Business OS</small>
          <strong style="font-size:14px;font-weight:650;color:#1d1d1f;letter-spacing:-0.01em">法律咨询</strong>
        </div>
        <span style="font-size:11px;color:#007AFF;font-weight:590">本机协同</span>
      </header>

      <div class="app-content animate-in">
        <div class="placeholder-page glass-card">
          <div class="ph-icon">💬</div>
          <h2 class="text-h2">业务法律咨询</h2>
          <p class="text-body" style="max-width:470px">法律咨询功能将在 Phase 2 实现。<br/>当前仅展示空壳首页，用于验证角色路由与 JWT 认证链路。</p>
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

<script lang="ts">export default { name: 'ConsultView' }</script>
