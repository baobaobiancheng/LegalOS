<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { ArrowLeft, ArrowRight, Close, Collection, CopyDocument, Document, Search, Tickets } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { request, RequestError } from '../../api/client'
import { buildPagination } from '../../domain/legal-research'
import { useAuthStore } from '../../stores/auth'

type Mode = 'laws' | 'cases'
interface LawRecord { source:'lawstar'; recordId:string; lawName:string; issuingOrgan:string|null; issuingNo:string|null; releaseDate:string|null; implementDate:string|null; timeliness:string|null }
interface CaseRecord { source:'ldh'; recordId:string; title:string; court:string|null; caseNumber:string|null; date:string|null; country:string|null; snippet:string|null; url:string|null }
interface LawSearchResult { toolName:'lawstar_data_professional_query'; count:number; page:number; pageSize:number; totalPages:number; records:LawRecord[]; requestedKeyword:string; searchedKeyword:string; filteredCaseLikeCount:number }
interface CaseSearchResult { toolName:'ldh_search'; count:number; records:CaseRecord[] }
interface LawTocItem { id:string; text:string; level:number; children:LawTocItem[] }
interface LawContentBlock { id:string|null; kind:'heading'|'paragraph'|'signature'; text:string }
interface LawDetail { recordId:string; lawName:string; issuingOrgan:string|null; issuingNo:string|null; releaseDate:string|null; implementDate:string|null; timeliness:string|null; hasCompare:boolean; historyCount:number; enclosureCount:number; basisCount:number; toc:LawTocItem[]; contentBlocks:LawContentBlock[] }
type ResearchResult = LawSearchResult | CaseSearchResult
type SearchState = { query:string; submittedQuery:string; page:number; loading:boolean; result:ResearchResult|null; previous:ResearchResult|null; error:RequestError|null }

const router = useRouter()
const auth = useAuthStore()
const mode = ref<Mode>('laws')
const state = reactive<Record<Mode, SearchState>>({
  laws: { query:'', submittedQuery:'', page:1, loading:false, result:null, previous:null, error:null },
  cases: { query:'', submittedQuery:'', page:1, loading:false, result:null, previous:null, error:null },
})
const detailDialog = ref<HTMLDialogElement|null>(null)
const selectedLaw = ref<LawRecord|null>(null)
const detailLoading = ref(false)
const detailError = ref<RequestError|null>(null)
const lawDetail = ref<LawDetail|null>(null)
const visibleBlockCount = ref(400)
const copied = ref(false)

const currentResult = computed(() => state[mode.value].result)
const lawResult = computed(() => currentResult.value?.toolName === 'lawstar_data_professional_query' ? currentResult.value : null)
const caseResult = computed(() => currentResult.value?.toolName === 'ldh_search' ? currentResult.value : null)
const pagination = computed(() => lawResult.value ? buildPagination(lawResult.value.page, lawResult.value.totalPages) : [])
const visibleContentBlocks = computed(() => lawDetail.value?.contentBlocks.slice(0, visibleBlockCount.value) ?? [])
const flatToc = computed(() => flattenToc(lawDetail.value?.toc ?? []))

async function search(page = 1) {
  const current = state[mode.value]
  const query = page === 1 ? current.query.trim() : current.submittedQuery
  if (!query || current.loading) return
  current.previous = current.result
  current.result = null
  current.error = null
  current.page = page
  current.loading = true
  try {
    current.result = mode.value === 'laws'
      ? await request<LawSearchResult>(`/legal-research/laws?keyword=${encodeURIComponent(query)}&page=${page}&rows=10`)
      : await request<CaseSearchResult>(`/legal-research/cases?query=${encodeURIComponent(query)}&topK=5`)
    current.submittedQuery = query
    current.page = mode.value === 'laws' ? (current.result as LawSearchResult).page : 1
  } catch (error) {
    current.error = toRequestError(error, '检索失败，请重试')
  } finally {
    current.loading = false
  }
}

function changeMode(nextMode:Mode) { mode.value = nextMode }
function restorePrevious() { const current = state[mode.value]; current.result = current.previous; current.error = null }

async function openLawDetail(record:LawRecord) {
  selectedLaw.value = record
  lawDetail.value = null
  detailError.value = null
  detailLoading.value = true
  visibleBlockCount.value = 400
  copied.value = false
  detailDialog.value?.showModal()
  try {
    lawDetail.value = await request<LawDetail>(`/legal-research/laws/${encodeURIComponent(record.recordId)}`, { timeoutMs:30_000 })
  } catch (error) {
    detailError.value = toRequestError(error, '法规详情加载失败，请重试')
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() { detailDialog.value?.close() }
function handleDialogClick(event:MouseEvent) { if (event.target === detailDialog.value) closeDetail() }
async function scrollToSection(id:string) {
  const detail = lawDetail.value
  if (!detail) return
  const index = detail.contentBlocks.findIndex((block) => block.id === id)
  if (index >= visibleBlockCount.value) { visibleBlockCount.value = Math.min(detail.contentBlocks.length, index + 120); await nextTick() }
  document.getElementById(`law-content-${id}`)?.scrollIntoView({ behavior:'smooth', block:'start' })
}
async function copyCitation() {
  const detail = lawDetail.value
  if (!detail || !navigator.clipboard) return
  const citation = [detail.lawName, detail.issuingOrgan, detail.issuingNo, detail.releaseDate, detail.timeliness].filter(Boolean).join('，')
  await navigator.clipboard.writeText(citation)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1600)
}
function flattenToc(items:LawTocItem[]) {
  const output:Array<LawTocItem & { depth:number }> = []
  const visit = (nodes:LawTocItem[], depth:number) => { for (const node of nodes) { output.push({ ...node, depth }); visit(node.children ?? [], depth + 1) } }
  visit(items, 0)
  return output
}
function toRequestError(error:unknown, fallback:string) { return error instanceof RequestError ? error : new RequestError({ error:fallback, code:'UNKNOWN', statusCode:0 }) }
async function logout() { await auth.logout(); await router.replace('/login') }
</script>

<template>
  <div class="app-shell research-shell">
    <div
      class="aurora"
      aria-hidden="true"
    >
      <div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" />
    </div>
    <aside class="app-sidebar sidebar-glass">
      <button
        class="app-brand"
        @click="router.push('/legal/projects')"
      >
        <span class="brand-icon brand-letter">法</span><span class="brand-text"><b>法务 Legal OS</b><small>法律团队项目空间</small></span>
      </button>
      <div class="nav-section">
        <span class="nav-label">项目</span>
        <button
          class="nav-btn"
          @click="router.push('/legal/projects')"
        >
          <Tickets class="ui-icon" /><span>工单管理</span>
        </button>
        <button class="nav-btn active">
          <Search class="ui-icon" /><span>法规与类案检索</span>
        </button>
        <button
          class="nav-btn"
          @click="router.push('/legal/skills')"
        >
          <Collection class="ui-icon" /><span>技能库</span>
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
          <ArrowRight class="ui-icon" />
        </button>
      </div>
    </aside>

    <main class="app-main research-main">
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
          <div class="workspace-heading">
            <div><h1>法规与类案检索</h1><p>直接检索百鉴法律数据源，结果不经过大模型改写。</p></div>
            <span class="source-badge">数据源　百鉴</span>
          </div>
          <div
            class="mode-tabs"
            role="tablist"
            aria-label="检索类型"
          >
            <button
              :class="{ active:mode === 'laws' }"
              role="tab"
              :aria-selected="mode === 'laws'"
              @click="changeMode('laws')"
            >
              国内法规
            </button>
            <button
              :class="{ active:mode === 'cases' }"
              role="tab"
              :aria-selected="mode === 'cases'"
              @click="changeMode('cases')"
            >
              类案
            </button>
          </div>
          <form
            class="search-form"
            @submit.prevent="search(1)"
          >
            <label :for="`research-${mode}`">{{ mode === 'laws' ? '法规主题或名称' : '法律问题' }}</label>
            <div class="search-line">
              <input
                :id="`research-${mode}`"
                v-model="state[mode].query"
                :placeholder="mode === 'laws' ? '例如：劳动合同、竞业限制、经济补偿' : '例如：劳动合同违法解除经济补偿的中国类似案例'"
                :disabled="state[mode].loading"
              >
              <button
                type="submit"
                :disabled="!state[mode].query.trim() || state[mode].loading"
              >
                <Search
                  v-if="!state[mode].loading"
                  class="ui-icon"
                />{{ state[mode].loading ? '检索中…' : '检索' }}
              </button>
            </div>
            <p class="search-guidance">
              {{ mode === 'laws' ? '输入“劳动合同纠纷”时，系统会转为“劳动合同”法规主题检索；法规详情仅在点击后加载。' : '类案使用 LDH 中国案例库做关键词与语义混合检索。' }}
            </p>
          </form>

          <div
            v-if="state[mode].loading"
            class="results"
            aria-live="polite"
          >
            <div class="result-meta loading-title">
              <span>正在检索：{{ state[mode].submittedQuery || state[mode].query }}</span><span v-if="mode === 'laws'">第 {{ state[mode].page }} 页</span>
            </div>
            <div
              class="result-table skeleton-table"
              aria-hidden="true"
            >
              <div
                v-for="i in 6"
                :key="i"
                class="result-skeleton"
              >
                <span /><span /><span /><span /><span />
              </div>
            </div>
          </div>
          <div
            v-else-if="state[mode].error"
            class="near-error"
            role="alert"
          >
            <div><strong>{{ state[mode].error?.payload.error }}</strong><span>已保留查询内容，可直接重试。</span></div>
            <div class="error-actions">
              <button @click="search(state[mode].page)">
                重试
              </button><button
                v-if="state[mode].previous"
                class="secondary"
                @click="restorePrevious"
              >
                查看上次结果
              </button>
            </div>
          </div>
          <div
            v-else-if="currentResult"
            class="results"
          >
            <div class="result-meta">
              <div><strong>命中 {{ currentResult.count.toLocaleString('zh-CN') }} 条</strong><span>本页 {{ currentResult.records.length }} 条</span><span v-if="lawResult">第 {{ lawResult.page }} / {{ lawResult.totalPages }} 页</span></div>
              <p v-if="lawResult && (lawResult.requestedKeyword !== lawResult.searchedKeyword || lawResult.filteredCaseLikeCount)">
                <template v-if="lawResult.requestedKeyword !== lawResult.searchedKeyword">
                  已按法规主题“{{ lawResult.searchedKeyword }}”检索
                </template>
                <template v-if="lawResult.filteredCaseLikeCount">
                  {{ lawResult.requestedKeyword !== lawResult.searchedKeyword ? '；' : '' }}本页已隐藏 {{ lawResult.filteredCaseLikeCount }} 条案例型材料
                </template>
              </p>
            </div>
            <template v-if="lawResult">
              <div
                class="result-table law-table"
                role="table"
                aria-label="国内法规检索结果"
              >
                <div
                  class="result-head"
                  role="row"
                >
                  <span>法规名称</span><span>发文机关</span><span>文号</span><span>发布日期</span><span>实施日期</span><span>时效性</span>
                </div>
                <button
                  v-for="record in lawResult.records"
                  :key="record.recordId"
                  class="result-row law-row"
                  role="row"
                  :aria-label="`查看法规详情：${record.lawName}`"
                  @click="openLawDetail(record)"
                >
                  <span
                    class="result-title"
                    role="cell"
                  ><strong>{{ record.lawName }}</strong><small>ID {{ record.recordId }}</small></span>
                  <span role="cell">{{ record.issuingOrgan || '—' }}</span><span role="cell">{{ record.issuingNo || '—' }}</span><span role="cell">{{ record.releaseDate || '—' }}</span><span role="cell">{{ record.implementDate || '—' }}</span>
                  <span
                    role="cell"
                    class="status-cell"
                  ><i :class="{ muted:record.timeliness !== '现行有效' }" />{{ record.timeliness || '—' }}</span>
                </button>
              </div>
              <nav
                v-if="lawResult.totalPages > 1"
                class="pagination"
                aria-label="法规结果分页"
              >
                <button
                  :disabled="lawResult.page <= 1"
                  aria-label="上一页"
                  @click="search(lawResult.page - 1)"
                >
                  <ArrowLeft class="ui-icon" />
                </button>
                <template
                  v-for="item in pagination"
                  :key="item.key"
                >
                  <span
                    v-if="item.type === 'ellipsis'"
                    class="ellipsis"
                  >…</span><button
                    v-else
                    :class="{ active:item.page === lawResult.page }"
                    :aria-current="item.page === lawResult.page ? 'page' : undefined"
                    @click="search(item.page)"
                  >
                    {{ item.page }}
                  </button>
                </template>
                <button
                  :disabled="lawResult.page >= lawResult.totalPages"
                  aria-label="下一页"
                  @click="search(lawResult.page + 1)"
                >
                  <ArrowRight class="ui-icon" />
                </button>
              </nav>
            </template>
            <template v-else-if="caseResult">
              <div
                class="result-table case-table"
                role="list"
              >
                <article
                  v-for="record in caseResult.records"
                  :key="record.recordId"
                  class="case-row"
                  role="listitem"
                >
                  <div>
                    <strong>{{ record.title }}</strong><p v-if="record.snippet">
                      {{ record.snippet }}
                    </p><small>{{ record.court || '未标注法院' }}　·　{{ record.caseNumber || '未标注案号' }}　·　{{ record.date || '未标注日期' }}</small>
                  </div><a
                    v-if="record.url"
                    :href="record.url"
                    target="_blank"
                    rel="noopener noreferrer"
                  >查看原始来源</a>
                </article>
              </div>
            </template>
            <div
              v-if="!currentResult.records.length"
              class="empty"
            >
              未找到匹配结果，请调整关键词后重试。
            </div>
          </div>
          <div
            v-else
            class="empty-state"
          >
            <span class="empty-icon"><Document class="ui-icon" /></span><strong>从一个法规主题开始</strong><p>推荐输入法规名称或核心主题，例如“劳动合同”、“竞业限制”。</p>
          </div>
        </div>
      </section>
    </main>

    <dialog
      ref="detailDialog"
      class="law-dialog"
      aria-labelledby="law-detail-title"
      @click="handleDialogClick"
    >
      <div class="law-reader">
        <header class="reader-header">
          <div>
            <span class="reader-kicker">法规详情　·　法律之星</span><h2 id="law-detail-title">
              {{ lawDetail?.lawName || selectedLaw?.lawName }}
            </h2>
          </div><div class="reader-actions">
            <button
              v-if="lawDetail"
              class="copy-action"
              @click="copyCitation"
            >
              <CopyDocument class="ui-icon" />{{ copied ? '已复制' : '复制引用' }}
            </button><button
              class="close-action"
              aria-label="关闭法规详情"
              @click="closeDetail"
            >
              <Close class="ui-icon" />
            </button>
          </div>
        </header>
        <div
          v-if="detailLoading"
          class="reader-loading"
          aria-live="polite"
        >
          <span class="loading-ring" /><strong>正在加载法规正文</strong><p>详情仅在打开时请求，不会批量消耗正文额度。</p>
        </div>
        <div
          v-else-if="detailError"
          class="reader-error"
          role="alert"
        >
          <strong>{{ detailError.payload.error }}</strong><p>检索结果仍然保留，可关闭详情后继续浏览。</p><button
            v-if="selectedLaw"
            @click="openLawDetail(selectedLaw)"
          >
            重试
          </button>
        </div>
        <template v-else-if="lawDetail">
          <section class="evidence-strip">
            <span><i />正文来自百鉴法律之星</span><span>未经大模型改写</span><span>ID {{ lawDetail.recordId }}</span>
          </section>
          <section
            class="law-metadata"
            aria-label="法规元数据"
          >
            <div><span>发文机关</span><strong>{{ lawDetail.issuingOrgan || '—' }}</strong></div><div><span>文号</span><strong>{{ lawDetail.issuingNo || '—' }}</strong></div><div><span>发布日期</span><strong>{{ lawDetail.releaseDate || '—' }}</strong></div><div><span>实施日期</span><strong>{{ lawDetail.implementDate || '—' }}</strong></div><div><span>时效性</span><strong class="validity">{{ lawDetail.timeliness || '—' }}</strong></div>
          </section>
          <div class="reader-body">
            <aside
              class="law-toc"
              aria-label="法规目录"
            >
              <div class="toc-heading">
                <strong>目录</strong><span>{{ flatToc.length }} 项</span>
              </div><nav v-if="flatToc.length">
                <button
                  v-for="item in flatToc"
                  :key="item.id"
                  :style="{ paddingLeft:`${12 + Math.min(item.depth, 3) * 14}px` }"
                  @click="scrollToSection(item.id)"
                >
                  {{ item.text }}
                </button>
              </nav><p v-else>
                本法规未返回结构化目录。
              </p>
            </aside>
            <article class="law-content">
              <div class="article-summary">
                <span>历史版本 {{ lawDetail.historyCount }}</span><span>相关依据 {{ lawDetail.basisCount }}</span><span>附件 {{ lawDetail.enclosureCount }}</span><span v-if="lawDetail.hasCompare">支持版本比对</span>
              </div><div
                v-if="visibleContentBlocks.length"
                class="article-text"
              >
                <component
                  :is="block.kind === 'heading' ? 'h3' : 'p'"
                  v-for="(block,index) in visibleContentBlocks"
                  :id="block.id ? `law-content-${block.id}` : undefined"
                  :key="`${block.id || block.kind}-${index}`"
                  :class="[`block-${block.kind}`]"
                >
                  {{ block.text }}
                </component>
              </div><div
                v-else
                class="article-empty"
              >
                该记录未返回可展示的正文。
              </div><button
                v-if="visibleBlockCount < lawDetail.contentBlocks.length"
                class="load-more"
                @click="visibleBlockCount += 400"
              >
                继续加载正文　{{ Math.min(400,lawDetail.contentBlocks.length - visibleBlockCount) }} 段
              </button>
            </article>
          </div>
        </template>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.ui-icon { width:1em; height:1em; flex:0 0 auto; }
.research-shell{--research-blue:#173b8f;--research-line:#e4e9f1;--research-text:#172033;--research-muted:#68758a}.research-main{overflow-x:hidden;width:100%;max-width:100%}.tb-left{display:flex;align-items:baseline;gap:10px}.tb-left small{color:var(--text-tertiary);font-size:11px}.tb-left strong{font-size:14px}.brand-letter{display:grid;place-items:center;color:#fff;font-size:16px;font-weight:760}.nav-btn{display:flex;align-items:center;gap:10px}.nav-btn .el-icon{font-size:15px}.logout-link{display:grid;place-items:center}.research-content{width:100%;max-width:1500px;margin:0 auto;padding:28px 34px 48px}.research-panel{min-height:680px;padding:30px 34px 36px;border-radius:22px}.workspace-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:30px;margin-bottom:26px}.workspace-heading h1{margin:0;color:var(--research-text);font-family:Geist,"PingFang SC","Microsoft YaHei",sans-serif;font-size:24px;font-weight:720;letter-spacing:-.02em}.workspace-heading p{margin:8px 0 0;color:var(--research-muted);font-size:13px}.source-badge{flex:0 0 auto;padding:7px 10px;border:1px solid #dce4f0;border-radius:8px;background:rgba(255,255,255,.82);color:#526174;font-size:11px;font-weight:650}.mode-tabs{display:flex;gap:4px;width:max-content;padding:4px;border-radius:12px;background:#edf2fa}.mode-tabs button{min-width:112px;padding:10px 22px;border:0;border-radius:9px;background:transparent;color:#66748a;font:inherit;font-weight:680;cursor:pointer;transition:background .18s ease,color .18s ease,box-shadow .18s ease}.mode-tabs button.active{background:#fff;color:var(--research-blue);box-shadow:0 3px 10px rgba(30,58,138,.1)}.mode-tabs button:focus-visible,.search-line button:focus-visible,.result-row:focus-visible,.pagination button:focus-visible,.law-toc button:focus-visible,.reader-actions button:focus-visible{outline:3px solid rgba(42,105,220,.3);outline-offset:2px}.search-form{margin:26px 0 28px}.search-form label{display:block;margin:0 0 9px;color:#344054;font-size:13px;font-weight:700}.search-line{display:grid;grid-template-columns:1fr 108px;gap:12px}.search-line input{height:48px;padding:0 16px;border:1px solid #ced8e8;border-radius:10px;background:rgba(255,255,255,.98);color:#172033;font:inherit;box-shadow:0 1px 2px rgba(16,24,40,.03);transition:border-color .18s ease,box-shadow .18s ease}.search-line input:focus{border-color:#5a83db;outline:0;box-shadow:0 0 0 3px rgba(42,105,220,.12)}.search-line button,.near-error button,.reader-error button{display:flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:10px;background:var(--research-blue);color:#fff;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 7px 16px rgba(23,59,143,.18)}.search-line button:disabled{opacity:.48;cursor:not-allowed;box-shadow:none}.search-guidance{margin:9px 2px 0;color:#7a879a;font-size:11px;line-height:1.6}.result-meta,.loading-title{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:24px;margin:0 0 10px;color:#748096;font-size:12px}.result-meta>div{display:flex;align-items:center;gap:8px}.result-meta strong{color:#344054;font-size:13px}.result-meta span+span::before{content:"\00b7";margin-right:8px;color:#aab3c1}.result-meta p{margin:0;padding:5px 8px;border-radius:6px;background:#eef4ff;color:#345da8}.result-table{border:1px solid var(--research-line);border-radius:12px;background:#fff;overflow:hidden}.result-head,.law-row{display:grid;grid-template-columns:minmax(260px,2.25fr) minmax(130px,1fr) minmax(130px,1fr) minmax(110px,.8fr) minmax(110px,.8fr) minmax(88px,.65fr);gap:14px;align-items:center}.result-head{min-height:38px;padding:0 16px;background:#f7f9fc;color:#657287;font-size:11px;font-weight:700}.law-row{width:100%;min-height:76px;padding:13px 16px;border:0;border-top:1px solid #edf0f5;background:#fff;color:#5e6b7e;font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background .16s ease,box-shadow .16s ease,transform .16s ease}.law-row:hover{position:relative;z-index:1;background:#f7faff;box-shadow:inset 3px 0 0 #2b65d9;transform:translateX(1px)}.result-title strong,.result-title small{display:block}.result-title strong{color:#172033;font-size:13px;line-height:1.55}.result-title small{margin-top:5px;color:#98a3b4;font-size:9px;letter-spacing:.02em}.status-cell{display:flex;align-items:center;gap:7px;color:#415269}.status-cell i,.evidence-strip i{width:6px;height:6px;border-radius:50%;background:#20a36a;box-shadow:0 0 0 3px rgba(32,163,106,.12)}.status-cell i.muted{background:#98a2b3;box-shadow:0 0 0 3px rgba(152,162,179,.12)}.pagination{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:18px}.pagination button{display:grid;place-items:center;min-width:32px;height:32px;padding:0 9px;border:1px solid #dbe2ed;border-radius:8px;background:#fff;color:#526174;font:inherit;font-size:12px;cursor:pointer;transition:all .16s ease}.pagination button:hover:not(:disabled){border-color:#7d9bdb;color:var(--research-blue)}.pagination button.active{border-color:var(--research-blue);background:var(--research-blue);color:#fff}.pagination button:disabled{opacity:.42;cursor:not-allowed}.ellipsis{min-width:24px;text-align:center;color:#98a2b3}.case-row{display:flex;align-items:flex-start;justify-content:space-between;gap:30px;padding:18px;border-top:1px solid #edf0f5}.case-row:first-child{border-top:0}.case-row strong{color:#172033;font-size:14px}.case-row p{display:-webkit-box;margin:8px 0;overflow:hidden;color:#5e6b7e;font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}.case-row small{color:#8b96a8}.case-row a{flex:0 0 auto;color:#245bc2;font-size:12px;font-weight:650}.near-error{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:17px 18px;border:1px solid #e8c8c8;border-radius:12px;background:#fffafa;color:#8c3434}.near-error>div:first-child{display:grid;gap:4px}.near-error span{color:#936565;font-size:11px}.error-actions{display:flex;gap:8px}.near-error button{padding:8px 14px}.near-error button.secondary{border:1px solid #dfc4c4;background:#fff;color:#793a3a;box-shadow:none}.result-skeleton{display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:18px;padding:21px 16px;border-top:1px solid #edf0f5}.result-skeleton:first-child{border-top:0}.result-skeleton span{height:12px;border-radius:4px;background:linear-gradient(90deg,#edf1f6,#f8fafc,#edf1f6);background-size:200% 100%;animation:pulse 1.2s infinite}@keyframes pulse{to{background-position:-200% 0}}.empty,.empty-state{padding:74px 20px;text-align:center;color:#8791a2;font-size:13px}.empty-state{display:grid;justify-items:center;gap:7px}.empty-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:4px;border:1px solid #dde5f0;border-radius:12px;background:#f5f8fc;color:#3d65b2;font-size:21px}.empty-state strong{color:#344054;font-size:14px}.empty-state p{max-width:520px;margin:0;line-height:1.7}.desktop-notice{display:none}
.law-dialog{width:min(1180px,calc(100vw - 72px));max-width:none;height:min(900px,calc(100vh - 54px));max-height:none;margin:auto;padding:0;overflow:hidden;border:1px solid rgba(211,220,234,.9);border-radius:18px;background:#f8fafc;color:var(--research-text);box-shadow:0 32px 90px rgba(19,35,67,.28)}.law-dialog::backdrop{background:rgba(19,29,49,.42);backdrop-filter:blur(5px)}.law-reader{display:flex;flex-direction:column;height:100%}.reader-header{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;padding:22px 26px 19px;border-bottom:1px solid #e0e6ef;background:rgba(255,255,255,.96)}.reader-kicker{color:#6b7b92;font-size:10px;font-weight:700;letter-spacing:.08em}.reader-header h2{max-width:850px;margin:7px 0 0;color:#172033;font-size:20px;line-height:1.4;letter-spacing:-.01em}.reader-actions{display:flex;align-items:center;gap:8px}.reader-actions button{display:flex;align-items:center;justify-content:center;gap:7px;height:36px;border-radius:9px;font:inherit;cursor:pointer}.copy-action{padding:0 12px;border:1px solid #d7dfeb;background:#fff;color:#41516a;font-size:12px}.close-action{width:36px;border:0;background:#eff3f8;color:#4e5b6d;font-size:16px}.evidence-strip{display:flex;align-items:center;gap:18px;min-height:38px;padding:0 26px;border-bottom:1px solid #e3e9f1;background:#edf4ff;color:#53647a;font-size:11px}.evidence-strip span{display:flex;align-items:center;gap:8px}.evidence-strip span:last-child{margin-left:auto;color:#7f8da1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px}.law-metadata{display:grid;grid-template-columns:1.35fr 1.35fr repeat(3,1fr);border-bottom:1px solid #e1e7ef;background:#fff}.law-metadata div{min-width:0;padding:13px 18px;border-left:1px solid #edf0f5}.law-metadata div:first-child{border-left:0;padding-left:26px}.law-metadata span,.law-metadata strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.law-metadata span{color:#8a96a8;font-size:10px}.law-metadata strong{margin-top:5px;color:#354155;font-size:11px;font-weight:650}.law-metadata .validity{color:#168158}.reader-body{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:0;flex:1}.law-toc{overflow:auto;border-right:1px solid #e1e7ef;background:#f5f7fa}.toc-heading{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:17px 18px 11px;background:rgba(245,247,250,.96)}.toc-heading strong{color:#344054;font-size:12px}.toc-heading span{color:#98a2b3;font-size:10px}.law-toc nav{padding:0 8px 20px}.law-toc button{display:block;width:100%;padding-top:7px;padding-right:10px;padding-bottom:7px;overflow:hidden;border:0;border-radius:6px;background:transparent;color:#5d6a7d;font:inherit;font-size:11px;line-height:1.45;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.law-toc button:hover{background:#e8eef8;color:#1f4f9f}.law-toc>p{padding:0 18px;color:#8b96a8;font-size:11px;line-height:1.6}.law-content{overflow:auto;padding:24px clamp(28px,5vw,70px) 80px;background:#fff;scroll-behavior:smooth}.article-summary{display:flex;gap:8px;margin-bottom:30px;padding-bottom:18px;border-bottom:1px solid #e8ecf2}.article-summary span{padding:5px 8px;border-radius:6px;background:#f2f5f9;color:#69778b;font-size:10px}.article-text{max-width:760px;margin:0 auto;color:#242d3d;font-family:Geist,"Songti SC","Noto Serif CJK SC",serif}.article-text h3{scroll-margin-top:24px;margin:36px 0 18px;color:#172033;font-family:Geist,"PingFang SC","Microsoft YaHei",sans-serif;font-size:17px;line-height:1.5;text-align:center}.article-text p{margin:0 0 15px;font-size:14px;line-height:2;text-align:justify}.article-text .block-signature{text-align:right}.article-empty{padding:80px 20px;text-align:center;color:#8b96a8}.load-more{display:block;min-width:220px;margin:40px auto 0;padding:10px 18px;border:1px solid #d4ddea;border-radius:9px;background:#f8fafc;color:#42536d;font:inherit;font-size:12px;cursor:pointer}.reader-loading,.reader-error{display:grid;place-items:center;align-content:center;flex:1;padding:40px;text-align:center}.reader-loading strong,.reader-error strong{margin-top:14px;color:#344054;font-size:14px}.reader-loading p,.reader-error p{margin:7px 0 0;color:#7a8799;font-size:11px}.loading-ring{width:28px;height:28px;border:3px solid #dce5f2;border-top-color:var(--research-blue);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.reader-error button{margin-top:18px;padding:9px 18px}
@media(max-width:1200px){.research-content{padding-right:22px;padding-left:22px}.research-panel{padding-right:24px;padding-left:24px}.result-head,.law-row{grid-template-columns:minmax(230px,2fr) minmax(115px,1fr) minmax(100px,.9fr) repeat(3,minmax(86px,.75fr));gap:10px}}@media(max-width:1023px){.research-panel{display:none}.desktop-notice{display:block;margin:30px;padding:24px;border:1px solid #d7deea;border-radius:16px;background:#fff;text-align:center;color:#475467}}
</style>
