<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { gsap } from 'gsap'
import { useRouter } from 'vue-router'
import bairongMark from '../../assets/bairong-intelligence-mark.png'
import { RequestError, request } from '../../api/client'
import ErrorState from '../../components/ErrorState.vue'
import UserAvatar from '../../components/UserAvatar.vue'
import LegalResponsibilities from '../../components/LegalResponsibilities.vue'
import { buildPagination } from '../../domain/legal-research'
import { useAuthStore } from '../../stores/auth'

type Member = {
  id: string
  username: string
  displayName: string
  role: string
  casUsername: string | null
  dingtalkUserId: string | null
  avatarUrl: string | null
  department: string | null
  loginStatus: 'pending' | 'active'
}
type BpMember = { id: string; displayName: string; avatarUrl: string | null; bound: boolean; domains: string[] }
type Contact = { userId: string; name: string; mobile?: string; avatarUrl?: string | null; department?: string }
type SyncSummary = {
  total: number
  autoBound: number
  ambiguous: string[]
  departmentCount?: number
  completedAt?: string
  complete?: boolean
  error?: string
}
type TabKey = 'users' | 'bp' | 'sync'
type BindingFilter = 'all' | 'bound' | 'unbound'

const PAGE_SIZE = 10
const router = useRouter()
const auth = useAuthStore()
const pageRoot = ref<HTMLElement | null>(null)
const syncing = ref(false)
const actingUserId = ref('')
const togglingKey = ref('')
const loadError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const syncResult = ref<SyncSummary | null>(null)
const failures = ref<number | null>(null)
const users = ref<Member[]>([])
const bpUsers = ref<BpMember[]>([])
const bpDomains = ref<string[]>([])
const userKeyword = ref('')
const activeTab = ref<TabKey>('users')
const bindingFilter = ref<BindingFilter>('all')
const currentPage = ref(1)
let animationContext: gsap.Context | null = null

const roleLabel = (role: string) => ({ legal_bp: '法务 BP', legal_lead: '法务负责人', business: '业务人员', admin: '管理员' })[role] || role
const roleClass = (role: string) => ({ legal_bp: 'bp', legal_lead: 'bp', admin: 'admin' })[role] || ''
const boundCount = computed(() => users.value.filter(user => user.dingtalkUserId).length)
const unboundCount = computed(() => users.value.length - boundCount.value)
const bpCount = computed(() => users.value.filter(user => user.role === 'legal_bp' || user.role === 'legal_lead').length)
const filteredUsers = computed(() => {
  const keyword = userKeyword.value.trim().toLocaleLowerCase()
  return users.value.filter((user) => {
    const matchesKeyword = !keyword || [user.displayName, user.department ?? '', roleLabel(user.role)]
      .some(value => value.toLocaleLowerCase().includes(keyword))
    const matchesBinding = bindingFilter.value === 'all'
      || (bindingFilter.value === 'bound' ? Boolean(user.dingtalkUserId) : !user.dingtalkUserId)
    return matchesKeyword && matchesBinding
  })
})
const totalPages = computed(() => Math.max(1, Math.ceil(filteredUsers.value.length / PAGE_SIZE)))
const pagination = computed(() => buildPagination(currentPage.value, totalPages.value))
const pagedUsers = computed(() => filteredUsers.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE))
const lastSyncTime = computed(() => syncResult.value?.completedAt ? formatDateTime(syncResult.value.completedAt) : '尚未同步')

const formatDateTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const animatePage = async () => {
  await nextTick()
  if (!pageRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  animationContext?.revert()
  animationContext = gsap.context(() => {
    gsap.from('.members-heading > *', { autoAlpha: 0, y: 14, duration: .5, stagger: .07, ease: 'power2.out' })
    gsap.from('.member-stat', { autoAlpha: 0, y: 12, duration: .42, stagger: .055, delay: .08, ease: 'power2.out' })
    gsap.from('.member-row', { autoAlpha: 0, y: 8, duration: .32, stagger: .035, delay: .16, ease: 'power2.out' })
  }, pageRoot.value)
}

const loadAll = async () => {
  try {
    const [userData, bpData, failData, syncData] = await Promise.all([
      request<{ items: Member[] } | Member[]>('/admin/members/users'),
      request<{ users: BpMember[]; domains: string[] }>('/admin/members/bp-domains'),
      request<{ noGroup: number }>('/admin/members/failures'),
      request<Omit<SyncSummary, 'ambiguous'> | null>('/admin/members/last-sync'),
    ])
    users.value = Array.isArray(userData) ? userData : userData.items ?? []
    const currentMember = users.value.find(user => user.id === auth.user?.id)
    if (auth.user && currentMember && auth.user.avatarUrl !== currentMember.avatarUrl) {
      // 成员同步/绑定/解绑可能同时改变当前管理员头像，立即刷新侧栏而无需重新登录。
      auth.user = { ...auth.user, avatarUrl: currentMember.avatarUrl }
    }
    bpUsers.value = bpData.users ?? []
    bpDomains.value = bpData.domains ?? []
    failures.value = failData.noGroup ?? null
    if (syncResult.value === null && syncData) syncResult.value = { ...syncData, ambiguous: [] }
    loadError.value = null
  } catch (error) {
    loadError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '成员数据加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
  if (currentPage.value > totalPages.value) currentPage.value = totalPages.value
  await animatePage()
}

const doSync = async () => {
  if (syncing.value) return
  syncing.value = true
  actionError.value = null
  try {
    const result = await request<SyncSummary>('/admin/members/sync', { method: 'POST' })
    if (result.complete === false) {
      throw new RequestError({ error: result.error || '通讯录同步未完成，请重试', code: 'SYNC_INCOMPLETE', statusCode: 502 })
    }
    syncResult.value = { ...result, completedAt: result.completedAt ?? new Date().toISOString() }
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '同步失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    syncing.value = false
  }
}

const bindTarget = ref<Pick<Member, 'id' | 'displayName'> | null>(null)
const contactKeyword = ref('')
const contacts = ref<Contact[]>([])
const contactError = ref<RequestError | null>(null)
let contactSearchSequence = 0

const openBind = (user: Member) => {
  bindTarget.value = { id: user.id, displayName: user.displayName }
  contactKeyword.value = ''
  contacts.value = []
  contactError.value = null
}
const closeBind = () => {
  bindTarget.value = null
  contacts.value = []
  contactKeyword.value = ''
  contactError.value = null
}
const searchContacts = async () => {
  const keyword = contactKeyword.value.trim()
  const sequence = ++contactSearchSequence
  if (!keyword) {
    contacts.value = []
    contactError.value = null
    return
  }
  try {
    const result = await request<Contact[]>(`/admin/members/contacts?keyword=${encodeURIComponent(keyword)}`)
    if (sequence !== contactSearchSequence) return
    contacts.value = result
    contactError.value = null
  } catch (error) {
    if (sequence !== contactSearchSequence) return
    contacts.value = []
    contactError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '通讯录搜索失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}
const doBind = async (contact: Contact) => {
  if (!bindTarget.value || actingUserId.value) return
  actingUserId.value = bindTarget.value.id
  actionError.value = null
  try {
    await request('/admin/members/bind', { method: 'POST', body: { userId: bindTarget.value.id, dingtalkUserId: contact.userId } })
    closeBind()
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '绑定失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    actingUserId.value = ''
  }
}

const provisionOpen = ref(false)
const provisionCasUsername = ref('')
const provisionContactKeyword = ref('')
const provisionContacts = ref<Contact[]>([])
const selectedProvisionContact = ref<Contact | null>(null)
const provisionError = ref<RequestError | null>(null)
const provisioning = ref(false)
let provisionSearchSequence = 0
const canProvision = computed(() => /^[A-Za-z0-9._-]+$/.test(provisionCasUsername.value.trim()) && Boolean(selectedProvisionContact.value))

const openProvision = async () => {
  provisionOpen.value = true
  provisionCasUsername.value = ''
  provisionContactKeyword.value = ''
  provisionContacts.value = []
  selectedProvisionContact.value = null
  provisionError.value = null
  await nextTick()
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.fromTo('.provision-modal', { autoAlpha: 0, y: 16, scale: .985 }, { autoAlpha: 1, y: 0, scale: 1, duration: .3, ease: 'power2.out' })
  }
}
const closeProvision = () => {
  if (provisioning.value) return
  provisionOpen.value = false
  provisionContacts.value = []
  selectedProvisionContact.value = null
  provisionError.value = null
  provisionSearchSequence++
}
const searchProvisionContacts = async () => {
  const keyword = provisionContactKeyword.value.trim()
  const sequence = ++provisionSearchSequence
  selectedProvisionContact.value = null
  if (!keyword) {
    provisionContacts.value = []
    provisionError.value = null
    return
  }
  try {
    const result = await request<Contact[]>(`/admin/members/contacts?keyword=${encodeURIComponent(keyword)}`)
    if (sequence !== provisionSearchSequence) return
    provisionContacts.value = result
    provisionError.value = null
  } catch (error) {
    if (sequence !== provisionSearchSequence) return
    provisionContacts.value = []
    provisionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '通讯录搜索失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}
const provisionMember = async () => {
  if (!canProvision.value || !selectedProvisionContact.value || provisioning.value) return
  provisioning.value = true
  provisionError.value = null
  try {
    await request('/admin/members/provision', {
      method: 'POST',
      body: {
        casUsername: provisionCasUsername.value.trim(),
        dingtalkUserId: selectedProvisionContact.value.userId,
      },
    })
    provisionOpen.value = false
    selectedProvisionContact.value = null
    provisionContacts.value = []
    activeTab.value = 'users'
    bindingFilter.value = 'all'
    currentPage.value = 1
    await loadAll()
  } catch (error) {
    provisionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '成员预开通失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    provisioning.value = false
  }
}
const unbind = async (user: Member) => {
  if (actingUserId.value || !window.confirm(`确认解绑 ${user.displayName} 的钉钉绑定？`)) return
  actingUserId.value = user.id
  actionError.value = null
  try {
    await request('/admin/members/unbind', { method: 'POST', body: { userId: user.id } })
    await loadAll()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '解绑失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    actingUserId.value = ''
  }
}
const toggleDomain = async (user: BpMember, domain: string, enabled: boolean) => {
  const key = `${user.id}:${domain}`
  if (togglingKey.value) return
  togglingKey.value = key
  actionError.value = null
  try {
    await request('/admin/members/bp-domains', { method: 'PUT', body: { userId: user.id, domain, enabled } })
    const target = bpUsers.value.find(item => item.id === user.id)
    if (target) target.domains = enabled ? [...new Set([...target.domains, domain])] : target.domains.filter(item => item !== domain)
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '工作范围配置失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    togglingKey.value = ''
  }
}
const selectTab = (tab: TabKey) => { activeTab.value = tab }
const selectFilter = (filter: BindingFilter) => { bindingFilter.value = filter }
const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === currentPage.value) return
  currentPage.value = page
}
const handleLogout = async () => { await auth.logout(); await router.replace('/login') }

watch([userKeyword, bindingFilter], () => { currentPage.value = 1 })
watch([activeTab, currentPage], async () => {
  await nextTick()
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  gsap.fromTo('.member-row', { autoAlpha: 0, y: 7 }, { autoAlpha: 1, y: 0, duration: .3, stagger: .03, ease: 'power2.out', overwrite: true })
})
onMounted(loadAll)
onBeforeUnmount(() => animationContext?.revert())
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <button
        class="admin-brand"
        aria-label="返回数据看板"
        @click="router.push('/admin/dashboard')"
      >
        <span class="admin-logo"><img
          :src="bairongMark"
          alt="百融智能"
        ></span>
        <span class="admin-brand-copy"><strong>LegalOS</strong><small>专业法务智能操作系统</small></span>
      </button>
      <span class="admin-nav-label">管理工具</span>
      <nav
        class="admin-nav"
        aria-label="管理工作台导航"
      >
        <button @click="router.push('/admin/dashboard')">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          ><path d="M4 13h6V3H4v10Zm10 8h6V11h-6v10ZM4 21h6v-4H4v4Zm10-14h6V3h-6v4Z" /></svg>数据看板
        </button>
        <button
          class="active"
          aria-current="page"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          ><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle
            cx="8.5"
            cy="7"
            r="4"
          /><path d="M20 8v6M23 11h-6" /></svg>成员管理
        </button>
        <button disabled>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          ><circle
            cx="12"
            cy="12"
            r="9"
          /><path d="M12 7v5l3 2" /></svg>定时任务
        </button>
        <button disabled>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></svg>审计日志
        </button>
      </nav>
      <div class="admin-user">
        <UserAvatar
          class="admin-avatar"
          :src="auth.user?.avatarUrl"
          :name="auth.user?.displayName"
          fallback="管"
        />
        <span class="admin-user-copy"><strong>{{ auth.user?.displayName || '系统管理员' }}</strong><small>管理员</small></span>
        <button
          class="admin-logout"
          aria-label="退出登录"
          title="退出登录"
          @click="handleLogout"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>
        </button>
      </div>
    </aside>

    <main
      ref="pageRoot"
      class="members-page"
    >
      <p class="members-breadcrumb">
        管理工作台 <span>/</span> 成员管理
      </p>
      <header class="members-heading">
        <div><h1>成员管理</h1><p>统一管理系统账号、钉钉身份绑定与法务 BP 工作范围</p></div>
        <div class="heading-actions">
          <button
            class="provision-button"
            type="button"
            @click="openProvision"
          >
            <span>＋</span>预开通成员
          </button>
          <button
            class="sync-button"
            type="button"
            :disabled="syncing"
            @click="doSync"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="M20 11a8 8 0 0 0-15-3M4 4v4h4M4 13a8 8 0 0 0 15 3M20 20v-4h-4" /></svg>
            {{ syncing ? '正在同步' : '同步钉钉通讯录' }}
          </button>
        </div>
      </header>

      <ErrorState
        v-if="loadError"
        class="members-error"
        :message="loadError.payload.error"
        :request-id="loadError.payload.requestId"
        :on-retry="loadAll"
      />
      <template v-else>
        <section
          class="members-stats"
          aria-label="成员统计"
        >
          <div class="member-stat">
            <span>通讯录成员</span><strong>{{ syncResult?.total ?? '—' }}</strong>
          </div>
          <div class="member-stat">
            <span>已绑定系统用户</span><strong>{{ boundCount }}</strong>
          </div>
          <div class="member-stat">
            <span>法务 BP</span><strong>{{ bpCount }}</strong>
          </div>
          <div class="member-stat attention">
            <span>需要处理</span><strong>{{ unboundCount }}</strong>
          </div>
        </section>

        <nav
          class="member-tabs"
          aria-label="成员管理分类"
        >
          <button
            :class="{ active: activeTab === 'users' }"
            @click="selectTab('users')"
          >
            系统用户
          </button>
          <button
            :class="{ active: activeTab === 'bp' }"
            @click="selectTab('bp')"
          >
            法务 BP 工作范围
          </button>
          <button
            :class="{ active: activeTab === 'sync' }"
            @click="selectTab('sync')"
          >
            同步记录
          </button>
        </nav>

        <ErrorState
          v-if="actionError"
          class="action-error"
          :message="actionError.payload.error"
          :request-id="actionError.payload.requestId"
        />

        <template v-if="activeTab === 'users'">
          <div class="member-toolbar">
            <label class="member-search">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              ><circle
                cx="11"
                cy="11"
                r="7"
              /><path d="m20 20-4-4" /></svg>
              <input
                v-model="userKeyword"
                type="search"
                placeholder="搜索姓名、部门或角色"
              >
            </label>
            <div
              class="binding-filters"
              aria-label="绑定状态"
            >
              <button
                :class="{ active: bindingFilter === 'all' }"
                @click="selectFilter('all')"
              >
                全部 {{ users.length }}
              </button>
              <button
                :class="{ active: bindingFilter === 'bound' }"
                @click="selectFilter('bound')"
              >
                已绑定 {{ boundCount }}
              </button>
              <button
                :class="{ active: bindingFilter === 'unbound' }"
                @click="selectFilter('unbound')"
              >
                未绑定 {{ unboundCount }}
              </button>
            </div>
            <span class="last-sync">最近同步：{{ lastSyncTime }}</span>
          </div>

          <section class="member-table-shell">
            <div class="member-table-head">
              <span>成员</span><span>角色</span><span>部门</span><span>钉钉绑定</span><span>操作</span>
            </div>
            <div
              v-for="user in pagedUsers"
              :key="user.id"
              class="member-row"
            >
              <span class="member-identity"><UserAvatar
                class="member-avatar"
                :src="user.avatarUrl"
                :name="user.displayName"
              /><span><strong>{{ user.displayName }}</strong><small v-if="user.casUsername">CAS {{ user.casUsername }} · {{ user.loginStatus === 'pending' ? '待首次登录' : '已登录' }}</small><small v-else>本地账号</small></span></span>
              <span><em :class="['role-badge', roleClass(user.role)]">{{ roleLabel(user.role) }}</em></span>
              <span>{{ user.department || '—' }}</span>
              <span class="binding-state"><i :class="{ off: !user.dingtalkUserId }" /><span>{{ user.dingtalkUserId ? '已绑定' : '未绑定' }} <small v-if="user.dingtalkUserId">{{ user.dingtalkUserId }}</small></span></span>
              <span class="row-operation">
                <button
                  v-if="user.dingtalkUserId"
                  type="button"
                  :disabled="actingUserId === user.id"
                  @click.stop="unbind(user)"
                >{{ actingUserId === user.id ? '处理中' : '解绑' }}</button>
                <button
                  v-else
                  class="bind"
                  type="button"
                  @click.stop="openBind(user)"
                >绑定</button>
              </span>
            </div>
            <div
              v-if="!pagedUsers.length"
              class="empty-table"
            >
              没有符合条件的系统用户
            </div>
          </section>
          <footer class="member-pagination">
            <span>共 {{ filteredUsers.length }} 名系统用户，每页 {{ PAGE_SIZE }} 条</span>
            <nav aria-label="系统用户分页">
              <button
                aria-label="上一页"
                :disabled="currentPage <= 1"
                @click="goToPage(currentPage - 1)"
              >
                ‹
              </button>
              <template
                v-for="item in pagination"
                :key="item.key"
              >
                <span v-if="item.type === 'ellipsis'">…</span>
                <button
                  v-else
                  :class="{ active: item.page === currentPage }"
                  :aria-current="item.page === currentPage ? 'page' : undefined"
                  @click="goToPage(item.page)"
                >
                  {{ item.page }}
                </button>
              </template>
              <button
                aria-label="下一页"
                :disabled="currentPage >= totalPages"
                @click="goToPage(currentPage + 1)"
              >
                ›
              </button>
            </nav>
          </footer>
        </template>

        <template v-else-if="activeTab === 'bp'">
          <LegalResponsibilities />
          <div class="section-intro">
            <div><strong>法务专业领域标签</strong><span>以下标签保留作专业能力资料，不再用于自动指派。工单按上方业务职责规则分配。</span></div><small>共 {{ bpUsers.length }} 名法务成员</small>
          </div>
          <section class="domain-table-shell">
            <div
              class="domain-table-head"
              :style="{ '--domain-count': bpDomains.length }"
            >
              <span>法务成员</span><span>钉钉状态</span><span
                v-for="domain in bpDomains"
                :key="domain"
              >{{ domain }}</span>
            </div>
            <div
              v-for="user in bpUsers"
              :key="user.id"
              class="domain-row member-row"
              :style="{ '--domain-count': bpDomains.length }"
            >
              <span class="member-identity"><UserAvatar
                class="member-avatar"
                :src="user.avatarUrl"
                :name="user.displayName"
              /><strong>{{ user.displayName }}</strong></span>
              <span class="binding-state"><i :class="{ off: !user.bound }" /><span>{{ user.bound ? '已绑定' : '未绑定' }}</span></span>
              <label
                v-for="domain in bpDomains"
                :key="domain"
                class="domain-check"
              >
                <input
                  type="checkbox"
                  :checked="user.domains.includes(domain)"
                  :disabled="Boolean(togglingKey)"
                  @change="toggleDomain(user, domain, ($event.target as HTMLInputElement).checked)"
                >
                <span />
              </label>
            </div>
            <div
              v-if="!bpUsers.length"
              class="empty-table"
            >
              暂无可配置的法务 BP
            </div>
          </section>
        </template>

        <template v-else>
          <div class="section-intro">
            <div><strong>最近一次通讯录同步</strong><span>同步失败不会覆盖上一份成功的通讯录快照和现有绑定。</span></div><button
              type="button"
              :disabled="syncing"
              @click="doSync"
            >
              {{ syncing ? '正在同步' : '立即同步' }}
            </button>
          </div>
          <section class="sync-summary-card member-row">
            <div><span>完成时间</span><strong>{{ lastSyncTime }}</strong></div>
            <div><span>同步成员</span><strong>{{ syncResult?.total ?? '—' }}</strong></div>
            <div><span>自动绑定</span><strong>{{ syncResult?.autoBound ?? '—' }}</strong></div>
            <div><span>部门数量</span><strong>{{ syncResult?.departmentCount ?? '—' }}</strong></div>
            <div><span>拉群待处理</span><strong>{{ failures ?? '—' }}</strong></div>
          </section>
        </template>

        <div
          v-if="unboundCount || syncResult?.ambiguous.length"
          class="member-notice"
        >
          发现 {{ unboundCount }} 名未绑定系统用户<template v-if="syncResult?.ambiguous.length">
            ，其中 {{ syncResult.ambiguous.length }} 个姓名存在重名或无法唯一匹配
          </template>。系统不会自动绑定重名账号，请人工确认。
        </div>
      </template>
    </main>

    <div
      v-if="bindTarget"
      class="bind-modal-mask"
      @click.self="closeBind"
    >
      <section
        class="bind-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`绑定钉钉成员：${bindTarget.displayName}`"
      >
        <header>
          <div><h2>绑定钉钉成员</h2><p>为 {{ bindTarget.displayName }} 选择唯一的通讯录身份</p></div><button
            aria-label="关闭"
            @click="closeBind"
          >
            ×
          </button>
        </header>
        <label class="bind-search"><span>搜索钉钉通讯录</span><input
          v-model="contactKeyword"
          placeholder="输入姓名或手机号"
          @input="searchContacts"
        ></label>
        <ErrorState
          v-if="contactError"
          :message="contactError.payload.error"
          :request-id="contactError.payload.requestId"
          :on-retry="searchContacts"
        />
        <div class="contact-list">
          <button
            v-for="contact in contacts"
            :key="contact.userId"
            class="contact-item"
            :disabled="Boolean(actingUserId)"
            @click="doBind(contact)"
          >
            <span class="contact-person"><UserAvatar
              class="contact-avatar"
              :src="contact.avatarUrl"
              :name="contact.name"
            /><span class="contact-copy"><strong>{{ contact.name }}</strong><small>{{ contact.mobile || '未提供手机号' }}</small></span></span><code>{{ contact.userId }}</code>
          </button>
          <p
            v-if="!contacts.length && contactKeyword"
            class="contact-empty"
          >
            未找到匹配成员，请先同步通讯录或调整关键词。
          </p>
          <p
            v-else-if="!contactKeyword"
            class="contact-empty"
          >
            输入姓名或手机号开始搜索。
          </p>
        </div>
      </section>
    </div>

    <div
      v-if="provisionOpen"
      class="bind-modal-mask"
      @click.self="closeProvision"
    >
      <form
        class="bind-modal provision-modal"
        role="dialog"
        aria-modal="true"
        aria-label="预开通成员"
        @submit.prevent="provisionMember"
      >
        <header>
          <div><h2>预开通成员</h2><p>在首次登录前建立 CAS 账号，并绑定可信的钉钉组织身份</p></div><button
            type="button"
            aria-label="关闭"
            @click="closeProvision"
          >
            ×
          </button>
        </header>
        <div class="provision-form-body">
          <label class="bind-search provision-account"><span>CAS 登录账号</span><input
            v-model="provisionCasUsername"
            autocomplete="off"
            placeholder="例如 jun.wang1"
          ><small>账号必须与 CAS 后台开通的登录账号完全一致。</small></label>
          <label class="bind-search"><span>匹配钉钉成员</span><input
            v-model="provisionContactKeyword"
            placeholder="输入姓名或手机号"
            @input="searchProvisionContacts"
          ></label>
          <ErrorState
            v-if="provisionError"
            class="provision-error"
            :message="provisionError.payload.error"
            :request-id="provisionError.payload.requestId"
          />
          <div class="contact-list provision-contact-list">
            <button
              v-for="contact in provisionContacts"
              :key="contact.userId"
              type="button"
              :class="['contact-item', { selected: selectedProvisionContact?.userId === contact.userId }]"
              :aria-pressed="selectedProvisionContact?.userId === contact.userId"
              @click="selectedProvisionContact = contact"
            >
              <span class="contact-person"><UserAvatar
                class="contact-avatar"
                :src="contact.avatarUrl"
                :name="contact.name"
              /><span class="contact-copy"><strong>{{ contact.name }}</strong><small>{{ contact.department || '未提供部门' }} · {{ contact.mobile || '未提供手机号' }}</small></span></span><code>{{ selectedProvisionContact?.userId === contact.userId ? '已选择' : contact.userId }}</code>
            </button>
            <p
              v-if="!provisionContacts.length && provisionContactKeyword"
              class="contact-empty"
            >
              未找到可预开通的成员。请先同步钉钉通讯录，或确认该身份尚未被占用。
            </p>
            <p
              v-else-if="!provisionContactKeyword"
              class="contact-empty"
            >
              先搜索并选择唯一的钉钉成员，系统将据此写入姓名、部门和角色。
            </p>
          </div>
        </div>
        <footer class="provision-actions">
          <span>开通后状态为“待首次登录”</span>
          <button
            type="button"
            :disabled="provisioning"
            @click="closeProvision"
          >
            取消
          </button>
          <button
            class="primary"
            type="submit"
            :disabled="!canProvision || provisioning"
          >
            {{ provisioning ? '正在开通' : '确认预开通' }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>

<script lang="ts">export default { name: 'MembersView' }</script>

<style scoped>
.admin-shell{min-height:100vh;background:#f7f8fa;color:#111827;font-family:Outfit,Geist,"Noto Sans SC","PingFang SC",-apple-system,BlinkMacSystemFont,sans-serif}.admin-sidebar{position:fixed;inset:0 auto 0 0;z-index:20;display:flex;width:254px;height:100vh;flex-direction:column;border-right:1px solid #e3e8ef;background:#fff}.admin-brand{display:flex;min-height:152px;padding:30px 27px;align-items:flex-start;gap:12px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.admin-logo{display:grid;width:47px;height:47px;overflow:hidden;place-items:center}.admin-logo img{display:block;width:47px;height:47px;object-fit:contain}.admin-brand-copy{display:grid;padding-top:3px;gap:10px}.admin-brand-copy strong{color:#0f172a;font-size:24px;font-weight:720;letter-spacing:-.04em}.admin-brand-copy small{width:150px;color:#526174;font-size:12px;letter-spacing:.12em;line-height:1.65}.admin-nav-label{margin:5px 35px 10px;color:#9aa4b2;font-size:10px;font-weight:650;letter-spacing:.12em}.admin-nav{display:grid}.admin-nav button{position:relative;display:flex;width:100%;height:64px;padding:0 35px;align-items:center;gap:15px;border:0;background:#fff;color:#26344d;font:inherit;font-size:14px;font-weight:580;text-align:left;cursor:pointer}.admin-nav button.active{background:#f1f6ff;color:#1260ee;font-weight:650}.admin-nav button.active::before{position:absolute;inset:0 auto 0 0;width:4px;background:#1b66f0;content:""}.admin-nav button:disabled{color:#99a4b4;cursor:default}.admin-nav svg{width:20px;height:20px}.admin-user{display:flex;min-height:108px;margin:auto 24px 0;padding:18px 7px;align-items:center;gap:11px;border-top:1px solid #e5e9ef}.admin-avatar{display:grid;width:44px;height:44px;border-radius:50%;place-items:center;background:#1764ef;color:#fff;font-weight:700}.admin-user-copy{display:grid;min-width:0;gap:3px}.admin-user-copy strong,.admin-user-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.admin-user-copy strong{font-size:13px}.admin-user-copy small{color:#6b7280;font-size:12px}.admin-logout{display:grid;width:36px;height:36px;margin-left:auto;padding:0;border:0;border-radius:6px;place-items:center;background:transparent;color:#60708a;cursor:pointer}.admin-logout:hover{background:#f1f5f9;color:#1764ef}.admin-logout svg{width:20px;height:20px}
.members-page{height:100vh;margin-left:254px;padding:30px 38px 34px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.members-breadcrumb{margin:0 0 24px;color:#5f6e84;font-size:13px}.members-breadcrumb span{margin:0 9px;color:#a4adba}.members-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}.members-heading h1{margin:0 0 8px;color:#0b1222;font-size:38px;font-weight:690;letter-spacing:-.045em}.members-heading p{margin:0;color:#66758a;font-size:13px}.sync-button{display:flex;height:44px;padding:0 17px;align-items:center;gap:8px;border:1px solid #1764ef;border-radius:6px;background:#1764ef;color:#fff;font:inherit;font-size:13px;font-weight:650;cursor:pointer}.sync-button:hover:not(:disabled){background:#0755d8}.sync-button:disabled{opacity:.55;cursor:wait}.sync-button svg{width:17px;height:17px}.members-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:25px;border:1px solid #dce3ec;border-radius:8px;background:#fff}.member-stat{position:relative;display:grid;min-height:88px;padding:18px 27px;align-content:space-between}.member-stat+.member-stat::before{position:absolute;inset:17px auto 17px 0;width:1px;background:#e0e6ee;content:""}.member-stat span{color:#66758a;font-size:11px}.member-stat strong{font-size:27px;font-weight:650;letter-spacing:-.04em}.member-stat.attention strong{color:#db6b24}.member-tabs{display:flex;height:54px;margin-top:20px;border-bottom:1px solid #dce3ec;align-items:flex-end;gap:30px}.member-tabs button{position:relative;height:54px;padding:0 4px;border:0;background:transparent;color:#5d6b80;font:inherit;font-size:13px;font-weight:600;cursor:pointer}.member-tabs button.active{color:#1764ef}.member-tabs button.active::after{position:absolute;inset:auto 0 -1px;height:3px;background:#1764ef;content:""}.members-error,.action-error{margin-top:18px}.member-toolbar{display:flex;min-height:67px;align-items:center;gap:18px}.member-search{display:flex;width:310px;height:40px;padding:0 12px;align-items:center;gap:8px;border:1px solid #d5dde7;border-radius:6px;background:#fff}.member-search svg{width:17px;height:17px;color:#718096}.member-search input{min-width:0;flex:1;border:0;outline:0;color:#334155;font:inherit;font-size:12px}.binding-filters{display:flex;gap:9px}.binding-filters button,.section-intro>button{height:36px;padding:0 12px;border:1px solid #d5dde7;border-radius:5px;background:#fff;color:#59677b;font:inherit;font-size:11px;cursor:pointer}.binding-filters button.active{border-color:#9dbbf1;background:#f4f8ff;color:#1764ef}.last-sync{margin-left:auto;color:#8490a1;font-size:11px}
.member-table-shell,.domain-table-shell{overflow:auto;border:1px solid #dce3ec;border-radius:7px 7px 0 0;background:#fff}.member-table-head,.member-row{display:grid;min-width:900px;grid-template-columns:1.15fr .9fr 1.35fr 1.4fr .75fr;align-items:center;column-gap:15px}.member-table-head{height:43px;padding:0 21px;border-bottom:1px solid #e4e9ef;background:#fafbfc;color:#6c788a;font-size:11px;font-weight:650}.member-table-shell>.member-row{width:100%;min-height:54px;padding:0 21px;border:0;border-bottom:1px solid #e8ecf2;background:#fff;color:#46556a;font:inherit;font-size:12px;text-align:left;cursor:default}.member-table-shell>.member-row:hover{background:#f8faff}.member-identity{display:flex;align-items:center;gap:10px;color:#1f2b3d}.member-avatar{width:30px;height:30px;border-radius:50%;background:#edf3ff;color:#1764ef;font-size:11px;font-weight:700}.member-identity strong{font-weight:620}.role-badge{display:inline-flex;width:max-content;height:24px;padding:0 8px;align-items:center;border-radius:4px;background:#eef3f9;color:#4d5e76;font-style:normal;font-size:10px;font-weight:650}.role-badge.bp{background:#eaf8ef;color:#15804a}.role-badge.admin{background:#f2edff;color:#6e50b5}.binding-state{display:flex;align-items:center;gap:7px}.binding-state>i{width:7px;height:7px;border-radius:50%;background:#16a05d}.binding-state>i.off{background:#c0c8d2}.binding-state small{color:#8792a2;font-size:10px}.row-operation button{height:29px;padding:0 10px;border:1px solid #b9c8dc;border-radius:5px;background:#fff;color:#315a91;font:inherit;font-size:10px;cursor:pointer}.row-operation button.bind{border-color:#8db2f3;color:#1764ef}.row-operation button:disabled{opacity:.5;cursor:wait}.empty-table{display:grid;min-height:180px;place-items:center;color:#7b8798;font-size:12px}.member-pagination{display:flex;min-height:51px;padding:9px 15px;align-items:center;justify-content:space-between;border:1px solid #dce3ec;border-top:0;border-radius:0 0 7px 7px;background:#fff;color:#7b8798;font-size:11px}.member-pagination nav{display:flex;gap:6px;align-items:center}.member-pagination button{display:grid;min-width:30px;height:30px;padding:0 8px;border:1px solid #d5dde7;border-radius:5px;place-items:center;background:#fff;color:#526174;font:inherit;font-size:11px;cursor:pointer}.member-pagination button.active{border-color:#1764ef;color:#1764ef;box-shadow:inset 0 0 0 1px #1764ef}.member-pagination button:disabled{opacity:.35;cursor:not-allowed}.member-pagination nav>span{min-width:20px;text-align:center}.member-notice{display:flex;min-height:38px;margin-top:14px;padding:9px 13px;align-items:center;border:1px solid #f1d9bd;border-radius:5px;background:#fffaf3;color:#9a672b;font-size:11px;line-height:1.5}
.section-intro{display:flex;min-height:67px;align-items:center;justify-content:space-between;gap:20px}.section-intro>div{display:grid;gap:4px}.section-intro strong{color:#27364c;font-size:13px}.section-intro span{color:#7b8798;font-size:11px}.section-intro small{color:#8490a1;font-size:11px}.domain-table-shell{border-radius:7px}.domain-table-head,.domain-row{display:grid;min-width:1000px;grid-template-columns:220px 130px repeat(var(--domain-count),minmax(105px,1fr));align-items:center}.domain-table-head{min-height:43px;padding:0 20px;border-bottom:1px solid #e4e9ef;background:#fafbfc;color:#6c788a;font-size:11px;font-weight:650}.domain-table-head span:nth-child(n+3){text-align:center}.domain-row{min-height:56px;padding:0 20px;border-bottom:1px solid #e8ecf2;color:#46556a;font-size:12px}.domain-row:last-child{border-bottom:0}.domain-check{display:grid;place-items:center;cursor:pointer}.domain-check input{position:absolute;width:1px;height:1px;opacity:0}.domain-check span{display:grid;width:18px;height:18px;border:1px solid #c4ceda;border-radius:4px;place-items:center;background:#fff}.domain-check input:checked+span{border-color:#1764ef;background:#1764ef}.domain-check input:checked+span::after{width:8px;height:4px;border-bottom:2px solid #fff;border-left:2px solid #fff;content:"";transform:translateY(-1px) rotate(-45deg)}.domain-check input:focus-visible+span{outline:2px solid #8eb5f6;outline-offset:2px}.domain-check input:disabled+span{opacity:.55;cursor:wait}.sync-summary-card{display:grid;min-width:0;grid-template-columns:1.6fr repeat(4,1fr);overflow:hidden;border:1px solid #dce3ec;border-radius:7px;background:#fff}.sync-summary-card>div{position:relative;display:grid;min-height:112px;padding:22px;align-content:space-between;gap:14px}.sync-summary-card>div+div::before{position:absolute;inset:20px auto 20px 0;width:1px;background:#e3e8ef;content:""}.sync-summary-card span{color:#718096;font-size:11px}.sync-summary-card strong{color:#223047;font-size:18px;font-weight:650}
.bind-modal-mask{position:fixed;inset:0;z-index:100;display:grid;padding:24px;place-items:center;background:rgba(15,23,42,.38);backdrop-filter:blur(5px)}.bind-modal{width:min(480px,100%);max-height:min(620px,88vh);overflow-y:auto;border:1px solid #dbe3ed;border-radius:10px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.2)}.bind-modal>header{display:flex;padding:21px 22px 16px;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #e7ebf0}.bind-modal h2{margin:0 0 5px;color:#172033;font-size:19px}.bind-modal header p{margin:0;color:#718096;font-size:12px}.bind-modal header button{display:grid;width:30px;height:30px;border:0;border-radius:5px;place-items:center;background:#f3f5f8;color:#526174;font-size:20px;cursor:pointer}.bind-search{display:grid;padding:18px 22px 10px;gap:7px;color:#526174;font-size:11px;font-weight:600}.bind-search input{height:40px;padding:0 12px;border:1px solid #d5dde7;border-radius:6px;outline:0;color:#27364c;font:inherit;font-size:13px}.bind-search input:focus{border-color:#8db2f3;box-shadow:0 0 0 3px rgba(23,100,239,.08)}.contact-list{display:grid;max-height:330px;padding:6px 22px 22px;gap:7px;overflow-y:auto}.contact-item{display:flex;min-height:58px;padding:8px 11px;align-items:center;justify-content:space-between;gap:16px;border:1px solid #dfe5ec;border-radius:6px;background:#fff;color:#26344d;text-align:left;cursor:pointer}.contact-item:hover{border-color:#8db2f3;background:#f7faff}.contact-person{display:flex;min-width:0;align-items:center;gap:9px}.contact-avatar{width:34px;height:34px;border-radius:50%;background:#edf3ff;color:#1764ef;font-size:11px;font-weight:700}.contact-copy{display:grid;min-width:0;gap:3px}.contact-item strong{font-size:12px}.contact-item small{color:#8490a1;font-size:10px}.contact-item code{color:#60708a;font-size:10px}.contact-empty{margin:0;padding:28px 8px;color:#8490a1;font-size:12px;text-align:center}
.heading-actions{display:flex;align-items:center;gap:10px}.provision-button{display:flex;height:44px;padding:0 17px;align-items:center;gap:7px;border:1px solid #1764ef;border-radius:6px;background:#fff;color:#1764ef;font:inherit;font-size:13px;font-weight:650;cursor:pointer}.provision-button:hover{background:#f3f7ff}.provision-button span{font-size:18px;font-weight:450}.member-identity>span{display:grid;min-width:0;gap:2px}.member-identity>span small{overflow:hidden;color:#8994a5;font-size:9px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.contact-item.selected{border-color:#8db2f3;background:#f7faff;box-shadow:inset 3px 0 #1764ef}.provision-modal{width:min(560px,100%)}.provision-form-body{padding-bottom:4px}.provision-form-body .bind-search{padding-bottom:4px}.provision-account small{color:#8a95a5;font-size:10px;font-weight:450}.provision-contact-list{max-height:250px;padding-top:8px;padding-bottom:14px}.provision-error{margin:10px 22px 0}.provision-actions{display:flex;min-height:67px;padding:13px 22px;align-items:center;gap:9px;border-top:1px solid #e7ebf0}.provision-actions>span{margin-right:auto;color:#7f8b9c;font-size:10px}.provision-actions button{height:36px;padding:0 14px;border:1px solid #ccd5e0;border-radius:5px;background:#fff;color:#536176;font:inherit;font-size:11px;font-weight:600;cursor:pointer}.provision-actions button.primary{border-color:#1764ef;background:#1764ef;color:#fff}.provision-actions button:disabled{opacity:.48;cursor:not-allowed}
@media(max-width:1100px){.members-page{padding-right:26px;padding-left:26px}.last-sync{display:none}.member-search{width:260px}.sync-summary-card{grid-template-columns:repeat(2,1fr)}.sync-summary-card>div:first-child{grid-column:1/-1}.sync-summary-card>div:nth-child(2)::before{display:none}}
@media(max-width:760px){.admin-sidebar{width:78px}.admin-brand{min-height:96px;padding:22px 16px}.admin-logo{width:46px}.admin-brand-copy,.admin-nav-label,.admin-nav button:not(.active),.admin-nav button.active{font-size:0}.admin-nav button{justify-content:center;padding:0}.admin-nav svg{width:21px;height:21px}.admin-user{justify-content:center;margin:0 12px;padding-right:0;padding-left:0}.admin-user-copy,.admin-logout{display:none}.members-page{margin-left:78px;padding:22px 18px 30px}.members-heading h1{font-size:32px}.members-heading p{display:none}.sync-button{width:44px;padding:0;justify-content:center;font-size:0}.members-stats{grid-template-columns:repeat(2,1fr)}.member-stat:nth-child(3)::before{display:none}.member-tabs{gap:16px;overflow-x:auto}.member-tabs button{white-space:nowrap}.member-toolbar{align-items:stretch;flex-direction:column;padding:14px 0}.member-search{width:100%}.last-sync{display:block}.member-pagination{align-items:flex-start;flex-direction:column;gap:10px}.sync-summary-card{grid-template-columns:1fr}.sync-summary-card>div:first-child{grid-column:auto}.sync-summary-card>div+div::before{display:none}}
@media(max-width:760px){.heading-actions{gap:7px}.provision-button{height:44px;padding:0 10px;font-size:11px}.provision-actions{align-items:stretch;flex-wrap:wrap}.provision-actions>span{width:100%;margin:0}.provision-actions button{flex:1}}
</style>
