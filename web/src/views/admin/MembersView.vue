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
        <button
          class="nav-btn"
          @click="router.push('/admin/dashboard')"
        >
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
        <button class="nav-btn active">
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
          成员管理
        </button>
        <button
          class="nav-btn"
          disabled
        >
          定时任务
        </button>
        <button
          class="nav-btn"
          disabled
        >
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
        <div class="tb-left">
          <small class="tb-path">管理端</small>
          <strong class="tb-title">成员管理</strong>
        </div>
        <button
          class="btn-primary sync-btn"
          :disabled="syncing"
          @click="doSync"
        >
          {{ syncing ? '同步中…' : '⇪ 一键同步钉钉通讯录' }}
        </button>
      </header>

      <div class="app-content animate-in">
        <ErrorState
          v-if="loadError"
          :message="loadError.payload.error"
          :request-id="loadError.payload.requestId"
          :on-retry="loadAll"
        />
        <ErrorState
          v-if="actionError"
          :message="actionError.payload.error"
          :request-id="actionError.payload.requestId"
        />
        <!-- 同步结果 + 失败计数 -->
        <div
          v-if="!loadError"
          class="stats-row"
        >
          <div class="stat-card glass-card">
            <span class="stat-value">{{ syncResult?.total ?? '—' }}</span>
            <span class="stat-label">通讯录成员</span>
          </div>
          <div class="stat-card glass-card">
            <span class="stat-value">{{ syncResult?.autoBound ?? '—' }}</span>
            <span class="stat-label">自动绑定</span>
          </div>
          <div class="stat-card glass-card warn">
            <span class="stat-value">{{ failures ?? '—' }}</span>
            <span class="stat-label">拉群失败工单</span>
          </div>
          <div class="stat-card glass-card">
            <span class="stat-value">{{ boundCount }}</span>
            <span class="stat-label">已绑定用户</span>
          </div>
        </div>
        <p
          v-if="!loadError && syncResult?.ambiguous?.length"
          class="warn-line"
        >
          ⚠️ 重名未自动绑定（请在下方手动绑定）：{{ syncResult.ambiguous.join('、') }}
        </p>

        <!-- 系统用户绑定表 -->
        <div
          v-if="!loadError"
          class="panel glass-card"
        >
          <div class="panel-head">
            <h3 class="panel-title">
              系统用户 × 钉钉绑定
            </h3>
            <input
              v-model="userKeyword"
              class="search-input"
              placeholder="搜索姓名 / 角色"
            >
          </div>
          <table class="member-table">
            <thead>
              <tr><th>姓名</th><th>角色</th><th>部门</th><th>钉钉绑定</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="u in filteredUsers"
                :key="u.id"
              >
                <td>{{ u.displayName }}</td>
                <td><span class="role-chip">{{ roleLabel(u.role) }}</span></td>
                <td>{{ u.department || '—' }}</td>
                <td>
                  <span
                    v-if="u.dingtalkUserId"
                    class="bound-ok"
                  >✓ {{ u.dingtalkUserId }}</span>
                  <span
                    v-else
                    class="bound-no"
                  >未绑定</span>
                </td>
                <td>
                  <button
                    v-if="!u.dingtalkUserId"
                    class="btn-sm"
                    @click="openBind(u)"
                  >
                    绑定
                  </button>
                  <button
                    v-else
                    class="btn-sm danger"
                    @click="unbind(u)"
                  >
                    解绑
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- BP 领域映射 -->
        <div
          v-if="!loadError"
          class="panel glass-card"
        >
          <div class="panel-head">
            <h3 class="panel-title">
              法务 BP 工作范围（领域 → 拉群匹配）
            </h3>
            <span class="panel-hint">意图识别/技能领域 → 匹配此处勾选的 BP → 指派并拉群</span>
          </div>
          <table class="member-table">
            <thead>
              <tr>
                <th>法务 BP</th><th>钉钉</th><th
                  v-for="d in bpDomains"
                  :key="d"
                  class="domain-col"
                >
                  {{ d }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="u in bpUsers"
                :key="u.id"
              >
                <td>{{ u.displayName }}</td>
                <td><span :class="u.bound ? 'bound-ok' : 'bound-no'">{{ u.bound ? '已绑定' : '未绑定' }}</span></td>
                <td
                  v-for="d in bpDomains"
                  :key="d"
                  class="domain-col"
                >
                  <input
                    type="checkbox"
                    :checked="u.domains.includes(d)"
                    @change="toggleDomain(u, d, ($event.target as HTMLInputElement).checked)"
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 手动绑定弹窗 -->
        <div
          v-if="bindTarget"
          class="modal-mask"
          @click.self="bindTarget = null"
        >
          <div class="modal-card">
            <h3 class="modal-title">
              绑定钉钉成员 · {{ bindTarget.displayName }}
            </h3>
            <label class="field-label">搜索钉钉通讯录</label>
            <input
              v-model="contactKeyword"
              class="field-input"
              placeholder="输入姓名或手机号"
              @input="searchContacts"
            >
            <div class="contact-list">
              <ErrorState
                v-if="contactError"
                :message="contactError.payload.error"
                :request-id="contactError.payload.requestId"
                :on-retry="searchContacts"
              />
              <button
                v-for="c in contacts"
                :key="c.userId"
                class="contact-item"
                @click="doBind(c)"
              >
                <span class="contact-name">{{ c.name }}</span>
                <span class="contact-mobile">{{ c.mobile || '—' }}</span>
                <span class="contact-id">{{ c.userId }}</span>
              </button>
              <p
                v-if="!contacts.length && contactKeyword"
                class="empty-hint"
              >
                未找到匹配成员（可先点右上角同步通讯录）
              </p>
            </div>
            <div class="modal-actions">
              <button
                class="btn-sm"
                @click="bindTarget = null"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError, request } from '../../api/client'
import ErrorState from '../../components/ErrorState.vue'

/**
 * 管理端成员管理（2026-08-05 钉钉拉群模块）：
 * 一键同步钉钉通讯录 → 姓名自动匹配绑定（重名落手动）→ BP 领域映射配置。
 */
const router = useRouter()
const auth = useAuthStore()

const syncing = ref(false)
const loadError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const syncResult = ref<{ total: number; autoBound: number; ambiguous: string[] } | null>(null)
const failures = ref<number | null>(null)

const users = ref<Array<{ id: string; displayName: string; role: string; dingtalkUserId: string | null; department: string | null }>>([])
const userKeyword = ref('')

const bpUsers = ref<Array<{ id: string; displayName: string; bound: boolean; domains: string[] }>>([])
const bpDomains = ref<string[]>([])

const loadAll = async () => {
  try {
    const [userData, bpData, failData, syncData] = await Promise.all([
      request<any>('/admin/members/users'),
      request<any>('/admin/members/bp-domains'),
      request<any>('/admin/members/failures'),
      request<any>('/admin/members/last-sync'),
    ])
    users.value = userData.items || userData || []
    bpUsers.value = bpData.users || []
    bpDomains.value = bpData.domains || []
    failures.value = failData.noGroup ?? null
    // 切页回来组件重建,syncResult 归 null → 从持久化批次恢复统计卡;
    // 刚同步完(syncResult 已由 POST 结果填充,含 ambiguous)则不改,避免覆盖。
    if (syncResult.value == null && syncData) {
      syncResult.value = { total: syncData.total, autoBound: syncData.autoBound, ambiguous: [] }
    }
    loadError.value = null
  } catch (error) {
    loadError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '成员数据加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

onMounted(loadAll)

const filteredUsers = computed(() => {
  const kw = userKeyword.value.trim()
  if (!kw) return users.value
  return users.value.filter((u) => u.displayName.includes(kw) || u.role.includes(kw))
})

const boundCount = computed(() => users.value.filter((u) => u.dingtalkUserId).length)

const roleLabel = (r: string) => ({ legal_bp: '法务 BP', legal_lead: '法务负责人', business: '业务', admin: '管理员' })[r] || r

const doSync = async () => {
  syncing.value = true
  actionError.value = null
  try {
    syncResult.value = await request<any>('/admin/members/sync', { method: 'POST' })
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '同步失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    syncing.value = false
  }
}

// ── 手动绑定 ──
const bindTarget = ref<{ id: string; displayName: string } | null>(null)
const contactKeyword = ref('')
const contacts = ref<Array<{ userId: string; name: string; mobile?: string }>>([])
const contactError = ref<RequestError | null>(null)

const openBind = (u: { id: string; displayName: string }) => {
  bindTarget.value = u
  contactKeyword.value = ''
  contacts.value = []
}

const searchContacts = async () => {
  if (!contactKeyword.value.trim()) { contacts.value = []; contactError.value = null; return }
  try {
    contacts.value = await request<any>(`/admin/members/contacts?keyword=${encodeURIComponent(contactKeyword.value.trim())}`)
    contactError.value = null
  } catch (error) {
    contacts.value = []
    contactError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '通讯录搜索失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const doBind = async (c: { userId: string }) => {
  if (!bindTarget.value) return
  try {
    await request('/admin/members/bind', {
      method: 'POST',
      body: { userId: bindTarget.value.id, dingtalkUserId: c.userId },
    })
    bindTarget.value = null
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '绑定失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const unbind = async (u: { id: string; displayName: string }) => {
  if (!confirm(`确认解绑 ${u.displayName} 的钉钉绑定？`)) return
  try {
    await request('/admin/members/unbind', { method: 'POST', body: { userId: u.id } })
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '解绑失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

// ── BP 领域映射 ──
const toggling = ref(false)
const toggleDomain = async (u: { id: string }, d: string, enabled: boolean) => {
  if (toggling.value) return
  toggling.value = true
  actionError.value = null
  try {
    await request('/admin/members/bp-domains', {
      method: 'PUT',
      body: { userId: u.id, domain: d, enabled },
    })
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '配置失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    toggling.value = false
  }
}

const handleLogout = async () => { await auth.logout(); await router.replace('/login') }
</script>

<script lang="ts">export default { name: 'MembersView' }</script>

<style scoped>
.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.sync-btn { flex-shrink: 0; }
.btn-primary { background: var(--blue); color: #fff; border: none; padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; transition: transform .15s; }
.btn-primary:hover { transform: scale(1.03); }
.btn-primary:disabled { opacity: .6; cursor: default; }
.btn-sm { background: rgba(0,113,227,.08); color: var(--blue); border: none; padding: 5px 12px; border-radius: 999px; font-size: 12px; cursor: pointer; font-weight: 500; }
.btn-sm:hover { background: rgba(0,113,227,.15); }
.btn-sm.danger { background: rgba(255,69,58,.08); color: #ff453a; }

.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 12px; }
.stat-card { padding: 18px 20px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 4px; }
.stat-card.warn .stat-value { color: #ff9500; }
.stat-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.stat-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
.warn-line { font-size: 12px; color: #ff9500; margin: 4px 0 14px; }

.panel { padding: 18px 20px; border-radius: var(--radius-sm); margin-bottom: 16px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.panel-title { font-size: 14px; font-weight: 650; color: var(--text); }
.panel-hint { font-size: 11px; color: var(--text-tertiary); }
.search-input { padding: 7px 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,.08); background: #f5f5f7; font-size: 12px; outline: none; width: 180px; }
.search-input:focus { border-color: var(--blue); background: #fff; }

.member-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.member-table th { text-align: left; font-size: 11px; color: var(--text-tertiary); font-weight: 590; padding: 8px 10px; border-bottom: 1px solid rgba(0,0,0,.06); }
.member-table td { padding: 10px; border-bottom: 1px solid rgba(0,0,0,.04); color: var(--text); }
.member-table tr:last-child td { border-bottom: none; }
.domain-col { text-align: center; font-size: 12px; }
.role-chip { font-size: 10px; padding: 2px 8px; border-radius: 999px; background: rgba(0,113,227,.08); color: var(--blue); font-weight: 600; }
.bound-ok { font-size: 11px; color: #34c759; font-weight: 550; }
.bound-no { font-size: 11px; color: #8e8e93; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-card { background: #fff; border-radius: 20px; padding: 24px; width: 460px; max-width: 92vw; max-height: 86vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
.modal-title { font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; }
.field-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 12px 0 6px; }
.field-input { width: 100%; padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(0,0,0,.08); background: #f5f5f7; font-size: 13px; color: var(--text); outline: none; box-sizing: border-box; }
.field-input:focus { border-color: var(--blue); background: #fff; }
.contact-list { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow-y: auto; }
.contact-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid rgba(0,0,0,.06); border-radius: 12px; background: #fafafa; font-family: inherit; font-size: 13px; cursor: pointer; text-align: left; transition: all .15s; }
.contact-item:hover { border-color: var(--blue); background: rgba(0,113,227,.05); }
.contact-name { font-weight: 600; color: var(--text); }
.contact-mobile { font-size: 11px; color: var(--text-tertiary); }
.contact-id { margin-left: auto; font-size: 10px; color: #8e8e93; }
.empty-hint { font-size: 12px; color: var(--text-tertiary); padding: 12px 4px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
</style>
