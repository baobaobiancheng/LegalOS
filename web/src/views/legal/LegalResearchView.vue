<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ArrowLeft, ArrowRight, Close, CopyDocument, Document } from '@element-plus/icons-vue'
import { gsap } from 'gsap'
import { request, RequestError } from '../../api/client'
import LegalWorkspaceLayout from '../../components/LegalWorkspaceLayout.vue'
import { buildPagination } from '../../domain/legal-research'

type Mode = 'laws' | 'cases'
interface CacheInfo { status:'hit'|'miss'|'refresh'|'shared'; fetchedAt:string; lastVerifiedAt:string }
interface LawRecord { source:'lawstar'; recordId:string; lawName:string; issuingOrgan:string|null; issuingNo:string|null; releaseDate:string|null; implementDate:string|null; timeliness:string|null }
interface CaseRecord { source:'ldh'; recordId:string; title:string; court:string|null; caseNumber:string|null; date:string|null; country:string|null; snippet:string|null; url:string|null }
interface LawSearchResult { toolName:'lawstar_data_professional_query'; count:number; page:number; pageSize:number; totalPages:number; records:LawRecord[]; requestedKeyword:string; searchedKeyword:string; filteredCaseLikeCount:number; cache:CacheInfo }
interface CaseSearchResult { toolName:'ldh_search'; count:number; records:CaseRecord[]; cache:CacheInfo }
interface LawTocItem { id:string; text:string; level:number; children:LawTocItem[] }
interface LawContentBlock { id:string|null; kind:'heading'|'paragraph'|'signature'; text:string }
interface LawDetail { recordId:string; lawName:string; issuingOrgan:string|null; issuingNo:string|null; releaseDate:string|null; implementDate:string|null; timeliness:string|null; hasCompare:boolean; historyCount:number; enclosureCount:number; basisCount:number; toc:LawTocItem[]; contentBlocks:LawContentBlock[]; cache:CacheInfo }
type ResearchResult = LawSearchResult | CaseSearchResult
type SearchState = { query:string; submittedQuery:string; page:number; loading:boolean; result:ResearchResult|null; previous:ResearchResult|null; error:RequestError|null }

const RECOMMENDED_QUERIES = ['竞业限制', '经济补偿', '劳务派遣', '工伤认定']
const pageRoot = ref<HTMLElement | null>(null)
const mode = ref<Mode>('laws')
const state = reactive<Record<Mode, SearchState>>({
  laws: { query:'', submittedQuery:'', page:1, loading:false, result:null, previous:null, error:null },
  cases: { query:'', submittedQuery:'', page:1, loading:false, result:null, previous:null, error:null },
})
const lawFilters = reactive({ timeliness: 'all', issuer: 'all', releasePeriod: 'all' })
const detailDialog = ref<HTMLDialogElement|null>(null)
const selectedLaw = ref<LawRecord|null>(null)
const detailLoading = ref(false)
const detailError = ref<RequestError|null>(null)
const lawDetail = ref<LawDetail|null>(null)
const visibleBlockCount = ref(400)
const copied = ref(false)
let animationContext: gsap.Context | null = null

const currentResult = computed(() => state[mode.value].result)
const lawResult = computed(() => currentResult.value?.toolName === 'lawstar_data_professional_query' ? currentResult.value : null)
const caseResult = computed(() => currentResult.value?.toolName === 'ldh_search' ? currentResult.value : null)
const pagination = computed(() => lawResult.value ? buildPagination(lawResult.value.page, lawResult.value.totalPages) : [])
const visibleContentBlocks = computed(() => lawDetail.value?.contentBlocks.slice(0, visibleBlockCount.value) ?? [])
const flatToc = computed(() => flattenToc(lawDetail.value?.toc ?? []))
const issuerOptions = computed(() => [...new Set((lawResult.value?.records ?? []).map(record => record.issuingOrgan).filter((value): value is string => Boolean(value)))])
const hasActiveFilters = computed(() => Object.values(lawFilters).some(value => value !== 'all'))
const filteredLawRecords = computed(() => {
  const now = new Date()
  return (lawResult.value?.records ?? []).filter((record) => {
    if (lawFilters.timeliness !== 'all' && record.timeliness !== lawFilters.timeliness) return false
    if (lawFilters.issuer !== 'all' && record.issuingOrgan !== lawFilters.issuer) return false
    if (lawFilters.releasePeriod !== 'all') {
      if (!record.releaseDate) return false
      const releasedAt = new Date(record.releaseDate)
      const years = Number(lawFilters.releasePeriod)
      const threshold = new Date(now.getFullYear() - years, now.getMonth(), now.getDate())
      if (Number.isNaN(releasedAt.getTime()) || releasedAt < threshold) return false
    }
    return true
  })
})
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

async function animateResults() {
  if (reducedMotion()) return
  await nextTick()
  animationContext?.add(() => {
    gsap.fromTo('.research-result-row', { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.38, stagger: 0.04, ease: 'power2.out', overwrite: true })
  })
}
async function search(page = 1, refresh = false) {
  const searchMode = mode.value
  const current = state[searchMode]
  const query = page === 1 ? current.query.trim() : current.submittedQuery
  if (!query || current.loading) return
  const shouldResetLawFilters = searchMode === 'laws'
    && (page !== current.page || query !== current.submittedQuery)
  if (shouldResetLawFilters) resetLawFilters()
  current.previous = current.result
  current.result = null
  current.error = null
  current.page = page
  current.loading = true
  let succeeded = false
  try {
    current.result = searchMode === 'laws'
      ? await request<LawSearchResult>(`/legal-research/laws?keyword=${encodeURIComponent(query)}&page=${page}&rows=10${refresh ? '&refresh=true' : ''}`)
      : await request<CaseSearchResult>(`/legal-research/cases?query=${encodeURIComponent(query)}&topK=5${refresh ? '&refresh=true' : ''}`)
    current.submittedQuery = query
    current.page = searchMode === 'laws' ? (current.result as LawSearchResult).page : 1
    succeeded = true
  } catch (error) {
    current.error = toRequestError(error, '检索失败，请重试')
  } finally {
    current.loading = false
  }
  if (succeeded && mode.value === searchMode) await animateResults()
}
function changeMode(nextMode:Mode) { mode.value = nextMode }
function restorePrevious() { const current = state[mode.value]; current.result = current.previous; current.error = null }
function useRecommendedQuery(query:string) { state[mode.value].query = query; void search(1) }
function clearSearch() { state[mode.value].query = '' }
function resetLawFilters() {
  lawFilters.timeliness = 'all'
  lawFilters.issuer = 'all'
  lawFilters.releasePeriod = 'all'
}
async function openLawDetail(record:LawRecord, refresh = false) {
  selectedLaw.value = record
  lawDetail.value = null
  detailError.value = null
  detailLoading.value = true
  visibleBlockCount.value = 400
  copied.value = false
  if (!detailDialog.value?.open) detailDialog.value?.showModal()
  try {
    lawDetail.value = await request<LawDetail>(`/legal-research/laws/${encodeURIComponent(record.recordId)}${refresh ? '?refresh=true' : ''}`, { timeoutMs:30_000 })
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
function cacheSource(cache:CacheInfo) {
  if (cache.status === 'hit') return '本地缓存'
  if (cache.status === 'shared') return '百鉴实时返回（已合并重复请求）'
  return '百鉴实时返回'
}
function formatVerifiedAt(value:string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12:false }) }

onMounted(() => {
  if (!pageRoot.value) return
  animationContext = gsap.context(() => {
    if (reducedMotion()) return
    gsap.from('.research-heading > *', { autoAlpha: 0, y: 18, duration: 0.58, stagger: 0.08, ease: 'power2.out' })
    gsap.from('.research-controls', { autoAlpha: 0, y: 16, duration: 0.52, delay: 0.16, ease: 'power2.out' })
  }, pageRoot.value)
})
onBeforeUnmount(() => animationContext?.revert())
</script>

<template>
  <LegalWorkspaceLayout active-key="research">
    <div
      ref="pageRoot"
      class="research-page"
    >
      <header class="research-heading">
        <p class="breadcrumb">
          法务工作台 <span>/</span> 法规与类案检索
        </p>
        <div class="heading-copy">
          <h1>法规与类案检索</h1><span class="heading-divider" /><p>检索权威法规与裁判案例，保留可核验的依据链</p>
        </div>
      </header>
      <section class="research-controls">
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
            法规检索
          </button>
          <button
            :class="{ active:mode === 'cases' }"
            role="tab"
            :aria-selected="mode === 'cases'"
            @click="changeMode('cases')"
          >
            类案检索
          </button>
        </div>
        <form
          class="search-form"
          @submit.prevent="search(1)"
        >
          <div class="search-field">
            <label
              class="sr-only"
              :for="`research-${mode}`"
            >{{ mode === 'laws' ? '法规主题或名称' : '法律问题' }}</label><input
              :id="`research-${mode}`"
              v-model="state[mode].query"
              :placeholder="mode === 'laws' ? '输入法规名称或主题，例如：劳动合同' : '输入争议焦点、案由或法律问题'"
              :disabled="state[mode].loading"
            ><button
              v-if="state[mode].query"
              class="clear-search"
              type="button"
              aria-label="清空检索词"
              @click="clearSearch"
            >
              ×
            </button>
          </div>
          <button
            class="search-button"
            type="submit"
            :disabled="!state[mode].query.trim() || state[mode].loading"
          >
            {{ state[mode].loading ? '检索中…' : '检索' }}
          </button>
        </form>
        <div class="recommended-queries">
          <strong>推荐检索：</strong><button
            v-for="query in RECOMMENDED_QUERIES"
            :key="query"
            type="button"
            @click="useRecommendedQuery(query)"
          >
            {{ query }}
          </button><span v-if="mode === 'cases'">类案使用中国案例库进行关键词与语义混合检索</span>
        </div>
      </section>

      <section
        v-if="state[mode].loading"
        class="results-section"
        aria-live="polite"
      >
        <div class="results-heading">
          <div><h2>检索结果</h2><span>正在检索“{{ state[mode].submittedQuery || state[mode].query }}”</span></div>
        </div>
        <div
          class="result-table loading-table"
          aria-hidden="true"
        >
          <div
            v-for="index in 6"
            :key="index"
            class="result-skeleton"
          >
            <i
              v-for="cell in 6"
              :key="cell"
            />
          </div>
        </div>
      </section>
      <section
        v-else-if="state[mode].error"
        class="near-error"
        role="alert"
      >
        <div><strong>{{ state[mode].error?.payload.error }}</strong><span>查询内容已保留，可以直接重试。</span><small>错误代码 {{ state[mode].error?.payload.code }}<template v-if="state[mode].error?.payload.requestId">　请求 ID {{ state[mode].error?.payload.requestId }}</template></small></div>
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
      </section>
      <section
        v-else-if="currentResult"
        class="results-section"
      >
        <div class="results-heading">
          <div><h2>检索结果</h2><span>命中 {{ currentResult.count.toLocaleString('zh-CN') }} 条</span><span v-if="lawResult">· 第 {{ lawResult.page }} / {{ lawResult.totalPages }} 页</span><span v-if="hasActiveFilters">· 本页筛选后 {{ filteredLawRecords.length }} 条</span></div><small>{{ cacheSource(currentResult.cache) }} · 校验于 {{ formatVerifiedAt(currentResult.cache.lastVerifiedAt) }}</small>
        </div>
        <div
          v-if="lawResult"
          class="result-toolbar"
        >
          <label>时效性：<select v-model="lawFilters.timeliness"><option value="all">全部</option><option value="现行有效">现行有效</option><option value="已失效">已失效</option><option value="尚未生效">尚未生效</option></select></label>
          <label>发文机关：<select v-model="lawFilters.issuer"><option value="all">全部</option><option
            v-for="issuer in issuerOptions"
            :key="issuer"
            :value="issuer"
          >{{ issuer }}</option></select></label>
          <label>发布日期：<select v-model="lawFilters.releasePeriod"><option value="all">不限</option><option value="1">近一年</option><option value="3">近三年</option><option value="5">近五年</option></select></label>
          <button
            class="refresh-source"
            type="button"
            @click="search(state.laws.page, true)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="M20 7h-5V2" /><path d="M20 2 9.5 12.5a5 5 0 1 0 7 7L20 16" /></svg>刷新权威数据
          </button>
        </div>
        <template v-if="lawResult">
          <div
            class="result-table law-table"
            role="table"
            aria-label="国内法规检索结果"
          >
            <div
              class="result-head law-grid"
              role="row"
            >
              <span role="columnheader">法规名称</span><span role="columnheader">发文机关</span><span role="columnheader">文号</span><span role="columnheader">发布日期</span><span role="columnheader">实施日期</span><span role="columnheader">时效性</span>
            </div>
            <button
              v-for="record in filteredLawRecords"
              :key="record.recordId"
              class="result-row law-grid research-result-row"
              :aria-label="`查看法规详情：${record.lawName}`"
              @click="openLawDetail(record)"
            >
              <span class="result-title"><i class="document-icon"><Document /></i><span><strong>{{ record.lawName }}</strong><small>来源：{{ record.issuingOrgan || '法律之星' }}</small></span></span><span>{{ record.issuingOrgan || '—' }}</span><span>{{ record.issuingNo || '—' }}</span><span>{{ record.releaseDate || '—' }}</span><span>{{ record.implementDate || '—' }}</span><span class="status-cell"><i :class="{ muted:record.timeliness !== '现行有效' }" />{{ record.timeliness || '—' }}</span>
            </button>
            <div
              v-if="!filteredLawRecords.length"
              class="empty-inline"
            >
              本页没有符合筛选条件的法规，请调整筛选项。
            </div>
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
              <ArrowLeft />
            </button><template
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
            </template><button
              :disabled="lawResult.page >= lawResult.totalPages"
              aria-label="下一页"
              @click="search(lawResult.page + 1)"
            >
              <ArrowRight />
            </button>
          </nav>
        </template>
        <template v-else-if="caseResult">
          <div
            class="case-list"
            role="list"
          >
            <article
              v-for="record in caseResult.records"
              :key="record.recordId"
              class="case-row research-result-row"
              role="listitem"
            >
              <span class="case-mark">案</span><div>
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
          </div><button
            class="refresh-source case-refresh"
            type="button"
            @click="search(1, true)"
          >
            刷新权威数据
          </button>
        </template>
        <div
          v-if="!currentResult.records.length"
          class="empty-inline"
        >
          未找到匹配结果，请调整关键词后重试。
        </div>
      </section>
      <section
        v-else
        class="initial-state"
      >
        <span><Document /></span><strong>从一个法规主题开始</strong><p>输入法规名称、核心主题或争议焦点，检索百鉴法律数据源。</p>
      </section>
    </div>

    <dialog
      ref="detailDialog"
      class="law-dialog"
      aria-labelledby="law-detail-title"
      @click="handleDialogClick"
    >
      <div class="law-reader">
        <header class="reader-header">
          <div>
            <span class="reader-kicker">法规详情 · 法律之星</span><h2 id="law-detail-title">
              {{ lawDetail?.lawName || selectedLaw?.lawName }}
            </h2>
          </div><div class="reader-actions">
            <button
              v-if="lawDetail"
              class="copy-action"
              @click="copyCitation"
            >
              <CopyDocument />{{ copied ? '已复制' : '复制引用' }}
            </button><button
              v-if="lawDetail && selectedLaw"
              class="copy-action"
              @click="openLawDetail(selectedLaw, true)"
            >
              刷新正文
            </button><button
              class="close-action"
              aria-label="关闭法规详情"
              @click="closeDetail"
            >
              <Close />
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
          <strong>{{ detailError.payload.error }}</strong><p>检索结果仍然保留，可关闭详情后继续浏览。</p><p class="error-diagnostic">
            错误代码 {{ detailError.payload.code }}<template v-if="detailError.payload.requestId">
              　请求 ID {{ detailError.payload.requestId }}
            </template>
          </p><button
            v-if="selectedLaw"
            @click="openLawDetail(selectedLaw)"
          >
            重试
          </button>
        </div>
        <template v-else-if="lawDetail">
          <section class="evidence-strip">
            <span><i />正文来自百鉴法律之星</span><span>{{ cacheSource(lawDetail.cache) }}，校验于 {{ formatVerifiedAt(lawDetail.cache.lastVerifiedAt) }}</span><span>未经大模型改写 · ID {{ lawDetail.recordId }}</span>
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
            </aside><article class="law-content">
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
  </LegalWorkspaceLayout>
</template>

<script lang="ts">export default { name: 'LegalResearchView' }</script>

<style scoped>
.research-page { width: min(100%, 1540px); min-height: 100vh; margin: 0 auto; padding: 34px 38px 56px; color: #111827; }
.research-heading { margin-bottom: 32px; }
.breadcrumb { margin: 0 0 34px; color: #53627A; font-size: 13px; }
.breadcrumb span { margin: 0 10px; color: #A8B1BF; }
.heading-copy { display: flex; min-width: 0; align-items: center; gap: 18px; }
.heading-copy h1 { margin: 0; color: #0B1222; font-size: clamp(34px, 3.2vw, 46px); font-weight: 680; letter-spacing: -0.045em; line-height: 1; white-space: nowrap; }
.heading-divider { width: 1px; height: 36px; flex: 0 0 auto; background: #CBD5E1; }
.heading-copy p { margin: 0; color: #526174; font-size: 15px; white-space: nowrap; }
.mode-tabs { display: grid; width: min(100%, 488px); overflow: hidden; grid-template-columns: repeat(2, 1fr); margin-bottom: 24px; border: 1px solid #D4DCE8; border-radius: 7px; background: #FFFFFF; }
.mode-tabs button { position: relative; min-height: 50px; border: 0; border-left: 1px solid #E5EAF1; background: #FFFFFF; color: #41506A; font: inherit; font-size: 15px; font-weight: 600; }
.mode-tabs button:first-child { border-left: 0; }
.mode-tabs button::after { position: absolute; inset: auto 0 0; height: 3px; background: transparent; content: ""; }
.mode-tabs button.active { background: #F8FAFF; color: #2563EB; }
.mode-tabs button.active::after { background: #2563EB; }
.search-form { display: grid; grid-template-columns: minmax(0, 1fr) 136px; gap: 22px; }
.search-field { position: relative; }
.search-field input { width: 100%; height: 54px; padding: 0 48px 0 18px; border: 1px solid #C9D4E3; border-radius: 7px; outline: 0; background: #FFFFFF; color: #172033; font: inherit; font-size: 16px; transition: border-color 180ms ease, box-shadow 180ms ease; }
.search-field input:focus { border-color: #2563EB; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.10); }
.clear-search { position: absolute; inset: 50% 15px auto auto; display: grid; width: 22px; height: 22px; padding: 0; transform: translateY(-50%); border: 1px solid #8EA0B9; border-radius: 50%; place-items: center; background: #FFFFFF; color: #64748B; font-size: 16px; line-height: 1; }
.search-button { height: 54px; border: 0; border-radius: 6px; background: #0B5CFF; color: #FFFFFF; font: inherit; font-size: 17px; font-weight: 650; box-shadow: 0 7px 18px rgba(11, 92, 255, 0.16); }
.search-button:hover:not(:disabled) { background: #004FE5; }
.search-button:disabled { opacity: 0.48; cursor: not-allowed; box-shadow: none; }
.recommended-queries { display: flex; min-height: 48px; align-items: center; color: #64748B; font-size: 12px; }
.recommended-queries strong { margin-right: 8px; color: #475569; }
.recommended-queries button { padding: 0 18px; border: 0; border-left: 1px solid #CBD5E1; background: transparent; color: #526789; font: inherit; font-size: 12px; }
.recommended-queries button:first-of-type { padding-left: 0; border-left: 0; }
.recommended-queries button:hover { color: #2563EB; }
.recommended-queries > span { margin-left: auto; color: #8A96A8; }
.results-section { margin-top: 7px; }
.results-heading { display: flex; min-height: 42px; align-items: flex-start; justify-content: space-between; gap: 20px; }
.results-heading > div { display: flex; align-items: baseline; gap: 10px; }
.results-heading h2 { margin: 0; color: #111827; font-size: 21px; font-weight: 680; letter-spacing: -0.02em; }
.results-heading span { color: #53627A; font-size: 13px; }
.results-heading small { padding-top: 6px; color: #8A96A8; font-size: 10px; }
.result-toolbar { display: grid; grid-template-columns: minmax(180px, 274px) minmax(210px, 294px) minmax(190px, 294px) 1fr; gap: 22px; margin-bottom: 16px; align-items: center; }
.result-toolbar label { display: flex; height: 48px; padding: 0 14px; align-items: center; border: 1px solid #D2DBE7; border-radius: 7px; background: #FFFFFF; color: #53627A; font-size: 13px; white-space: nowrap; }
.result-toolbar select { min-width: 0; flex: 1; border: 0; outline: 0; background: #FFFFFF; color: #334155; font: inherit; font-size: 13px; }
.refresh-source { display: inline-flex; height: 46px; padding: 0 16px; align-items: center; justify-content: center; gap: 8px; justify-self: end; border: 1px solid #C7D2E2; border-radius: 7px; background: #FFFFFF; color: #3F506A; font: inherit; font-size: 13px; font-weight: 600; }
.refresh-source:hover { border-color: #8DA8D7; color: #2563EB; }
.refresh-source svg { width: 16px; height: 16px; }
.result-table, .case-list { overflow-x: auto; border: 1px solid #DCE3EC; border-radius: 7px; background: #FFFFFF; }
.law-grid, .result-skeleton { display: grid; min-width: 1010px; grid-template-columns: minmax(330px, 2fr) minmax(160px, 1fr) minmax(160px, 1fr) 128px 128px 100px; align-items: center; column-gap: 16px; }
.result-head { min-height: 46px; padding: 0 20px; border-bottom: 1px solid #E5EAF1; color: #5D6A7D; font-size: 12px; font-weight: 650; }
.result-row { width: 100%; min-height: 72px; padding: 0 20px; border: 0; border-bottom: 1px solid #E7ECF2; background: #FFFFFF; color: #334155; font: inherit; font-size: 12px; text-align: left; transition: background 160ms ease, box-shadow 160ms ease; }
.result-row:last-child { border-bottom: 0; }
.result-row:hover, .result-row:focus-visible { position: relative; z-index: 1; outline: 0; background: #F7FAFF; box-shadow: inset 3px 0 0 #2563EB, 0 0 0 1px #2563EB; }
.result-title { display: flex; min-width: 0; align-items: center; gap: 14px; }
.result-title > span { min-width: 0; }
.result-title strong, .result-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-title strong { color: #1F2937; font-size: 14px; font-weight: 650; }
.result-title small { margin-top: 5px; color: #8793A5; font-size: 10px; font-weight: 450; }
.document-icon { display: grid; width: 27px; height: 30px; flex: 0 0 auto; border-radius: 5px; place-items: center; background: #EEF5FF; color: #3B82F6; font-style: normal; }
.document-icon svg { width: 16px; height: 16px; }
.status-cell { display: flex; align-items: center; gap: 8px; color: #15945A; font-weight: 600; }
.status-cell i, .evidence-strip i { width: 6px; height: 6px; border-radius: 50%; background: #18A463; }
.status-cell i.muted { background: #94A3B8; }
.pagination { display: flex; justify-content: flex-end; align-items: center; gap: 18px; margin-top: 16px; }
.pagination button { display: grid; min-width: 42px; height: 40px; padding: 0 12px; border: 1px solid #D5DEEA; border-radius: 6px; place-items: center; background: #FFFFFF; color: #475569; font: inherit; font-size: 13px; }
.pagination button:hover:not(:disabled) { border-color: #8DA8D7; color: #2563EB; }
.pagination button.active { border-color: #2563EB; color: #2563EB; box-shadow: inset 0 0 0 1px #2563EB; }
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination svg { width: 16px; height: 16px; }
.ellipsis { min-width: 24px; color: #64748B; text-align: center; }
.case-list { overflow: hidden; }
.case-row { display: grid; min-height: 108px; padding: 20px; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: start; gap: 16px; border-bottom: 1px solid #E7ECF2; }
.case-row:last-child { border-bottom: 0; }
.case-mark { display: grid; width: 34px; height: 34px; border-radius: 6px; place-items: center; background: #EEF5FF; color: #2563EB; font-size: 12px; font-weight: 700; }
.case-row strong { color: #1F2937; font-size: 14px; }
.case-row p { display: -webkit-box; margin: 7px 0; overflow: hidden; color: #59677B; font-size: 12px; line-height: 1.7; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.case-row small { color: #8793A5; }
.case-row a { color: #2563EB; font-size: 12px; font-weight: 600; }
.case-refresh { margin-top: 16px; }
.initial-state, .empty-inline { display: grid; min-height: 340px; place-items: center; align-content: center; gap: 8px; border: 1px solid #DCE3EC; border-radius: 7px; background: #FFFFFF; color: #7B8798; text-align: center; }
.initial-state > span { display: grid; width: 48px; height: 48px; margin-bottom: 4px; border: 1px solid #D7E1F0; border-radius: 9px; place-items: center; background: #F5F8FC; color: #2563EB; }
.initial-state svg { width: 24px; height: 24px; }
.initial-state strong { color: #334155; font-size: 15px; }
.initial-state p { margin: 0; font-size: 12px; }
.empty-inline { min-height: 160px; border: 0; border-radius: 0; }
.near-error { display: flex; min-height: 128px; padding: 24px; align-items: center; justify-content: space-between; gap: 24px; border: 1px solid #F0CACA; border-radius: 7px; background: #FFFAFA; color: #8B3434; }
.near-error > div:first-child { display: grid; gap: 5px; }
.near-error span, .near-error small { color: #936565; font-size: 11px; }
.near-error small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.error-actions { display: flex; gap: 8px; }
.error-actions button, .reader-error button { padding: 9px 16px; border: 0; border-radius: 6px; background: #8B3434; color: #FFFFFF; font: inherit; font-size: 12px; font-weight: 600; }
.error-actions button.secondary { border: 1px solid #E2CACA; background: #FFFFFF; color: #8B3434; }
.loading-table { min-height: 430px; }
.result-skeleton { min-height: 70px; padding: 0 20px; border-bottom: 1px solid #E7ECF2; }
.result-skeleton i { height: 11px; border-radius: 4px; background: linear-gradient(90deg, #EDF1F5 25%, #F8FAFC 50%, #EDF1F5 75%); background-size: 200% 100%; animation: loading-shimmer 1.25s linear infinite; }
@keyframes loading-shimmer { to { background-position: -200% 0; } }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
.law-dialog { width: min(1180px, calc(100vw - 72px)); max-width: none; height: min(900px, calc(100vh - 54px)); max-height: none; margin: auto; padding: 0; overflow: hidden; border: 1px solid #D3DCEA; border-radius: 12px; background: #F8FAFC; color: #172033; box-shadow: 0 28px 80px rgba(19, 35, 67, 0.24); }
.law-dialog::backdrop { background: rgba(19, 29, 49, 0.42); backdrop-filter: blur(5px); }
.law-reader { display: flex; height: 100%; flex-direction: column; }
.reader-header { display: flex; padding: 22px 26px 19px; align-items: flex-start; justify-content: space-between; gap: 28px; border-bottom: 1px solid #E0E6EF; background: #FFFFFF; }
.reader-kicker { color: #6B7B92; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
.reader-header h2 { max-width: 850px; margin: 7px 0 0; color: #172033; font-size: 20px; line-height: 1.4; }
.reader-actions { display: flex; align-items: center; gap: 8px; }
.reader-actions button { display: flex; height: 36px; align-items: center; justify-content: center; gap: 7px; border-radius: 7px; font: inherit; }
.reader-actions svg { width: 15px; height: 15px; }
.copy-action { padding: 0 12px; border: 1px solid #D7DFEB; background: #FFFFFF; color: #41516A; font-size: 12px; }
.close-action { width: 36px; border: 0; background: #EFF3F8; color: #4E5B6D; }
.evidence-strip { display: flex; min-height: 38px; padding: 0 26px; align-items: center; gap: 18px; border-bottom: 1px solid #E3E9F1; background: #EDF4FF; color: #53647A; font-size: 11px; }
.evidence-strip span { display: flex; align-items: center; gap: 8px; }
.evidence-strip span:last-child { margin-left: auto; color: #7F8DA1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
.law-metadata { display: grid; grid-template-columns: 1.35fr 1.35fr repeat(3, 1fr); border-bottom: 1px solid #E1E7EF; background: #FFFFFF; }
.law-metadata div { min-width: 0; padding: 13px 18px; border-left: 1px solid #EDF0F5; }
.law-metadata div:first-child { padding-left: 26px; border-left: 0; }
.law-metadata span, .law-metadata strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.law-metadata span { color: #8A96A8; font-size: 10px; }
.law-metadata strong { margin-top: 5px; color: #354155; font-size: 11px; }
.law-metadata .validity { color: #168158; }
.reader-body { display: grid; min-height: 0; flex: 1; grid-template-columns: 260px minmax(0, 1fr); }
.law-toc { overflow: auto; border-right: 1px solid #E1E7EF; background: #F5F7FA; }
.toc-heading { position: sticky; top: 0; z-index: 1; display: flex; padding: 17px 18px 11px; justify-content: space-between; background: #F5F7FA; }
.toc-heading strong { color: #344054; font-size: 12px; }
.toc-heading span { color: #98A2B3; font-size: 10px; }
.law-toc nav { padding: 0 8px 20px; }
.law-toc button { display: block; width: 100%; padding-top: 7px; padding-right: 10px; padding-bottom: 7px; overflow: hidden; border: 0; border-radius: 5px; background: transparent; color: #5D6A7D; font: inherit; font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.law-toc button:hover { background: #E8EEF8; color: #1F4F9F; }
.law-toc > p { padding: 0 18px; color: #8B96A8; font-size: 11px; }
.law-content { overflow: auto; padding: 24px clamp(28px, 5vw, 70px) 80px; background: #FFFFFF; scroll-behavior: smooth; }
.article-summary { display: flex; margin-bottom: 30px; padding-bottom: 18px; gap: 8px; border-bottom: 1px solid #E8ECF2; }
.article-summary span { padding: 5px 8px; border-radius: 5px; background: #F2F5F9; color: #69778B; font-size: 10px; }
.article-text { max-width: 760px; margin: 0 auto; color: #242D3D; font-family: "Songti SC", "Noto Serif CJK SC", serif; }
.article-text h3 { scroll-margin-top: 24px; margin: 36px 0 18px; color: #172033; font-family: Outfit, "PingFang SC", sans-serif; font-size: 17px; line-height: 1.5; text-align: center; }
.article-text p { margin: 0 0 15px; font-size: 14px; line-height: 2; text-align: justify; }
.article-text .block-signature { text-align: right; }
.article-empty { padding: 80px 20px; color: #8B96A8; text-align: center; }
.load-more { display: block; min-width: 220px; margin: 40px auto 0; padding: 10px 18px; border: 1px solid #D4DDEA; border-radius: 7px; background: #F8FAFC; color: #42536D; font: inherit; font-size: 12px; }
.reader-loading, .reader-error { display: grid; padding: 40px; place-items: center; align-content: center; flex: 1; text-align: center; }
.reader-loading strong, .reader-error strong { margin-top: 14px; color: #344054; font-size: 14px; }
.reader-loading p, .reader-error p { margin: 7px 0 0; color: #7A8799; font-size: 11px; }
.loading-ring { width: 28px; height: 28px; border: 3px solid #DCE5F2; border-top-color: #2563EB; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.reader-error button { margin-top: 18px; }
@media (max-width: 1180px) { .research-page { padding-right: 26px; padding-left: 26px; } .heading-copy p, .heading-divider { display: none; } .result-toolbar { grid-template-columns: repeat(3, 1fr); } .refresh-source { grid-column: 1 / -1; } }
@media (max-width: 760px) { .research-page { padding: 24px 18px 42px; } .breadcrumb { margin-bottom: 24px; } .heading-copy h1 { font-size: 32px; } .search-form { grid-template-columns: 1fr 96px; gap: 10px; } .recommended-queries { overflow-x: auto; white-space: nowrap; } .recommended-queries > span { display: none; } .result-toolbar { grid-template-columns: 1fr; gap: 10px; } .refresh-source { grid-column: auto; justify-self: stretch; } .results-heading { flex-direction: column; } .reader-body { grid-template-columns: 1fr; } .law-toc { display: none; } .law-metadata { grid-template-columns: repeat(2, 1fr); } .evidence-strip span:nth-child(n+2) { display: none; } .law-dialog { width: calc(100vw - 24px); height: calc(100vh - 24px); } }
</style>
