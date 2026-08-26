<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { useRouter } from 'vue-router'
import baijianLogo from '../assets/logo-header.jpeg'
import { useAuthStore } from '../stores/auth'

defineProps<{
  activeKey: 'consult' | 'contract' | 'records'
  contentClass?: string
}>()

const router = useRouter()
const auth = useAuthStore()
const slots = useSlots()
const hasTopbar = computed(() => Boolean(slots.topbar))

const navItems = [
  {
    key: 'consult' as const,
    label: '法律咨询',
    path: '/business/consult',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  },
  {
    key: 'contract' as const,
    label: '合同助手',
    path: '/business/contract',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  },
  {
    key: 'records' as const,
    label: '我的记录',
    path: '/business/records',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  },
]

async function handleLogout() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="business-workspace-shell">
    <aside class="business-sidebar">
      <button
        class="workspace-brand"
        aria-label="返回法律咨询"
        @click="router.push('/business/consult')"
      >
        <span class="workspace-logo">
          <img
            :src="baijianLogo"
            alt="百鉴"
          >
        </span>
        <span class="workspace-brand-copy">
          <strong>LegalOS</strong>
          <small>专业法务智能操作系统</small>
        </span>
      </button>

      <nav
        class="workspace-nav"
        aria-label="业务工作台导航"
      >
        <button
          v-for="item in navItems"
          :key="item.key"
          :class="['workspace-nav-item', { active: activeKey === item.key }]"
          :aria-current="activeKey === item.key ? 'page' : undefined"
          @click="router.push(item.path)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            v-html="item.icon"
          />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="workspace-secondary-nav">
        <button disabled>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>
          <span>知识库</span>
        </button>
        <button disabled>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><circle
            cx="12"
            cy="8"
            r="4"
          /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
          <span>数字分身</span>
        </button>
      </div>

      <div class="workspace-user">
        <span class="workspace-avatar">{{ auth.user?.displayName?.[0] || '业' }}</span>
        <span class="workspace-user-copy">
          <strong>{{ auth.user?.displayName || '业务用户' }}</strong>
          <small>业务人员</small>
        </span>
        <button
          class="workspace-logout"
          aria-label="退出登录"
          title="退出登录"
          @click="handleLogout"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>
        </button>
      </div>
    </aside>

    <main :class="['business-workspace-main', { 'has-topbar': hasTopbar }]">
      <header
        v-if="hasTopbar"
        class="app-topbar business-legacy-topbar"
      >
        <slot name="topbar" />
      </header>
      <div :class="['app-content', contentClass, { 'topbarless-content': !hasTopbar }]">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.business-workspace-shell {
  --workspace-blue: #2563eb;
  --workspace-blue-weak: #eff6ff;
  --workspace-canvas: #f7f8fa;
  --workspace-text: #111827;
  --workspace-border: #e5e7eb;
  min-height: 100vh;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
  font-family: Outfit, Geist, "Noto Sans SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
}

.business-sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 20;
  display: flex;
  width: 254px;
  height: 100vh;
  overflow: hidden;
  flex-direction: column;
  border-right: 1px solid var(--workspace-border);
  background: #fff;
}

.workspace-brand {
  display: flex;
  min-height: 162px;
  padding: 28px 28px 26px;
  align-items: flex-start;
  gap: 13px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.workspace-logo {
  display: grid;
  width: 46px;
  height: 46px;
  overflow: hidden;
  place-items: center;
  flex: 0 0 auto;
}

.workspace-logo img { display: block; width: 62px; height: 62px; max-width: none; object-fit: cover; }
.workspace-brand-copy { display: grid; min-width: 0; padding-top: 4px; gap: 12px; }
.workspace-brand-copy strong { color: #0f172a; font-size: 23px; font-weight: 720; letter-spacing: -.035em; }
.workspace-brand-copy small { width: 156px; color: #526174; font-size: 12px; letter-spacing: .13em; line-height: 1.7; }
.workspace-nav { display: grid; gap: 2px; }

.workspace-nav-item,
.workspace-secondary-nav button {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 68px;
  padding: 0 30px 0 38px;
  align-items: center;
  gap: 16px;
  border: 0;
  background: transparent;
  color: #25324a;
  font: inherit;
  font-size: 15px;
  font-weight: 560;
  text-align: left;
  cursor: pointer;
}

.workspace-nav-item svg,
.workspace-secondary-nav svg { width: 21px; height: 21px; flex: 0 0 auto; }
.workspace-nav-item::before { position: absolute; inset: 0 auto 0 0; width: 4px; background: transparent; content: ""; }
.workspace-nav-item:hover { background: #f8fafc; color: var(--workspace-blue); }
.workspace-nav-item.active { background: linear-gradient(90deg, #eff6ff 0%, #f5f8ff 100%); color: var(--workspace-blue); font-weight: 680; }
.workspace-nav-item.active::before { background: var(--workspace-blue); }

.workspace-secondary-nav { display: grid; margin: auto 24px 0; padding: 22px 0 18px; border-top: 1px solid var(--workspace-border); }
.workspace-secondary-nav button { min-height: 58px; padding: 0 12px; color: #61708a; cursor: default; }
.workspace-user { display: flex; min-height: 112px; margin: 0 24px; padding: 20px 8px; align-items: center; gap: 12px; border-top: 1px solid var(--workspace-border); }
.workspace-avatar { display: grid; width: 44px; height: 44px; border-radius: 50%; place-items: center; flex: 0 0 auto; background: var(--workspace-blue); color: #fff; font-size: 16px; font-weight: 700; }
.workspace-user-copy { display: grid; min-width: 0; gap: 4px; }
.workspace-user-copy strong,
.workspace-user-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-user-copy strong { color: #1f2937; font-size: 13px; font-weight: 680; }
.workspace-user-copy small { color: #6b7280; font-size: 12px; }
.workspace-logout { display: grid; width: 36px; height: 36px; margin-left: auto; padding: 0; border: 0; border-radius: 7px; place-items: center; background: transparent; color: #64748b; cursor: pointer; }
.workspace-logout:hover { background: #f1f5f9; color: var(--workspace-blue); }
.workspace-logout svg { width: 20px; height: 20px; }

.business-workspace-main {
  min-width: 0;
  min-height: 100vh;
  height: 100vh;
  margin-left: 254px;
  overflow: hidden;
}

.business-workspace-main > .app-content { width: 100%; height: 100%; }
.business-workspace-main > .topbarless-content { max-width: none; padding: 0; overflow: hidden; }
.business-workspace-main.has-topbar > .app-content { height: calc(100vh - 56px); }
.business-legacy-topbar { background: #fff; border-bottom: 1px solid var(--workspace-border); box-shadow: none; }

@media (max-width: 920px) {
  .business-sidebar { width: 78px; }
  .workspace-brand { min-height: 96px; padding: 22px 16px; }
  .workspace-logo { width: 46px; }
  .workspace-brand-copy,
  .workspace-nav-item span,
  .workspace-secondary-nav span,
  .workspace-user-copy,
  .workspace-logout { display: none; }
  .workspace-nav-item,
  .workspace-secondary-nav button { justify-content: center; padding: 0; }
  .workspace-secondary-nav { margin-right: 12px; margin-left: 12px; }
  .workspace-user { justify-content: center; margin: 0 12px; padding-right: 0; padding-left: 0; }
  .business-workspace-main { margin-left: 78px; }
}
</style>
