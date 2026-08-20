<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { request, RequestError } from '../../api/client'
import { useAuthStore } from '../../stores/auth'

type Mode = 'laws' | 'cases'
type SearchState = { query: string; loading: boolean; result: any | null; previous: any | null; error: RequestError | null }
const router = useRouter()
const auth = useAuthStore()
const mode = ref<Mode>('laws')
const state = reactive<Record<Mode, SearchState>>({
  laws: { query: '', loading: false, result: null, previous: null, error: null },
  cases: { query: '', loading: false, result: null, previous: null, error: null },
})

const search = async () => {
  const current = state[mode.value]
  const query = current.query.trim()
  if (!query || current.loading) return
  current.previous = current.result
  current.result = null
  current.error = null
  current.loading = true
  try {
    current.result = mode.value === 'laws'
      ? await request(`/legal-research/laws?keyword=${encodeURIComponent(query)}&page=1&rows=10`)
      : await request(`/legal-research/cases?query=${encodeURIComponent(query)}&topK=5`)
  } catch (error) {
    current.error = error instanceof RequestError
      ? error
      : new RequestError({ error: '检索失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    current.loading = false
  }
}

const restorePrevious = () => {
  const current = state[mode.value]
  current.result = current.previous
  current.error = null
}
async function logout() { await auth.logout(); await router.replace('/login') }
</script>

<template>
  <div class="app-shell research-shell">
    <div class="aurora">
      <div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" />
    </div>
    <aside class="app-sidebar sidebar-glass">
      <button
        class="app-brand"
        @click="router.push('/legal/projects')"
      >
        <span class="brand-icon">⚖</span><span class="brand-text"><b>法务 Legal OS</b><small>法律团队项目空间</small></span>
      </button>
      <div class="nav-section">
        <span class="nav-label">项目</span>
        <button
          class="nav-btn"
          @click="router.push('/legal/projects')"
        >
          ▤　工单管理
        </button>
        <button class="nav-btn active">
          ⌕　法规与类案检索
        </button>
        <button
          class="nav-btn"
          @click="router.push('/legal/skills')"
        >
          ▧　技能库
        </button>
      </div>
      <div class="sidebar-footer">
        <div class="user-avatar">
          {{ auth.user?.displayName?.[0] || '法' }}
        </div>
        <div class="user-info">
          <span class="user-name">{{ auth.user?.displayName }}</span><span class="user-role">法务工作台</span>
        </div>
        <button
          class="logout-link"
          title="退出登录"
          @click="logout"
        >
          ↗
        </button>
      </div>
    </aside>

    <main class="app-main">
      <header class="app-topbar topbar-glass">
        <div class="tb-left">
          <small>法务 Legal OS</small><strong>法律检索</strong>
        </div>
      </header>
      <section class="app-content research-content">
        <div class="desktop-notice">
          一期检索工作台仅支持宽度 1024px 以上的桌面端。
        </div>
        <div class="research-panel glass-card">
          <div
            class="mode-tabs"
            role="tablist"
            aria-label="检索类型"
          >
            <button
              :class="{ active: mode === 'laws' }"
              role="tab"
              :aria-selected="mode === 'laws'"
              @click="mode = 'laws'"
            >
              国内法规
            </button>
            <button
              :class="{ active: mode === 'cases' }"
              role="tab"
              :aria-selected="mode === 'cases'"
              @click="mode = 'cases'"
            >
              类案
            </button>
          </div>
          <form
            class="search-form"
            @submit.prevent="search"
          >
            <label :for="`research-${mode}`">{{ mode === 'laws' ? '法规关键词' : '法律问题' }}</label>
            <div class="search-line">
              <input
                :id="`research-${mode}`"
                v-model="state[mode].query"
                :placeholder="mode === 'laws' ? '例如：劳动合同解除经济补偿' : '例如：劳动合同违法解除经济补偿的中国类似案例'"
                :disabled="state[mode].loading"
              >
              <button
                type="submit"
                :disabled="!state[mode].query.trim() || state[mode].loading"
              >
                {{ state[mode].loading ? '检索中…' : '检索' }}
              </button>
            </div>
          </form>

          <div
            v-if="state[mode].loading"
            class="results"
            aria-live="polite"
          >
            <p class="loading-title">
              正在检索：{{ state[mode].query }}
            </p>
            <div
              v-for="i in 5"
              :key="i"
              class="result-skeleton"
            >
              <span /><span /><span />
            </div>
          </div>
          <div
            v-else-if="state[mode].error"
            class="near-error"
            role="alert"
          >
            <strong>{{ state[mode].error?.payload.error }}</strong>
            <div>
              <button @click="search">
                重试
              </button><button
                v-if="state[mode].previous"
                @click="restorePrevious"
              >
                查看上次结果
              </button>
            </div>
          </div>
          <div
            v-else-if="state[mode].result"
            class="results"
          >
            <div class="result-meta">
              命中 {{ state[mode].result.count }} 条 · 本页 {{ state[mode].result.records?.length || 0 }} 条
            </div>
            <div
              class="result-table"
              role="table"
            >
              <div
                v-for="record in state[mode].result.records"
                :key="record.recordId"
                class="result-row"
                role="row"
              >
                <div class="result-title">
                  <strong>{{ record.lawName || record.title }}</strong><small>ID {{ record.recordId }}</small>
                </div>
                <span>{{ record.issuingOrgan || record.court || '—' }}</span>
                <span>{{ record.issuingNo || record.caseNumber || '—' }}</span>
                <span>{{ record.implementDate || record.date || '—' }}</span>
                <span>{{ record.timeliness || record.country || '—' }}</span>
                <a
                  v-if="record.url"
                  :href="record.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >原始来源</a>
              </div>
            </div>
            <div
              v-if="!state[mode].result.records?.length"
              class="empty"
            >
              未找到匹配结果，请调整关键词后重试。
            </div>
          </div>
          <div
            v-else
            class="empty"
          >
            选择检索类型并输入内容。法规只返回元数据，不代表已核验具体条文。
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.tb-left { display:flex; align-items:baseline; gap:10px; }.tb-left small{color:var(--text-tertiary);font-size:11px}.tb-left strong{font-size:14px}
.research-content { max-width: 1440px; margin: 0 auto; width: 100%; }.research-panel{min-height:620px;padding:24px;border-radius:20px}.mode-tabs{display:flex;gap:4px;width:max-content;padding:4px;border-radius:12px;background:rgba(235,240,249,.9)}.mode-tabs button{padding:9px 22px;border:0;border-radius:9px;background:transparent;color:#667085;font:inherit;font-weight:650;cursor:pointer}.mode-tabs button.active{background:#fff;color:#153b75;box-shadow:0 2px 8px rgba(30,58,138,.1)}
.search-form{margin:24px 0}.search-form label{display:block;margin:0 0 8px;color:#344054;font-size:12px;font-weight:700}.search-line{display:grid;grid-template-columns:1fr 92px;gap:10px}.search-line input{height:46px;padding:0 14px;border:1px solid #d7deea;border-radius:11px;background:rgba(255,255,255,.96);font:inherit}.search-line button,.near-error button{border:0;border-radius:10px;background:#1e3a8a;color:#fff;font:inherit;font-weight:650;cursor:pointer}.search-line button:disabled{opacity:.5;cursor:not-allowed}.result-meta,.loading-title{margin:0 0 10px;color:#667085;font-size:12px}.result-table{border:1px solid #e2e7ef;border-radius:12px;background:#fff;overflow:hidden}.result-row{display:grid;grid-template-columns:minmax(260px,2.2fr) repeat(4,minmax(90px,1fr)) 80px;gap:12px;align-items:center;padding:13px 14px;border-top:1px solid #edf0f5;color:#586474;font-size:12px}.result-row:first-child{border-top:0}.result-title strong,.result-title small{display:block}.result-title strong{color:#1d2939;font-size:13px}.result-title small{margin-top:5px;color:#98a2b3;font-size:10px}.result-row a{color:#1d5fd1}.empty{padding:70px 20px;text-align:center;color:#8791a2;font-size:13px}.near-error{display:flex;justify-content:space-between;align-items:center;padding:16px;border:1px solid #f1c7c7;border-radius:12px;background:#fff7f7;color:#9b2c2c}.near-error div{display:flex;gap:8px}.near-error button{padding:7px 12px}.result-skeleton{display:grid;grid-template-columns:2fr 1fr 1fr;gap:18px;padding:16px;border-bottom:1px solid #edf0f5;background:#fff}.result-skeleton span{height:13px;border-radius:5px;background:linear-gradient(90deg,#edf1f6,#f8fafc,#edf1f6);background-size:200% 100%;animation:pulse 1.2s infinite}@keyframes pulse{to{background-position:-200% 0}}.desktop-notice{display:none}
@media(max-width:1023px){.research-panel{display:none}.desktop-notice{display:block;margin:30px;padding:24px;border:1px solid #d7deea;border-radius:16px;background:#fff;text-align:center;color:#475467}}
</style>
