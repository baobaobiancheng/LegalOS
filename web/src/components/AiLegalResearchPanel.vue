<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { request, RequestError } from '../api/client'
import { requestStreamOrJson, type AiLegalResearchStreamEvent } from '../api/sse'
import { advanceAiLawReportDraft } from '../domain/legal-research'
import type {
  AiLawResearchReportV1,
  AiLegalResearchConversation,
  AiLegalResearchTurn,
} from '../types'
import AiLawReport from './AiLawReport.vue'
import DownloadMenu from './DownloadMenu.vue'

type FollowupOperation = 'auto' | 'correct' | 'new_issue'
type StageKey = 'understand' | 'recall' | 'verify' | 'answer'
type StageStatus = 'pending' | 'running' | 'completed' | 'empty' | 'degraded'
type StageView = { key: StageKey; title: string; detail: string; status: StageStatus }
type SearchRequest = {
  query: string
  messageId: string
  operation: FollowupOperation
  conversationId?: string
  contextVersion?: number
  parentTurnId?: string
}

const CONVERSATION_STORAGE_KEY = 'legalos.aiLegalResearchConversationId'
const query = ref('')
const submittedQuery = ref('')
const followup = ref('')
const followupOperation = ref<FollowupOperation>('auto')
const loading = ref(false)
const restoring = ref(false)
const report = ref<AiLawResearchReportV1 | null>(null)
const incomingReport = ref<AiLawResearchReportV1 | null>(null)
const answerPreview = ref('')
const reportId = ref('')
const degradedWarning = ref<{ code: string; message: string } | undefined>()
const error = ref<RequestError | null>(null)
const copied = ref(false)
const followupInput = ref<HTMLInputElement | null>(null)
const conversationId = ref('')
const contextVersion = ref(0)
const lastTurnId = ref<string | null>(null)
const turns = ref<AiLegalResearchTurn[]>([])
const candidateCount = ref(0)
const verifiedSourceCount = ref(0)
const stages = ref<StageView[]>(freshStages())
const lastRequest = ref<SearchRequest | null>(null)
const syncingConversation = ref(false)
const syncingRunId = ref('')
const syncingQuestion = ref('')
const syncingMessage = ref('正在同步最新状态…')
const resumeNotice = ref<{ tone: 'warning' | 'info'; message: string } | null>(null)
let activeAbort: AbortController | null = null
let streamFailure: RequestError | null = null
let conversationPollTimer: number | null = null
let conversationPollAbort: AbortController | null = null
let conversationPollGeneration = 0
let componentUnmounted = false

const recommended = ['离婚财产如何分割？', '员工解除劳动合同需要哪些补偿？', '供应商违约可以主张哪些责任？']
const conversationBusy = computed(() => loading.value || syncingConversation.value)
const generatedLabel = computed(() => report.value
  ? new Date(report.value.generatedAt).toLocaleString('zh-CN', { hour12: false })
  : '')
const downloadContent = computed(() => report.value ? reportToMarkdown(report.value) : '')
const operationHelp = computed(() => {
  if (followupOperation.value === 'correct') return '明确写出错误事实和正确事实；本轮会替换旧事实并重新核验受影响结论。'
  if (followupOperation.value === 'new_issue') return '沿用已确认事实，增加一个新的法律争点。'
  return '沿用当前会话事实继续追问；出现“不是…是…”时也会自动识别为事实更正。'
})

function freshStages(): StageView[] {
  return [
    { key: 'understand', title: '分析法条检索需求', detail: '等待开始', status: 'pending' },
    { key: 'recall', title: '定位与检索', detail: '等待问题理解完成', status: 'pending' },
    { key: 'verify', title: '读取权威正文', detail: '等待候选法规召回', status: 'pending' },
    { key: 'answer', title: '生成搜法报告', detail: '等待检索与详情读取完成', status: 'pending' },
  ]
}

function createMessageId() {
  return window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isUncertainStreamFailure(failure: RequestError) {
  return [
    'SSE_CONNECTION_CLOSED',
    'NETWORK_ERROR',
    'REQUEST_TIMEOUT',
    'AI_RESEARCH_TIMEOUT',
    'ANSWER_GENERATION_TIMEOUT',
    'BAD_SSE_EVENT',
  ].includes(failure.payload.code)
}

async function runSearch(nextQuery?: string, operation: FollowupOperation = 'auto', replay?: SearchRequest) {
  const value = (replay?.query ?? nextQuery ?? query.value).trim()
  if (!value || conversationBusy.value) return
  stopConversationPolling()
  activeAbort?.abort()
  const abort = new AbortController()
  activeAbort = abort
  loading.value = true
  error.value = null
  streamFailure = null
  incomingReport.value = null
  answerPreview.value = ''
  stages.value = freshStages()
  candidateCount.value = 0
  verifiedSourceCount.value = 0
  resumeNotice.value = null
  submittedQuery.value = value
  query.value = value

  const body: SearchRequest = replay ?? {
    query: value,
    messageId: createMessageId(),
    operation,
    ...(conversationId.value ? {
      conversationId: conversationId.value,
      contextVersion: contextVersion.value,
      ...(lastTurnId.value ? { parentTurnId: lastTurnId.value } : {}),
    } : {}),
  }
  lastRequest.value = body

  try {
    await requestStreamOrJson<AiLegalResearchStreamEvent>('/legal-research/ai/stream', {
      method: 'POST',
      timeoutMs: 210_000,
      timeoutCode: 'AI_RESEARCH_TIMEOUT',
      signal: abort.signal,
      body,
    }, handleStreamEvent)
    if (streamFailure) throw streamFailure
  } catch (cause) {
    incomingReport.value = null
    answerPreview.value = ''
    if (abort.signal.aborted) return
    const failure = cause instanceof RequestError
      ? cause
      : new RequestError({ error: 'AI 搜法失败，请重试', code: 'UNKNOWN', statusCode: 0 })
    if (failure.payload.code === 'AI_RESEARCH_CONTEXT_CONFLICT'
      && conversationId.value) {
      error.value = null
      await synchronizeConversation(conversationId.value)
      return
    }
    if (isUncertainStreamFailure(failure) && conversationId.value) {
      error.value = null
      await synchronizeConversation(conversationId.value)
      if (report.value || syncingConversation.value) return
    }
    error.value = failure
  } finally {
    if (activeAbort === abort) activeAbort = null
    loading.value = false
  }
}

function handleStreamEvent(event: AiLegalResearchStreamEvent) {
  if (event.type === 'research_session') {
    conversationId.value = event.conversationId
    contextVersion.value = event.contextVersion
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, event.conversationId)
    return
  }
  if (event.type === 'research_stage') {
    const index = stages.value.findIndex(item => item.key === event.stage)
    if (index >= 0) stages.value[index] = { key: event.stage, title: event.title, detail: event.detail, status: event.status }
    return
  }
  if (event.type === 'research_metrics') {
    if (typeof event.candidateCount === 'number') candidateCount.value = event.candidateCount
    if (typeof event.verifiedSourceCount === 'number') verifiedSourceCount.value = event.verifiedSourceCount
    return
  }
  if (event.type === 'answer_delta') {
    answerPreview.value += event.delta
    return
  }
  if (event.type === 'report_start') {
    answerPreview.value = ''
    incomingReport.value = advanceAiLawReportDraft(incomingReport.value, event).draft
    return
  }
  if (event.type === 'report_summary') {
    incomingReport.value = advanceAiLawReportDraft(incomingReport.value, event).draft
    return
  }
  if (event.type === 'report_section') {
    incomingReport.value = advanceAiLawReportDraft(incomingReport.value, event).draft
    return
  }
  if (event.type === 'report_source') {
    incomingReport.value = advanceAiLawReportDraft(incomingReport.value, event).draft
    return
  }
  if (event.type === 'report_limitations') {
    incomingReport.value = advanceAiLawReportDraft(incomingReport.value, event).draft
    return
  }
  if (event.type === 'report_completed') {
    const transition = advanceAiLawReportDraft(incomingReport.value, { type: 'report_completed' })
    incomingReport.value = transition.draft
    if (!transition.completed || transition.invalidCompletion) {
      streamFailure = new RequestError({
        error: '搜法报告流不完整，正在同步最新状态',
        code: 'BAD_SSE_EVENT',
        statusCode: 502,
      })
      return
    }
    report.value = transition.completed
    reportId.value = event.reportId
    contextVersion.value = event.contextVersion
    lastTurnId.value = event.turnId
    degradedWarning.value = event.degraded ? event.warning : undefined
    if (report.value) {
      const completedTurn: AiLegalResearchTurn = {
        turnId: event.turnId,
        question: submittedQuery.value,
        operation: normalizeTurnOperation(lastRequest.value?.operation),
        status: 'succeeded',
        reportId: event.reportId,
        report: report.value,
        degraded: event.degraded,
        warning: event.warning,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }
      turns.value = [...turns.value.filter(turn => turn.turnId !== event.turnId), completedTurn]
    }
    return
  }
  if (event.type === 'error') {
    incomingReport.value = null
    answerPreview.value = ''
    streamFailure = new RequestError({
      error: event.message,
      code: event.code,
      statusCode: event.code === 'AI_RESEARCH_CONTEXT_CONFLICT' ? 409 : 503,
    })
  }
}

function normalizeTurnOperation(value: FollowupOperation | undefined): AiLegalResearchTurn['operation'] {
  if (value === 'correct' || value === 'new_issue') return value
  return conversationId.value && turns.value.length ? 'continue' : 'new'
}

function submitFollowup() {
  const value = followup.value.trim()
  if (!value || !report.value || !conversationId.value || conversationBusy.value) return
  followup.value = ''
  void runSearch(value, followupOperation.value)
}

function retryLastRequest() {
  if (!lastRequest.value) return
  const transportUncertain = error.value ? isUncertainStreamFailure(error.value) : false
  const retry = transportUncertain
    ? lastRequest.value
    : {
        ...lastRequest.value,
        messageId: createMessageId(),
        ...(conversationId.value ? {
          conversationId: conversationId.value,
          contextVersion: contextVersion.value,
          ...(lastTurnId.value ? { parentTurnId: lastTurnId.value } : {}),
        } : {}),
      }
  void runSearch(undefined, retry.operation, retry)
}

function startNewConversation() {
  stopConversationPolling()
  activeAbort?.abort()
  conversationId.value = ''
  contextVersion.value = 0
  lastTurnId.value = null
  turns.value = []
  report.value = null
  incomingReport.value = null
  answerPreview.value = ''
  reportId.value = ''
  submittedQuery.value = ''
  query.value = ''
  error.value = null
  degradedWarning.value = undefined
  lastRequest.value = null
  stages.value = freshStages()
  resumeNotice.value = null
  window.localStorage.removeItem(CONVERSATION_STORAGE_KEY)
}

async function rerunAsNewConversation() {
  const value = submittedQuery.value || report.value?.query || query.value
  startNewConversation()
  if (value) await runSearch(value)
}

function showTurn(turn: AiLegalResearchTurn) {
  if (!turn.report || conversationBusy.value) return
  displayTurn(turn)
}

function displayTurn(turn: AiLegalResearchTurn) {
  if (!turn.report) return
  report.value = turn.report
  reportId.value = turn.reportId ?? ''
  submittedQuery.value = turn.question
  query.value = turn.question
  degradedWarning.value = turn.degraded ? turn.warning : undefined
}

async function restoreConversation() {
  const storedId = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)
  if (!storedId) return
  await synchronizeConversation(storedId, true)
}

async function synchronizeConversation(id: string, initialRestore = false) {
  stopConversationPolling(false)
  const generation = conversationPollGeneration
  if (initialRestore) restoring.value = true
  const abort = new AbortController()
  conversationPollAbort = abort
  try {
    const value = await request<AiLegalResearchConversation>(conversationPath(id), {
      signal: abort.signal,
      timeoutMs: 10_000,
    })
    if (componentUnmounted || generation !== conversationPollGeneration) return
    const active = applyConversation(value)
    if (active.runId) {
      beginConversationPolling(value.conversationId, active.runId, active.turn, generation)
    } else {
      finishConversationSync(value)
    }
  } catch (cause) {
    if (abort.signal.aborted || componentUnmounted || generation !== conversationPollGeneration) return
    if (cause instanceof RequestError && cause.payload.code === 'AI_RESEARCH_CONVERSATION_NOT_FOUND') {
      window.localStorage.removeItem(CONVERSATION_STORAGE_KEY)
      stopConversationPolling()
      return
    }
    syncingConversation.value = true
    syncingRunId.value = ''
    syncingQuestion.value = ''
    syncingMessage.value = '暂时未能读取最新状态，正在自动重试…'
    scheduleConversationPoll(id, generation)
  } finally {
    if (conversationPollAbort === abort) conversationPollAbort = null
    if (initialRestore) restoring.value = false
  }
}

function applyConversation(value: AiLegalResearchConversation) {
  conversationId.value = value.conversationId
  contextVersion.value = value.contextVersion
  lastTurnId.value = value.lastTurnId
  turns.value = value.turns
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, value.conversationId)

  const latestSucceeded = [...value.turns].reverse()
    .find(turn => turn.status === 'succeeded' && turn.report)
  if (latestSucceeded?.report) displayTurn(latestSucceeded)
  else report.value = null

  const declaredActiveTurn = value.activeRunId
    ? value.turns.find(turn => turn.turnId === value.activeRunId)
    : undefined
  const declaredActiveRunId = value.activeRunId
    && (!declaredActiveTurn || declaredActiveTurn.status === 'running')
    ? value.activeRunId
    : ''
  return {
    runId: declaredActiveRunId,
    turn: declaredActiveTurn,
  }
}

function beginConversationPolling(
  id: string,
  runId: string,
  turn: AiLegalResearchTurn | undefined,
  generation: number,
) {
  syncingConversation.value = true
  syncingRunId.value = runId
  syncingQuestion.value = turn?.question ?? ''
  syncingMessage.value = '正在同步最新状态；本页不会重复发起检索。'
  resumeNotice.value = null
  scheduleConversationPoll(id, generation)
}

function scheduleConversationPoll(id: string, generation: number) {
  if (componentUnmounted || generation !== conversationPollGeneration) return
  if (conversationPollTimer !== null) window.clearTimeout(conversationPollTimer)
  conversationPollTimer = window.setTimeout(() => {
    conversationPollTimer = null
    void pollConversation(id, generation)
  }, 4_000)
}

async function pollConversation(id: string, generation: number) {
  if (componentUnmounted || generation !== conversationPollGeneration) return
  const abort = new AbortController()
  conversationPollAbort = abort
  try {
    const value = await request<AiLegalResearchConversation>(conversationPath(id), {
      signal: abort.signal,
      timeoutMs: 10_000,
    })
    if (componentUnmounted || generation !== conversationPollGeneration) return
    const active = applyConversation(value)
    if (active.runId) {
      syncingConversation.value = true
      syncingRunId.value = active.runId
      syncingQuestion.value = active.turn?.question ?? syncingQuestion.value
      syncingMessage.value = '正在同步最新状态；检索完成后将自动展示报告。'
      scheduleConversationPoll(id, generation)
    } else {
      finishConversationSync(value)
    }
  } catch (cause) {
    if (abort.signal.aborted || componentUnmounted || generation !== conversationPollGeneration) return
    if (cause instanceof RequestError && cause.payload.code === 'AI_RESEARCH_CONVERSATION_NOT_FOUND') {
      window.localStorage.removeItem(CONVERSATION_STORAGE_KEY)
      stopConversationPolling()
      return
    }
    syncingConversation.value = true
    syncingMessage.value = '状态同步短暂中断，正在自动重试…'
    scheduleConversationPoll(id, generation)
  } finally {
    if (conversationPollAbort === abort) conversationPollAbort = null
  }
}

function finishConversationSync(value: AiLegalResearchConversation) {
  const targetRunId = syncingRunId.value
  const target = targetRunId
    ? value.turns.find(turn => turn.turnId === targetRunId)
    : [...value.turns].reverse()[0]
  syncingConversation.value = false
  syncingRunId.value = ''
  syncingQuestion.value = ''
  syncingMessage.value = '正在同步最新状态…'
  if (target?.status === 'failed') {
    resumeNotice.value = { tone: 'warning', message: '上一轮检索未完成，您可以重新发起检索。' }
  } else if (target?.status === 'cancelled') {
    resumeNotice.value = { tone: 'info', message: '上一轮检索已取消，您可以继续使用当前会话。' }
  } else if (target?.status === 'succeeded' && !target.report) {
    resumeNotice.value = { tone: 'warning', message: '上一轮已结束，但暂未读取到完整报告，请重新发起检索。' }
  } else {
    resumeNotice.value = null
  }
}

function stopConversationPolling(resetState = true) {
  conversationPollGeneration += 1
  if (conversationPollTimer !== null) {
    window.clearTimeout(conversationPollTimer)
    conversationPollTimer = null
  }
  conversationPollAbort?.abort()
  conversationPollAbort = null
  if (resetState) {
    syncingConversation.value = false
    syncingRunId.value = ''
    syncingQuestion.value = ''
  }
}

function conversationPath(id: string) {
  return `/legal-research/ai/conversations/${encodeURIComponent(id)}`
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

function operationLabel(value: AiLegalResearchTurn['operation']) {
  if (value === 'correct') return '事实修正'
  if (value === 'new_issue') return '新增争点'
  if (value === 'continue') return '继续追问'
  return '首次检索'
}

function stageStatusLabel(value: StageStatus) {
  if (value === 'running') return '进行中'
  if (value === 'completed') return '已完成'
  if (value === 'empty') return '无结果'
  if (value === 'degraded') return '已降级'
  return '等待中'
}

function reportToMarkdown(value: AiLawResearchReportV1) {
  const thinking = `## 检索思路\n\n### 分析法条检索需求\n\n${value.understanding.analysis}\n\n### 定位与检索\n\n${value.understanding.retrievalPlan}`
  const sections = value.sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n')
  const sources = value.sources.map(source => {
    const articles = source.articles.map(article => `- ${article.article}：${article.text}`).join('\n')
    const verifiedAt = source.lastVerifiedAt
      ? ` · 核验于 ${new Date(source.lastVerifiedAt).toLocaleString('zh-CN', { hour12: false })}`
      : ''
    return `### ${source.lawName}\n\n${source.issuingOrgan || ''}${source.timeliness ? ` · ${source.timeliness}` : ''}${verifiedAt}${articles ? `\n\n${articles}` : ''}`
  }).join('\n\n')
  const limitations = value.limitations.map(item => `- ${item}`).join('\n')
  return `# ${value.title}\n\n检索问题：${value.query}\n\n${thinking}\n\n## 总结\n\n${value.summary}\n\n${sections}\n\n## 权威来源\n\n${sources}${limitations ? `\n\n## 适用边界\n\n${limitations}` : ''}`
}

onMounted(() => {
  componentUnmounted = false
  void restoreConversation()
})
onBeforeUnmount(() => {
  componentUnmounted = true
  stopConversationPolling()
  // 模块切换只销毁当前视图：保留已发起的 SSE，让服务端会话继续执行。
  // 返回页面后由 GET 轮询接管，避免 abort 与服务端释放 activeRunId 产生竞态。
})
</script>

<template>
  <section class="ai-research-panel">
    <div
      v-if="restoring"
      class="conversation-restoring"
    >
      正在恢复上次检索会话…
    </div>

    <div
      v-if="syncingConversation && !restoring"
      class="conversation-syncing"
      aria-live="polite"
    >
      <span class="loading-mark" />
      <div>
        <strong>{{ syncingRunId ? '上一轮仍在处理中' : '正在同步上次检索会话' }}</strong>
        <p>{{ syncingMessage }}</p>
        <small v-if="syncingQuestion">检索问题：{{ syncingQuestion }}</small>
      </div>
      <span class="session-badge">自动同步</span>
    </div>

    <div
      v-if="resumeNotice && !restoring && !syncingConversation"
      :class="['conversation-resume-notice', `notice-${resumeNotice.tone}`]"
      role="status"
    >
      {{ resumeNotice.message }}
    </div>

    <template v-if="!report && !conversationBusy && !restoring">
      <div class="ai-search-intro">
        <h2>用自然语言检索并读取法律依据</h2>
        <p>AI 将展示实时检索过程，读取命中法规的权威详情正文后再流式生成结构化报告。</p>
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
          @click="retryLastRequest"
        >
          安全重试
        </button>
      </div>
    </template>

    <div
      v-if="loading"
      class="live-research"
      aria-live="polite"
    >
      <header>
        <span class="loading-mark" />
        <div>
          <strong>正在执行 AI 搜法</strong>
          <p>检索与详情读取进度会实时更新；满足运行条件后流式输出报告。</p>
        </div>
        <span
          v-if="conversationId"
          class="session-badge"
        >会话第 {{ turns.length + 1 }} 轮</span>
      </header>
      <div class="live-stage-list">
        <div
          v-for="(stage, index) in stages"
          :key="stage.key"
          :class="['live-stage', `stage-${stage.status}`]"
        >
          <span class="stage-number">{{ index + 1 }}</span>
          <div><strong>{{ stage.title }}</strong><p>{{ stage.detail }}</p></div>
          <small>{{ stageStatusLabel(stage.status) }}</small>
        </div>
      </div>
      <section
        v-if="answerPreview"
        class="live-answer-preview"
      >
        <div>
          <strong>AI 正文正在生成</strong>
          <small>已通过检索与正文读取闸门；完成后将替换为结构化报告</small>
        </div>
        <p>{{ answerPreview }}<i aria-hidden="true" /></p>
      </section>
      <footer>
        <span>候选法规 {{ candidateCount }} 部</span>
        <span>已读取正文 {{ verifiedSourceCount }} 部</span>
        <button
          type="button"
          @click="activeAbort?.abort()"
        >
          停止
        </button>
      </footer>
    </div>

    <template v-if="report">
      <div
        v-if="error"
        class="ai-error retained-report-error"
        role="alert"
      >
        <div><strong>{{ error.payload.error }}</strong><span>当前仍显示最近一次已成功生成的报告。</span><small>错误代码 {{ error.payload.code }}</small></div>
        <button
          type="button"
          @click="retryLastRequest"
        >
          安全重试
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
          <span
            v-if="conversationId"
            class="conversation-label"
          >连续检索会话 · {{ turns.length }} 轮</span>
          <h2>{{ report.title }}</h2>
          <p>{{ degradedWarning ? '检索运行条件未完全满足' : syncingConversation ? '上一轮仍在处理' : loading ? '正在流式生成' : '检索完成' }} · 已读取 {{ report.metrics.verifiedSourceCount }} 部权威法规正文 · 生成于 {{ generatedLabel }}</p>
        </div>
        <div class="report-heading-actions">
          <button
            type="button"
            :disabled="conversationBusy"
            @click="rerunAsNewConversation"
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
            :disabled="conversationBusy"
            @click="focusFollowup"
          >
            继续追问
          </button>
          <button
            type="button"
            :disabled="conversationBusy"
            @click="startNewConversation"
          >
            新建会话
          </button>
        </div>
      </header>

      <div class="report-workspace">
        <nav
          class="report-toc"
          aria-label="报告目录与轮次"
        >
          <strong>检索会话</strong>
          <button
            v-for="(turn, index) in turns"
            :key="turn.turnId"
            type="button"
            :disabled="!turn.report || conversationBusy"
            @click="showTurn(turn)"
          >
            第 {{ index + 1 }} 轮 · {{ operationLabel(turn.operation) }}
            <small>{{ turn.question }}</small>
          </button>
          <strong class="toc-section-title">报告目录</strong>
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
            <span v-if="loading">报告正在按结构逐段到达…</span>
            <span v-else-if="syncingConversation">正在同步上一轮检索结果…</span>
            <button
              type="button"
              :disabled="conversationBusy"
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
        <div
          class="followup-modes"
          aria-label="追问类型"
        >
          <button
            type="button"
            :class="{ active: followupOperation === 'auto' }"
            @click="followupOperation = 'auto'"
          >
            继续追问
          </button>
          <button
            type="button"
            :class="{ active: followupOperation === 'correct' }"
            @click="followupOperation = 'correct'"
          >
            修正事实
          </button>
          <button
            type="button"
            :class="{ active: followupOperation === 'new_issue' }"
            @click="followupOperation = 'new_issue'"
          >
            新增争点
          </button>
          <small>{{ operationHelp }}</small>
        </div>
        <div class="followup-input-row">
          <input
            id="ai-report-followup"
            ref="followupInput"
            v-model="followup"
            :placeholder="followupOperation === 'correct' ? '例如：不是 2024 年签约，是 2023 年' : '基于本检索会话继续追问...'"
            :disabled="conversationBusy"
          >
          <button
            :disabled="!followup.trim() || conversationBusy"
            type="submit"
          >
            发送
          </button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.ai-research-panel { min-height: 420px; }
.conversation-restoring { display: grid; min-height: 360px; place-items: center; color: #657188; font-size: 14px; }
.conversation-syncing { display: flex; margin: 18px 0; padding: 18px 20px; align-items: center; gap: 13px; border: 1px solid #cddcf5; border-radius: 9px; background: linear-gradient(180deg, #f8fbff 0%, #fff 100%); box-shadow: 0 8px 28px rgba(37, 78, 138, .07); }
.conversation-syncing > div { min-width: 0; flex: 1; }
.conversation-syncing strong { color: #172943; font-size: 16px; }
.conversation-syncing p { margin: 3px 0 0; color: #708099; font-size: 12px; }
.conversation-syncing small { display: block; margin-top: 7px; overflow: hidden; color: #526b91; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.conversation-resume-notice { margin: 16px 0; padding: 11px 14px; border-radius: 7px; font-size: 12px; line-height: 1.6; }
.conversation-resume-notice.notice-warning { border: 1px solid #f2c98a; background: #fff9ef; color: #81500c; }
.conversation-resume-notice.notice-info { border: 1px solid #cddcf5; background: #f7faff; color: #526b91; }
.ai-search-intro { margin-top: 34px; }
.ai-search-intro h2 { margin: 0; color: #0b1222; font-size: 30px; letter-spacing: -.035em; }
.ai-search-intro p { margin: 8px 0 0; color: #657188; font-size: 14px; }
.ai-search-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; margin-top: 24px; gap: 14px; }
.ai-search-form input { height: 54px; padding: 0 16px; border: 1px solid #9dbdff; border-radius: 7px; outline: 0; background: #fff; color: #172033; font: inherit; font-size: 15px; }
.ai-search-form input:focus { border-color: #1768f2; box-shadow: 0 0 0 3px rgba(23, 104, 242, .08); }
.ai-search-form > button { min-width: 132px; border: 0; border-radius: 7px; background: #0f5fff; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
.ai-search-form button:disabled { opacity: .5; cursor: not-allowed; }
.ai-recommended { display: flex; margin-top: 12px; align-items: center; flex-wrap: wrap; color: #66748a; font-size: 12px; }
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
.live-research { margin: 18px 0; overflow: hidden; border: 1px solid #cddcf5; border-radius: 9px; background: linear-gradient(180deg, #f8fbff 0%, #fff 100%); box-shadow: 0 8px 28px rgba(37, 78, 138, .07); }
.live-research > header { display: flex; padding: 18px 20px; align-items: center; gap: 13px; border-bottom: 1px solid #e2eaf5; }
.live-research header > div { min-width: 0; flex: 1; }
.live-research header strong { color: #172943; font-size: 17px; }
.live-research header p { margin: 3px 0 0; color: #708099; font-size: 12px; }
.loading-mark { width: 24px; height: 24px; border: 3px solid #dbe6fa; border-top-color: #1768f2; border-radius: 50%; animation: spin .9s linear infinite; }
.session-badge,
.conversation-label { color: #0f5fff; font-size: 11px; font-weight: 680; }
.session-badge { padding: 4px 8px; border-radius: 999px; background: #eaf2ff; }
.live-stage-list { padding: 5px 20px; }
.live-stage { display: grid; position: relative; grid-template-columns: auto minmax(0, 1fr) auto; padding: 12px 0; align-items: flex-start; gap: 12px; }
.live-stage + .live-stage { border-top: 1px solid #edf1f6; }
.stage-number { display: grid; width: 25px; height: 25px; border: 1px solid #cbd6e5; border-radius: 50%; place-items: center; background: #fff; color: #7b899c; font-size: 11px; font-weight: 700; }
.live-stage div { min-width: 0; }
.live-stage strong { display: block; color: #27364d; font-size: 13px; }
.live-stage p { margin: 2px 0 0; color: #6c7a8e; font-size: 12px; line-height: 1.55; }
.live-stage small { padding-top: 3px; color: #97a2b2; font-size: 11px; }
.live-stage.stage-running .stage-number { border-color: #1768f2; background: #edf4ff; color: #0f5fff; }
.live-stage.stage-running small { color: #0f5fff; font-weight: 650; }
.live-stage.stage-completed .stage-number { border-color: #50b786; background: #edf9f3; color: #159957; }
.live-stage.stage-completed small { color: #159957; }
.live-stage.stage-degraded .stage-number { border-color: #e0a04d; background: #fff6e8; color: #a45d08; }
.live-stage.stage-degraded small { color: #a45d08; }
.live-answer-preview { margin: 4px 20px 16px; padding: 14px 16px 16px; border: 1px solid #d9e5f7; border-radius: 7px; background: #fff; }
.live-answer-preview > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.live-answer-preview strong { color: #20334f; font-size: 13px; }
.live-answer-preview small { color: #7a899f; font-size: 10px; }
.live-answer-preview p { margin: 10px 0 0; color: #28384e; font-size: 13px; line-height: 1.8; white-space: pre-wrap; }
.live-answer-preview p i { display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: -.12em; background: #1768f2; animation: cursor-blink .8s steps(1) infinite; }
.live-research > footer { display: flex; padding: 10px 20px; align-items: center; gap: 18px; border-top: 1px solid #e7edf5; background: #fbfcfe; color: #64748b; font-size: 11px; }
.live-research footer button { margin-left: auto; padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; color: #475569; font: inherit; cursor: pointer; }
.ai-report-heading { display: flex; margin-top: 18px; align-items: flex-start; justify-content: space-between; gap: 24px; }
.ai-report-heading h2 { margin: 3px 0 0; color: #0b1222; font-size: 30px; letter-spacing: -.035em; }
.ai-report-heading p { margin: 6px 0 0; color: #718096; font-size: 12px; }
.report-heading-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.report-heading-actions > button,
.report-document-actions button { height: 38px; padding: 0 14px; border: 1px solid #cfd8e6; border-radius: 6px; background: #fff; color: #3d4d65; font: inherit; font-size: 12px; font-weight: 620; cursor: pointer; }
.report-heading-actions > button.primary { border-color: #0f5fff; background: #0f5fff; color: #fff; }
.report-heading-actions > button:disabled,
.report-document-actions button:disabled { opacity: .45; cursor: not-allowed; }
.report-heading-actions :deep(.download-wrap) { margin: 0; }
.report-heading-actions :deep(.dl-trigger) { height: 38px; padding: 0 14px; border-radius: 6px; background: #fff; color: #3d4d65; font-weight: 620; }
.report-workspace { display: grid; grid-template-columns: 185px minmax(0, 1fr); margin-top: 16px; align-items: start; gap: 16px; }
.report-toc { position: sticky; top: 12px; display: flex; padding: 14px 0; overflow: hidden; flex-direction: column; border: 1px solid #dce3ed; border-radius: 7px; background: #fff; }
.report-toc > strong { padding: 0 14px 8px; color: #26364f; font-size: 13px; }
.report-toc .toc-section-title { margin-top: 8px; padding-top: 10px; border-top: 1px solid #e7ebf2; }
.report-toc button { position: relative; display: flex; padding: 7px 14px; overflow: hidden; flex-direction: column; border: 0; background: transparent; color: #657188; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
.report-toc button:hover { background: #f4f7fc; color: #0f5fff; }
.report-toc button:disabled { cursor: default; opacity: .55; }
.report-toc button small { overflow: hidden; max-width: 100%; color: #8793a6; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.report-toc button span { margin-left: 4px; color: #718096; }
.report-document { min-width: 0; padding: 18px 20px 10px; border: 1px solid #dce3ed; border-radius: 7px; background: #fff; }
.report-document-actions { display: flex; margin: 16px -20px 0; padding: 10px 14px 0; align-items: center; justify-content: flex-end; gap: 12px; border-top: 1px solid #e7ebf2; }
.report-document-actions span { color: #0f5fff; font-size: 11px; }
.report-followup { position: sticky; bottom: 0; z-index: 4; margin-top: 14px; padding: 10px; border: 1px solid #b9cef5; border-radius: 7px; background: rgba(255,255,255,.98); box-shadow: 0 -8px 24px rgba(39, 77, 132, .06); }
.followup-modes { display: flex; padding: 0 2px 8px; align-items: center; flex-wrap: wrap; gap: 5px; }
.followup-modes button { padding: 4px 9px; border: 1px solid #d5deea; border-radius: 999px; background: #fff; color: #617088; font: inherit; font-size: 11px; cursor: pointer; }
.followup-modes button.active { border-color: #8bb1f7; background: #edf4ff; color: #0f5fff; font-weight: 650; }
.followup-modes small { margin-left: 6px; color: #7b8798; font-size: 10px; }
.followup-input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
.followup-input-row input { min-width: 0; height: 40px; padding: 0 10px; border: 0; outline: 0; color: #27364d; font: inherit; }
.followup-input-row > button { width: 70px; border: 0; border-radius: 6px; background: #0f5fff; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
.followup-input-row > button:disabled { opacity: .45; cursor: not-allowed; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes cursor-blink { 50% { opacity: 0; } }

@media (max-width: 900px) {
  .ai-report-heading { flex-direction: column; }
  .report-workspace { grid-template-columns: 1fr; }
  .report-toc { position: static; }
  .live-research > header { align-items: flex-start; }
  .session-badge { display: none; }
  .followup-modes small { width: 100%; margin: 2px 0 0; }
}
</style>
