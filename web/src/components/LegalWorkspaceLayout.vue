<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import bairongMark from '../assets/bairong-intelligence-mark.png'
import { useAuthStore } from '../stores/auth'
import UserAvatar from './UserAvatar.vue'
import { Role, ROLE_LABEL } from '../types'

const props = defineProps<{
  activeKey: 'dashboard' | 'members' | 'projects' | 'research' | 'skills'
}>()

const router = useRouter()
const auth = useAuthStore()
const roleLabel = computed(() => auth.user ? ROLE_LABEL[auth.user.role] : '未登录')

const isAdmin = computed(() => auth.user?.role === Role.ADMIN)
const managementItems = [
  { key: 'dashboard', label: '数据看板', path: '/admin/dashboard', icon: '<path d="M4 4v16h16M8 16v-5m5 5V7m5 9v-7"/>' },
  { key: 'members', label: '成员与职责', path: '/admin/members', icon: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 5a5 5 0 0 1 3 4v2"/>' },
]
const legalItems = [
  {
    key: 'projects' as const,
    label: '工单管理',
    path: '/legal/projects',
    icon: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
  },
  {
    key: 'research' as const,
    label: '法规与类案检索',
    path: '/legal/research',
    icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  },
  {
    key: 'skills' as const,
    label: '技能库',
    path: '/legal/skills',
    icon: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  },
]

const navGroups = computed(() => isAdmin.value
  ? [{ label: '管理工作台', items: [managementItems[0]!, legalItems[0]!, managementItems[1]!] }, { label: '法务工具', items: legalItems.slice(1) }]
  : [{ label: '法务工作台', items: legalItems }])

async function handleLogout() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="legal-workspace-shell">
    <aside class="legal-sidebar">
      <button
        class="workspace-brand"
        :aria-label="isAdmin ? '返回数据看板' : '返回工单管理'"
        @click="router.push(isAdmin ? '/admin/dashboard' : '/legal/projects')"
      >
        <span class="workspace-logo">
          <img
            :src="bairongMark"
            alt="百融智能"
          >
        </span>
        <span class="workspace-brand-copy">
          <strong>LegalOS</strong>
          <small>专业法务智能操作系统</small>
        </span>
      </button>

      <div class="workspace-navigation">
        <nav
          v-for="group in navGroups"
          :key="group.label"
          class="workspace-nav"
          :aria-label="`${group.label}导航`"
        >
          <span class="workspace-nav-caption">{{ group.label }}</span>
          <button
            v-for="item in group.items"
            :key="item.key"
            :class="['workspace-nav-item', { active: props.activeKey === item.key }]"
            :aria-current="props.activeKey === item.key ? 'page' : undefined"
            :aria-label="item.label"
            :title="item.label"
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
      </div>

      <div class="workspace-user">
        <UserAvatar
          class="workspace-avatar"
          :src="auth.user?.avatarUrl"
          :name="auth.user?.displayName"
          fallback="法"
        />
        <span class="workspace-user-copy">
          <strong>{{ auth.user?.displayName || '法务用户' }}</strong>
          <small>{{ roleLabel }}</small>
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

    <main class="legal-workspace-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.legal-workspace-shell {
  --workspace-blue: #2563EB;
  --workspace-blue-weak: #EFF6FF;
  --workspace-canvas: #F7F8FA;
  --workspace-text: #111827;
  --workspace-secondary: #374151;
  --workspace-tertiary: #6B7280;
  --workspace-border: #E5E7EB;
  min-height: 100dvh;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
  font-family: Outfit, Geist, "Noto Sans SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
}

.legal-sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 20;
  display: flex;
  width: 254px;
  overflow: hidden;
  flex-direction: column;
  border-right: 1px solid var(--workspace-border);
  background: #FFFFFF;
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
  text-align: left;
}

.workspace-logo {
  display: grid;
  width: 46px;
  height: 46px;
  overflow: hidden;
  place-items: center;
  flex: 0 0 auto;
}

.workspace-logo img {
  display: block;
  width: 46px;
  height: 46px;
  object-fit: contain;
}

.workspace-brand-copy {
  display: grid;
  min-width: 0;
  padding-top: 4px;
  gap: 12px;
}

.workspace-brand-copy strong {
  color: #0F172A;
  font-size: 23px;
  font-weight: 720;
  letter-spacing: -0.035em;
}

.workspace-brand-copy small {
  width: 156px;
  color: #526174;
  font-size: 12px;
  letter-spacing: 0.13em;
  line-height: 1.7;
}

.workspace-nav {
  display: grid;
  gap: 2px;
}

.workspace-nav-item {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 56px;
  padding: 0 30px 0 38px;
  align-items: center;
  gap: 16px;
  border: 0;
  background: transparent;
  color: #25324A;
  font: inherit;
  font-size: 15px;
  font-weight: 560;
  text-align: left;
}

.workspace-nav-item svg {
  width: 21px;
  height: 21px;
  flex: 0 0 auto;
}

.workspace-nav-item::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: transparent;
  content: "";
}

.workspace-nav + .workspace-nav { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--workspace-border); }
.workspace-nav-caption { display: block; padding: 0 38px 8px; color: var(--workspace-tertiary); font-size: 11px; letter-spacing: .08em; }
.workspace-brand, .workspace-user { flex-shrink: 0; }
.workspace-navigation { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow-y: auto; }
.workspace-navigation > * { flex-shrink: 0; }
.legal-sidebar :is(button, a):focus-visible { outline: 2px solid var(--workspace-blue); outline-offset: -3px; }

.workspace-nav-item:hover {
  background: #F8FAFC;
  color: var(--workspace-blue);
}

.workspace-nav-item.active {
  background: linear-gradient(90deg, #EFF6FF 0%, #F5F8FF 100%);
  color: var(--workspace-blue);
  font-weight: 680;
}

.workspace-nav-item.active::before {
  background: var(--workspace-blue);
}

.workspace-user {
  display: flex;
  min-height: 112px;
  margin: 0 24px;
  padding: 20px 8px;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--workspace-border);
}

.workspace-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  place-items: center;
  flex: 0 0 auto;
  background: var(--workspace-blue);
  color: #FFFFFF;
  font-size: 16px;
  font-weight: 700;
}

.workspace-user-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.workspace-user-copy strong,
.workspace-user-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-user-copy strong {
  color: #1F2937;
  font-size: 13px;
  font-weight: 680;
}

.workspace-user-copy small {
  color: var(--workspace-tertiary);
  font-size: 12px;
}

.workspace-logout {
  display: grid;
  width: 36px;
  height: 36px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 7px;
  place-items: center;
  background: transparent;
  color: #64748B;
}

.workspace-logout:hover {
  background: #F1F5F9;
  color: var(--workspace-blue);
}

.workspace-logout svg {
  width: 20px;
  height: 20px;
}

.legal-workspace-main {
  min-width: 0;
  min-height: 100vh;
  margin-left: 254px;
  overflow-x: hidden;
}

@media (max-width: 920px) {
  .legal-sidebar { width: 78px; }
  .workspace-brand { min-height: 96px; padding: 22px 16px; }
  .workspace-logo { width: 46px; }
  .workspace-brand-copy,
  .workspace-nav-caption,
  .workspace-nav-item span,
  .workspace-user-copy,
  .workspace-logout { display: none; }
  .workspace-nav-item { justify-content: center; padding: 0; }
  .workspace-user { justify-content: center; margin: 0 12px; padding-right: 0; padding-left: 0; }
  .legal-workspace-main { margin-left: 78px; }
}
</style>
