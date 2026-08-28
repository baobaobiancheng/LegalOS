<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { request, RequestError } from '../api/client'
import type { AiLawResearchReportV1, ResearchTraceV1 } from '../types'
import AiLawReport from './AiLawReport.vue'
import DownloadMenu from './DownloadMenu.vue'

type AiSearchResponse = {
  reportId: string
  report: AiLawResearchReportV1
  trace: ResearchTraceV1
  degraded?: boolean
  warning?: { code: string; message: string }
}

const query = ref('')
const submittedQuery = ref('')
const followup = ref('')
const loading = ref(false)
const report = ref<AiLawResearchReportV1 | null>(null)
const reportId = ref('')
const degradedWarning = ref<AiSearchResponse['warning']>(undefined)
const error = ref<RequestError | null>(null)
const copied = ref(false)
const followupInput = ref<HTMLInputElement | null>(null)
let activeAbort: AbortController | null = null

const recommended = ['离婚财产如何分割？', '员工解除劳动合同需要哪些补偿？', '供应商违约可以主张哪些责任？']
const generatedLabel = computed(() => report.value
  ? new Date(report.value.generatedAt).toLocaleString('zh-CN', { hour12: false })
  : '')
const downloadContent = computed(() => report.value ? reportToMarkdown(report.value) : '')

async function runSearch(nextQuery?: string) {
  const value = (nextQuery ?? query.value).trim()
  if (!value || loading.value) return
  activeAbort?.abort()
  const abort = new AbortController()
  activeAbort = abort
  loading.value = true
  error.value = null
  submittedQuery.value = value
  query.value = value
  try {
    const result = await request<AiSearchResponse>('/legal-research/ai', {
      method: 'POST',
      timeoutMs: 210_000,
      timeoutCode: 'AI_RESEARCH_TIMEOUT',
      signal: abort.signal,
      body: { query: value },
    })
    report.value = result.report
    reportId.value = result.reportId
    degradedWarning.value = result.degraded ? result.warning : undefined
  } catch (cause) {
    if (abort.signal.aborted) return
    error.value = cause instanceof RequestError
      ? cause
      : new RequestError({ error: 'AI 搜法失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    if (activeAbort === abort) activeAbort = null
    loading.value = false
  }
}

function submitFollowup() {
  const value = followup.value.trim()
  if (!value || !report.value) return
  followup.value = ''
  void runSearch(`原问题：${report.value.query || submittedQuery.value}\n追问：${value}`)
}

async function copyReport() {
  if (!downloadContent.value || !navigator.clipboard) return
  await navigator.clipboard.writeText(downloadContent.value)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1600)
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function focusFollowup() {
  followupInput.value?.focus()
}

function reportToMarkdown(value: AiLawResearchReportV1) {
  const sections = value.sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n')
  const sources = value.sources.map(source => {
    const articles = source.articles.map(article => `- ${article.article}：${article.text}`).join('\n')
    return `### ${source.lawName}\n\n${source.issuingOrgan || ''}${source.timeliness ? ` · ${source.timeliness}` : ''}${articles ? `\n\n${articles}` : ''}`
  }).join('\n\n')
  const limitations = value.limitations.map(item => `- ${item}`).join('\n')
  return `# ${value.title}\n\n检索问题：${value.query}\n\n## 总结\n\n${value.summary}\n\n${sections}\n\n## 权威来源\n\n${sources}${limitations ? `\n\n## 适用边界\n\n${limitations}` : ''}`
}

onBeforeUnmount(() => activeAbort?.abort())
</script>

<template>
  <section class="ai-research-panel">
    <template v-if="!report && !loading">
      <div class="ai-search-intro">
        <h2>用自然语言检索并核验法律依据</h2>
        <p>AI 将先召回候选法规，再读取权威正文，最后生成结构化搜法报告。</p>
      </div>
      <form
        class="ai-search-form"
        @submit.prevent="runSearch()"
      >
        <input
          v-model="query"
          placeholder="描述法律问题，例如：我想离婚，进行财产分割"
          :disabled="loading"
        >
        <button
          type="submit"
          :disabled="!query.trim() || loading"
        >
          开始 AI 搜法
        </button>
      </form>
      <div class="ai-recommended">
        <strong>推荐提问：</strong>
        <button
          v-for="item in recommended"
          :key="item"
          type="button"
          @click="runSearch(item)"
        >
          {{ item }}
        </button>
      </div>
      <div
        v-if="error"
        class="ai-error"
        role="alert"
      >
        <div><strong>{{ error.payload.error }}</strong><small>错误代码 {{ error.payload.code }}</small></div>
        <button
          type="button"
          @click="runSearch(submittedQuery)"
        >
          重试
        </button>
      </div>
    </template>

    <div
      v-else-if="loading"
      class="ai-loading"
      aria-live="polite"
    >
      <span class="loading-mark" />
      <div><strong>正在执行 AI 搜法</strong><p>正在召回候选法规并核验权威正文，复杂问题可能需要一至三分钟。</p></div>
      <div class="loading-steps">
        <span class="active">理解问题</span><span>法规召回</span><span>正文核验</span><span>生成报告</span>
      </div>
    </div>

    <template v-else-if="report">
      <div
        v-if="error"
        class="ai-error retained-report-error"
        role="alert"
      >
        <div><strong>{{ error.payload.error }}</strong><span>当前仍显示上一次成功生成的报告。</span><small>错误代码 {{ error.payload.code }}</small></div>
        <button
          type="button"
          @click="runSearch(submittedQuery)"
        >
          重试
        </button>
      </div>
      <div
        v-if="degradedWarning"
        class="ai-degraded"
        role="status"
      >
        <strong>当前为安全降级结果</strong>
        <span>{{ degradedWarning.message }}</span>
        <small>原因代码 {{ degradedWarning.code }}</small>
      </div>
      <header class="ai-report-heading">
        <div>
          <h2>{{ report.title }}</h2>
          <p>{{ degradedWarning ? '证据核验未完全通过' : '检索完成' }} · 已核验 {{ report.metrics.verifiedSourceCount }} 部权威法规 · 生成于 {{ generatedLabel }}</p>
        </div>
        <div class="report-heading-actions">
          <button
            type="button"
            @click="runSearch(submittedQuery)"
          >
            重新检索
          </button>
          <DownloadMenu
            :content="downloadContent"
            :filename="report.title"
            audit-endpoint="/legal-research/ai/downloads"
            :audit-payload="{ reportId }"
          />
          <button
            class="primary"
            type="button"
            @click="focusFollowup"
          >
            继续追问
          </button>
        </div>
      </header>

      <form
        class="report-query-form"
        @submit.prevent="runSearch()"
      >
        <input v-model="query"><button type="submit">
          搜索
        </button>
      </form>

      <div class="report-workspace">
        <nav
          class="report-toc"
          aria-label="报告目录"
        >
          <strong>报告目录</strong>
          <button
            type="button"
            @click="scrollTo('ai-report-process')"
          >
            检索过程
          </button>
          <button
            type="button"
            @click="scrollTo('ai-report-summary')"
          >
            总结
          </button>
          <button
            type="button"
            @click="scrollTo('ai-report-analysis')"
          >
            具体分析
          </button>
          <button
            type="button"
            @click="scrollTo('ai-report-sources')"
          >
            精选法规 <span>{{ report.sources.length }}</span>
          </button>
        </nav>
        <div
          id="ai-report-process"
          class="report-document"
        >
          <AiLawReport :report="report" />
          <div class="report-document-actions">
            <button
              type="button"
              @click="copyReport"
            >
              {{ copied ? '已复制' : '复制报告' }}
            </button>
          </div>
        </div>
      </div>

      <form
        class="report-followup"
        @submit.prevent="submitFollowup"
      >
        <input
          id="ai-report-followup"
          ref="followupInput"
          v-model="followup"
          placeholder="基于本报告继续追问..."
        >
        <button
          :disabled="!followup.trim()"
          type="submit"
        >
          发送
        </button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.ai-research-panel { min-height: 420px; }
.ai-search-intro { margin-top: 34px; }
.ai-search-intro h2 { margin: 0; color: #0b1222; font-size: 30px; letter-spacing: -.035em; }
.ai-search-intro p { margin: 8px 0 0; color: #657188; font-size: 14px; }
.ai-search-form,
.report-query-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; margin-top: 24px; gap: 14px; }
.ai-search-form input,
.report-query-form input { height: 54px; padding: 0 16px; border: 1px solid #9dbdff; border-radius: 7px; outline: 0; background: #fff; color: #172033; font: inherit; font-size: 15px; }
.ai-search-form input:focus,
.report-query-form input:focus { border-color: #1768f2; box-shadow: 0 0 0 3px rgba(23, 104, 242, .08); }
.ai-search-form button,
.report-query-form button { min-width: 132px; border: 0; border-radius: 7px; background: #0f5fff; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
.ai-search-form button:disabled { opacity: .5; cursor: not-allowed; }
.ai-recommended { display: flex; margin-top: 12px; align-items: center; flex-wrap: wrap; gap: 0; color: #66748a; font-size: 12px; }
.ai-recommended button { padding: 2px 15px; border: 0; border-right: 1px solid #d7deea; background: transparent; color: #526b91; font: inherit; cursor: pointer; }
.ai-recommended button:last-child { border-right: 0; }
.ai-error { display: flex; margin-top: 24px; padding: 14px 16px; align-items: center; justify-content: space-between; border: 1px solid #fecaca; border-radius: 7px; background: #fff7f7; }
.ai-error div { display: flex; flex-direction: column; gap: 3px; color: #a3182d; }
.ai-error span { color: #7e4f59; font-size: 12px; }
.ai-error small { color: #9f6670; }
.ai-error button { padding: 7px 14px; border: 1px solid #d73b52; border-radius: 5px; background: #fff; color: #b4233b; font: inherit; cursor: pointer; }
.retained-report-error { margin-top: 16px; }
.ai-degraded { display: grid; margin-top: 16px; padding: 13px 15px; gap: 4px; border: 1px solid #f2c98a; border-radius: 7px; background: #fff9ef; color: #81500c; }
.ai-degraded strong { font-size: 13px; }
.ai-degraded span { font-size: 12px; line-height: 1.6; }
.ai-degraded small { color: #9a6c2e; font-size: 11px; }
.ai-loading { display: grid; min-height: 360px; place-content: center; justify-items: center; color: #243650; text-align: center; }
.loading-mark { width: 38px; height: 38px; margin-bottom: 18px; border: 3px solid #dbe6fa; border-top-color: #1768f2; border-radius: 50%; animation: spin .9s linear infinite; }
.ai-loading strong { font-size: 20px; }
.ai-loading p { margin: 7px 0 20px; color: #718096; font-size: 13px; }
.loading-steps { display: grid; grid-template-columns: repeat(4, auto); gap: 26px; color: #9aa5b5; font-size: 12px; }
.loading-steps .active { color: #0f5fff; font-weight: 650; }
.ai-report-heading { display: flex; margin-top: 18px; align-items: flex-start; justify-content: space-between; gap: 24px; }
.ai-report-heading h2 { margin: 0; color: #0b1222; font-size: 30px; letter-spacing: -.035em; }
.ai-report-heading p { margin: 6px 0 0; color: #718096; font-size: 12px; }
.report-heading-actions { display: flex; align-items: center; gap: 10px; }
.report-heading-actions > button,
.report-document-actions button { height: 38px; padding: 0 14px; border: 1px solid #cfd8e6; border-radius: 6px; background: #fff; color: #3d4d65; font: inherit; font-size: 12px; font-weight: 620; cursor: pointer; }
.report-heading-actions > button.primary { border-color: #0f5fff; background: #0f5fff; color: #fff; }
.report-heading-actions :deep(.download-wrap) { margin: 0; }
.report-heading-actions :deep(.dl-trigger) { height: 38px; padding: 0 14px; border-radius: 6px; background: #fff; color: #3d4d65; font-weight: 620; }
.report-query-form { margin-top: 16px; }
.report-workspace { display: grid; grid-template-columns: 164px minmax(0, 1fr); margin-top: 16px; align-items: start; gap: 16px; }
.report-toc { position: sticky; top: 12px; display: flex; padding: 14px 0; overflow: hidden; flex-direction: column; border: 1px solid #dce3ed; border-radius: 7px; background: #fff; }
.report-toc strong { padding: 0 14px 10px; color: #26364f; font-size: 13px; }
.report-toc button { position: relative; padding: 9px 14px; border: 0; background: transparent; color: #657188; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.report-toc button:hover { background: #f4f7fc; color: #0f5fff; }
.report-toc button:first-of-type { color: #0f5fff; font-weight: 650; }
.report-toc button:first-of-type::before { position: absolute; top: 6px; bottom: 6px; left: 0; width: 3px; background: #1768f2; content: ''; }
.report-toc button span { margin-left: 4px; color: #718096; }
.report-document { min-width: 0; padding: 18px 20px 10px; border: 1px solid #dce3ed; border-radius: 7px; background: #fff; }
.report-document-actions { display: flex; margin: 16px -20px 0; padding: 10px 14px 0; justify-content: flex-end; border-top: 1px solid #e7ebf2; }
.report-followup { position: sticky; bottom: 0; display: grid; z-index: 4; grid-template-columns: minmax(0, 1fr) auto; margin-top: 14px; padding: 10px; gap: 10px; border: 1px solid #b9cef5; border-radius: 7px; background: rgba(255,255,255,.97); }
.report-followup input { min-width: 0; height: 40px; padding: 0 10px; border: 0; outline: 0; color: #27364d; font: inherit; }
.report-followup button { width: 70px; border: 0; border-radius: 6px; background: #0f5fff; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
.report-followup button:disabled { opacity: .45; cursor: not-allowed; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .ai-report-heading { flex-direction: column; }
  .report-workspace { grid-template-columns: 1fr; }
  .report-toc { position: static; display: grid; grid-template-columns: repeat(4, 1fr); padding: 8px; }
  .report-toc strong { grid-column: 1 / -1; }
}
</style>
