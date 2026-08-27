<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { gsap } from 'gsap'
import { request, RequestError } from '../../api/client'
import { requestStreamOrJson, type ConsultStreamEvent } from '../../api/sse'
import { useFileUpload } from '../../composables/useFileUpload'
import type { AttachedFile } from '../../composables/useFileUpload'
import { useSmoothStream } from '../../composables/useSmoothStream'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import ChatInputBar from '../../components/ChatInputBar.vue'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import ErrorState from '../../components/ErrorState.vue'
import type { ProjectDetail } from '../../types'

const { buildFullInput, buildDisplayText, formatSize } = useFileUpload()
const pageRoot = ref<HTMLElement | null>(null)

const sending = ref(false)
const upgrading = ref(false)
const upgraded = ref(false)
const expectingAI = ref(false)
const projectId = ref('')
const projectRoute = ref('')
const messages = ref<any[]>([])
const msgContainer = ref<HTMLElement | null>(null)
// 思考过程（2026-08-11 app-server 双路流）：当前 AI 回复的推理增量,可折叠
const aiThinking = ref('')
const showThinking = ref(true)
/** 回答正文开始输出后自动收起为「分析完成」（review 2026-08-12 P1-2） */
const thinkingDone = ref(false)
/** 最后一条用户消息 key：思考框紧跟其下、每次回答仅一个框（review 2026-08-11 P1） */
const lastUserMsgKey = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m?.role === 'user') return m.id ?? m._key
  }
  return ''
})
/** P1-2：只渲染推理尾部（最后 ~800 字），顶部淡出，无内部滚动条 */
const thinkingTail = computed(() => {
  const text = aiThinking.value
  if (text.length <= 800) return text
  const tail = text.slice(-800)
  const boundary = tail.indexOf('\n')
  return boundary >= 0 ? tail.slice(boundary + 1) : tail
})

const lastError = ref<RequestError | null>(null)
type ConsultationCapability = 'general' | 'law_search' | 'similar_case'
const selectedCapability = ref<ConsultationCapability>('general')
const lastSubmission = ref<{ text: string; files: AttachedFile[]; capability: ConsultationCapability } | null>(null)

// ── 会话持久化（2026-08-11）：切页/刷新保留当前咨询，「新建会话」才清空 ──
const SESSION_KEY = 'legalos:consult-session'
const saveSession = () => {
  if (projectId.value) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ projectId: projectId.value, route: projectRoute.value }))
  }
}
const clearSession = () => localStorage.removeItem(SESSION_KEY)

// 会话代次：新建会话/过期恢复响应不覆盖当前状态（review 2026-08-11 竞态防护）
let sessionGen = 0
const restoring = ref(false)
// 当前咨询请求取消控制器（P1：新建会话/卸载时中止旧请求，防旧答案写进新会话）
let activeAbort: AbortController | null = null
const abortActiveRequest = () => {
  if (activeAbort) { activeAbort.abort(); activeAbort = null }
}

const startNewSession = () => {
  sessionGen++
  abortActiveRequest() // 中止正在进行的旧请求
  clearSession()
  projectId.value = ''
  projectRoute.value = ''
  upgraded.value = false
  messages.value = []
  lastError.value = null
  forceScrollBottom()
}

/** 切页回来恢复上次咨询会话：拉取工单 + 重建消息时间线（期间禁用输入,防跨工单消息混合） */
const restoreSession = async () => {
  const gen = sessionGen
  restoring.value = true
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { projectId?: string }
    if (!saved?.projectId) return
    const data = await request<ProjectDetail>(`/projects/${saved.projectId}`)
    if (gen !== sessionGen) return // 恢复期间已新建会话 → 丢弃过期响应
    projectId.value = data.id
    projectRoute.value = data.route
    upgraded.value = data.route === 'legalbp'
    const tl: any[] = []
    // P0-2：恢复的已落库 assistant 消息标记为 completed（Markdown 按 status 决定流式/最终）
    for (const m of data.messages) tl.push({ ...m, ...(m.role === 'assistant' ? { status: 'completed' } : {}) })
    for (const e of data.events) tl.push({ ...e, _event: true })
    tl.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    messages.value = tl
    forceScrollBottom()
  } catch (error) {
    if (gen !== sessionGen) return
    // 仅数据损坏/403/404 才清会话；网络错误/5xx 保留 key（下次刷新可重试）
    const isReqErr = error instanceof RequestError
    const status = isReqErr ? error.payload.statusCode : undefined
    if (!isReqErr || status === 403 || status === 404) clearSession()
    else lastError.value = isReqErr ? error : new RequestError({ error: '会话恢复失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    if (gen === sessionGen) restoring.value = false
  }
}

/** P1-3：是否贴合底部（用户向上滚超过 80px 则暂停自动跟随） */
const stickToBottom = ref(true)
const onMsgScroll = () => {
  const el = msgContainer.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.clientHeight - el.scrollTop <= 80
}
/** 强制回到底部（新提问 / 恢复会话 / 点「回到最新」） */
const forceScrollBottom = () => {
  stickToBottom.value = true
  nextTick(() => {
    const el = msgContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}
/** P0（review 2026-08-12）：流式期间每动画帧最多滚动一次，避免逐 token 重排 */
let scrollFrame: number | null = null
const scheduleScroll = () => {
  if (!stickToBottom.value || scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null
    const el = msgContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const suggestionGroups = [
  [
    '员工拒签劳动合同怎么办？',
    '供应商违约后如何追责？',
    '营销活动需要哪些合规审查？',
    '客户数据能否用于模型训练？',
  ],
  [
    '试用期解除员工有哪些风险？',
    '客户拖欠货款如何保全证据？',
    '对外宣传能否使用竞品数据？',
    '业务系统收集信息需要哪些授权？',
  ],
]
const suggestionGroup = ref(0)
const suggestedQuestions = computed(() => suggestionGroups[suggestionGroup.value])
const cycleSuggestions = () => {
  suggestionGroup.value = (suggestionGroup.value + 1) % suggestionGroups.length
}
const hasConversation = computed(() => Boolean(projectId.value || messages.value.length || expectingAI.value || restoring.value))
const conversationTitle = computed(() => {
  const firstQuestion = messages.value.find(message => message?.role === 'user')?.text?.trim()
  return firstQuestion ? String(firstQuestion).split('\n')[0].slice(0, 36) : '法律咨询'
})
const copiedMessageId = ref('')
const copyAnswer = async (message: any) => {
  const text = String(message.text || '')
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copiedMessageId.value = String(message.id ?? message._key ?? '')
  window.setTimeout(() => {
    if (copiedMessageId.value === String(message.id ?? message._key ?? '')) copiedMessageId.value = ''
  }, 1600)
}

/** 客户端幂等键（2026-08-12 多轮上下文改造）：每次发送生成一个，防双重提交/网络重试产生重复回答。
 *  非安全上下文(http://IP)没有 crypto.randomUUID，用 getRandomValues 兜底。 */
const genIdempotencyKey = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* 落到兜底 */ }
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

const sendSuggested = (q: string) => {
  handleSend(q, [])
}

const handleSend = async (text: string, files: AttachedFile[], capability = selectedCapability.value) => {
  // 防重复点击（review 2026-08-11）：发送/思考/恢复期间忽略再次提交（后端幂等是最终保障）
  if (sending.value || expectingAI.value || restoring.value) return
  const gen = sessionGen // 新建会话后丢弃过期响应
  lastSubmission.value = { text, files, capability }
  const fullInput = buildFullInput(text, files)
  const displayText = buildDisplayText(text, files)
  // 首条消息：建单已落库,后续 /messages 只启动首轮回答(firstReply=true,不重复写消息/评估)
  const firstReply = !projectId.value
  // 客户端幂等键：同一次发送若被重复提交，后端按 key 去重，只启动一次 AI
  const idempotencyKey = genIdempotencyKey()
  // 附件：只提交就绪的 attachmentId，正文由后端注入（review 2026-08-12）
  const attachmentIds = files.filter(f => f.status === 'ready' || f.status === 'warning').map(f => f.id)
  // P1：本次请求取消控制器（新建会话/卸载时中止）
  const abortCtrl = new AbortController()
  activeAbort = abortCtrl

  sending.value = true
  lastError.value = null
  messages.value.push({ role: 'user', text: displayText, _files: files, _key: genIdempotencyKey() })
  forceScrollBottom()

  if (!projectId.value) {
    try {
      // 建单含风险分类(直连网关短超时 15s)。超时 45s：必须晚于后端分类超时(15s)，
      // 让后端分类失败时能走确定性规则(P1)兜底返回；早于 SSE 生成超时(10min)。
      const data = await request<{ id: string; route: string; risk?: string }>('/projects', {
        method: 'POST',
        timeoutMs: 45_000,
        timeoutCode: 'PROJECT_CREATE_TIMEOUT',
        signal: abortCtrl.signal,
        body: {
          kind: 'consult',
          title: text.slice(0, 50) || '文件咨询',
          input: fullInput,
          // P2d：建单也带幂等键——建单成功但响应丢失时重试不会创建第二个工单
          idempotencyKey,
          // 附件 id（正文由后端注入；2026-08-12）
          attachmentIds,
          capability,
        },
      })
      projectId.value = data.id; projectRoute.value = data.route
      saveSession()
      if (data.route === 'legalbp') {
        messages.value.push({ _event: true, text: '系统判定 ' + data.risk + ' 风险，已创建工单并通知法务 BP', _key: genIdempotencyKey() })
        upgraded.value = true
      }
    } catch (error) {
      lastError.value = error instanceof RequestError
        ? error
        : new RequestError({ error: '服务异常，请稍后重试', code: 'UNKNOWN', statusCode: 0 })
      messages.value.push({ _event: true, text: lastError.value.payload.error, _key: genIdempotencyKey() })
      sending.value = false
      return
    }
  }

  if (projectRoute.value === 'llm' && !upgraded.value) {
    expectingAI.value = true
    aiThinking.value = ''
    showThinking.value = true
    thinkingDone.value = false
    // 提升到 try 外：catch 需据此把流式错误附着在对应回答内（P0-3）
    let fullText = ''
    let aiMsg: any | undefined
    // P0-2：message_start 只保存运行身份，首个 text_delta 才创建可见 AI 消息（防思考期空白框）
    let pendingRun: { runId: string; messageId: string } | undefined
    let lastSeq = 0
    // P0（review 2026-08-12）：流式调度器——SSE 高频入队，rAF 32ms 批量渲染，消除一卡一卡
    const streamRenderer = useSmoothStream()
    streamRenderer.setListener((text) => {
      if (aiMsg) aiMsg.text = text
      scheduleScroll()
    })
    try {
      // 非流式 JSON 响应（幂等命中/升级）shape
      type ConsultJsonResponse = { route?: string; status?: string; message?: any }
      const data = (await requestStreamOrJson<ConsultStreamEvent | ConsultJsonResponse>(`/projects/${projectId.value}/messages`, {
        method: 'POST',
        // P1（2026-08-12）：SSE 响应头等待超时显式 45s（默认 30s 会撞上分类兜底/上下文构建）。
        // 只约束「等响应头」，正文流由 SSE 空闲超时(120s)守护。
        timeoutMs: 45_000,
        timeoutCode: 'SSE_HEADER_TIMEOUT',
        signal: abortCtrl.signal,
        body: { text: fullInput, firstReply, idempotencyKey, attachmentIds, capability },
      }, (d) => {
        // onEvent 只收 SSE 事件；非流式 JSON 响应不会走到这里
        if (!('type' in d)) return
        const evt = d as ConsultStreamEvent
        // 有身份流式协议（2026-08-12 P0）：runId/messageId/seq
        // - 忽略 seq <= lastSeq 的过期/重复帧
        // - 一次 runId 只建一个 assistant 节点（id=messageId）
        // - message_end.finalText 权威覆盖，绝不追加
        if (evt.type === 'message_start') {
          // P0-2：只保存运行身份，不创建可见消息（避免思考期出现空白 AI 框/头像/操作按钮）
          if (!pendingRun) pendingRun = { runId: evt.runId, messageId: evt.messageId }
          return
        }
        if (typeof evt.seq === 'number' && evt.seq <= lastSeq) return
        if (evt.type === 'reasoning_delta') {
          lastSeq = evt.seq
          // P1：只保留最近 16KB 思考文本（UI 只显示尾部 800 字，内存不无限增长）
          aiThinking.value = (aiThinking.value + evt.delta).slice(-16000)
          return
        }
        if (evt.type === 'text_delta') {
          lastSeq = evt.seq
          // P0-2：第一条正文到达才创建可见 AI 消息
          if (!aiMsg && pendingRun) {
            aiMsg = { id: pendingRun.messageId, role: 'assistant', text: '', status: 'streaming' }
            messages.value.push(aiMsg)
          }
          // P1-2：正文开始输出 → 思考区自动收起为「分析完成」
          if (!thinkingDone.value) { thinkingDone.value = true; showThinking.value = false }
          if (aiMsg) aiMsg.status = 'streaming'
          fullText += evt.delta
          streamRenderer.enqueue(evt.delta) // 只入队，不直接更新页面（P0 调度器）
          return
        }
        if (evt.type === 'message_end') {
          lastSeq = evt.seq
          fullText = evt.finalText
          // P0-2：边界——finalText 为空按协议异常处理，不生成空白成功消息；
          //       有 finalText 但此前无 text_delta（极短答案）→ 此时才创建消息
          if (evt.finalText) {
            if (!aiMsg && pendingRun) {
              aiMsg = { id: pendingRun.messageId, role: 'assistant', text: '', status: 'streaming' }
              messages.value.push(aiMsg)
            }
            // P0：权威校准——清空缓冲、以 finalText 收口
            streamRenderer.finish(evt.finalText)
            if (aiMsg) aiMsg.status = 'completed'
            if (aiMsg && evt.research) aiMsg.research = evt.research
          }
          scheduleScroll()
          return
        }
        if (evt.type === 'error') {
          lastSeq = evt.seq
          // P0-2：正文前的 error 不创建空白气泡；有正文则附着在回答内
          if (aiMsg) {
            aiMsg.status = 'failed'
            streamRenderer.finish(`⚠️ ${evt.message}`)
          } else {
            messages.value.push({ _event: true, text: evt.message, actions: evt.actions, _key: genIdempotencyKey() })
          }
        }
      })) as ConsultJsonResponse | undefined
      if (data?.route === 'legalbp') {
        messages.value.push({ _event: true, text: '追问触发风险升级，已通知法务 BP 人工处理', _key: genIdempotencyKey() })
        upgraded.value = true; projectRoute.value = 'legalbp'
      }
      // F6（review 2026-08-12）：幂等命中已有答案/已在处理（无流，返回普通 JSON）
      if (data?.status === 'succeeded' && data.message) {
        const ans = data.message
        // 按 id 去重（不再按 text——文本相同不代表消息相同）
        if (!messages.value.some((m) => m.id === ans.id)) {
          messages.value.push(ans)
        }
      } else if (data?.status === 'running') {
        messages.value.push({ _event: true, text: '该问题正在处理中，请稍后刷新查看', _key: genIdempotencyKey() })
      }
    } catch (error) {
      if (gen !== sessionGen) return // 新建会话已清空，丢弃过期响应
      streamRenderer.cancel() // 兜底取消待执行帧，防陈旧绘制
      const reqErr = error instanceof RequestError
        ? error
        : new RequestError({ error: '消息发送失败，请重试', code: 'UNKNOWN', statusCode: 0 })
      // P0-3：流式错误附着在对应 AI 回答内；已 message_end 的后续 EOF 不报错；不再全局双重显示
      if (aiMsg) {
        if (aiMsg.status !== 'completed') {
          aiMsg.status = 'incomplete'
          aiMsg.errorText = reqErr.payload.error
          streamRenderer.finish(fullText) // 立即展示已收到的部分，再标不完整
        }
      } else {
        messages.value.push({ _event: true, text: reqErr.payload.error, _key: genIdempotencyKey() })
      }
    }
    expectingAI.value = false
  } else {
    messages.value.push({ _event: true, text: '已收到，法务 BP 处理后将回传至此处', _key: genIdempotencyKey() })
  }
  sending.value = false
  forceScrollBottom()
}

const handleErrorAction = (action: string) => {
  if (action === 'escalate') return handleUpgrade()
  const last = lastSubmission.value
  if (!last) return
  const capability = action === 'switch_general' ? 'general' : last.capability
  selectedCapability.value = capability
  void handleSend(last.text, last.files, capability)
}

const handleUpgrade = async () => {
  if (upgrading.value || !projectId.value) return
  upgrading.value = true
  lastError.value = null
  try {
    // review 2026-08-12 P0：独立升级命令接口（返回 JSON，不启动模型/不写用户消息/不建 run）
    await request<{ upgraded: boolean; route: 'legalbp'; status: string }>(`/projects/${projectId.value}/escalate`, {
      method: 'POST',
      body: { reason: 'user_requested' },
    })
    upgraded.value = true
    projectRoute.value = 'legalbp'
    messages.value.push({ _event: true, text: '已申请升级人工处理，法务 BP 将尽快跟进', _key: genIdempotencyKey() })
    forceScrollBottom()
  } catch (error) {
    lastError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '升级人工处理失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
  upgrading.value = false
}

let animationContext: gsap.Context | null = null
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

onMounted(() => {
  void restoreSession()
  nextTick(() => {
    if (!pageRoot.value) return
    animationContext = gsap.context(() => {
      if (reducedMotion()) return
      gsap.from('.consult-breadcrumb', { autoAlpha: 0, y: 10, duration: .42, ease: 'power2.out' })
      gsap.from('.consult-intro > *, .session-heading > *', {
        autoAlpha: 0,
        y: 18,
        duration: .58,
        stagger: .08,
        ease: 'power2.out',
      })
      gsap.from('.suggestion-item, .msg-row', {
        autoAlpha: 0,
        y: 14,
        duration: .48,
        stagger: .055,
        delay: .12,
        ease: 'power2.out',
      })
      gsap.from('.welcome-composer, .conversation-composer', {
        autoAlpha: 0,
        y: 12,
        duration: .5,
        delay: .2,
        ease: 'power2.out',
      })
    }, pageRoot.value)
  })
})

onUnmounted(() => {
  abortActiveRequest()
  animationContext?.revert()
})

</script>

<template>
  <BusinessSidebarLayout active-key="consult">
    <div
      ref="pageRoot"
      :class="['consult-page', { 'conversation-state': hasConversation }]"
    >
      <template v-if="!hasConversation">
        <header class="consult-welcome-header">
          <p class="consult-breadcrumb">
            业务工作台 <span>/</span> 法律咨询
          </p>
          <div class="consult-intro">
            <h1>今天想解决什么法律问题？</h1>
            <p>描述业务背景与诉求，AI 将先给出可核验的法律建议；<br>高风险事项可随时转交法务 BP。</p>
          </div>
        </header>

        <section
          class="suggestions-section"
          aria-labelledby="suggestions-title"
        >
          <div class="suggestions-heading">
            <h2 id="suggestions-title">
              推荐提问
            </h2>
            <button
              type="button"
              @click="cycleSuggestions"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" /></svg>
              换一组
            </button>
          </div>
          <div class="suggestions-grid">
            <button
              v-for="question in suggestedQuestions"
              :key="question"
              class="suggestion-item"
              type="button"
              @click="sendSuggested(question)"
            >
              <span>{{ question }}</span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
        </section>

        <div class="welcome-composer">
          <ChatInputBar
            v-model:capability="selectedCapability"
            appearance="welcome"
            :disabled="sending || restoring"
            @send="handleSend"
          />
          <p>AI 生成内容仅供参考，重要事项建议由法务复核</p>
        </div>
        <ErrorState
          v-if="lastError"
          :message="lastError.payload.error"
          :request-id="lastError.payload.requestId"
        />
      </template>

      <template v-else>
        <header class="session-heading">
          <div>
            <p class="consult-breadcrumb">
              业务工作台 <span>/</span> 法律咨询
            </p>
            <h1>{{ conversationTitle }}</h1>
            <p>本会话内的追问会参考此前问答</p>
          </div>
          <button
            class="new-session-button"
            type="button"
            :disabled="sending || expectingAI || restoring"
            @click="startNewSession"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            ><path d="M12 5v14M5 12h14" /></svg>
            新建会话
          </button>
        </header>

        <div
          ref="msgContainer"
          class="msg-scroll"
          @scroll="onMsgScroll"
        >
          <div class="msg-thread">
            <template
              v-for="m in messages"
              :key="m.id ?? m._key"
            >
              <div
                v-if="m._event"
                class="msg-event"
              >
                <span>{{ m.text }}</span>
                <span
                  v-if="m.actions?.length"
                  class="event-actions"
                >
                  <button
                    v-if="m.actions.includes('retry')"
                    @click="handleErrorAction('retry')"
                  >重试</button>
                  <button
                    v-if="m.actions.includes('switch_general')"
                    @click="handleErrorAction('switch_general')"
                  >改选通用咨询</button>
                  <button
                    v-if="m.actions.includes('escalate')"
                    @click="handleErrorAction('escalate')"
                  >转人工</button>
                </span>
              </div>
              <div
                v-else
                :class="['msg-row', m.role === 'user' ? 'out' : 'in']"
              >
                <div
                  v-if="m.role === 'assistant'"
                  class="msg-avatar ai"
                >
                  AI
                </div>
                <div class="msg-body">
                  <div class="msg-bubble">
                    <div
                      v-if="m.role === 'assistant' && m.research"
                      class="evidence-status"
                    >
                      <span>✓ {{ m.research.trace.status === 'success_hit' ? '已完成来源检索' : '未检索到可核验来源' }}</span>
                    </div>
                    <MarkdownContent
                      v-if="m.role === 'assistant'"
                      :text="m.text"
                      :streaming="m.status === 'streaming'"
                      :done="m.status === 'completed'"
                    />
                    <template v-else>
                      {{ m.text }}
                    </template>
                    <!-- P0-3：流式错误/不完整附着在回答内，不再全局 ErrorState 双重显示 -->
                    <div
                      v-if="m.role === 'assistant' && (m.status === 'failed' || m.status === 'incomplete')"
                      class="msg-error"
                    >
                      {{ m.errorText || (m.status === 'incomplete' ? '回答可能不完整' : 'AI 答复生成失败') }}
                    </div>
                    <details
                      v-if="m.role === 'assistant' && m.research?.trace?.calls?.some((call: any) => call.records?.length)"
                      class="research-sources"
                      open
                    >
                      <summary>参考来源</summary>
                      <div
                        v-for="record in m.research.trace.calls.flatMap((call: any) => call.records)"
                        :key="String(record.recordId || record.sourceId)"
                        class="source-row"
                      >
                        <strong>{{ record.lawName || record.title }}</strong>
                        <span v-if="record.issuingOrgan || record.court">{{ record.issuingOrgan || record.court }}</span>
                        <span v-if="record.issuingNo || record.caseNumber">{{ record.issuingNo || record.caseNumber }}</span>
                        <span v-if="record.implementDate || record.date">{{ record.implementDate || record.date }}</span>
                        <span v-if="record.timeliness">{{ record.timeliness }}</span>
                        <a
                          v-if="record.url"
                          :href="String(record.url)"
                          target="_blank"
                          rel="noopener noreferrer"
                        >查看原始来源</a>
                      </div>
                    </details>
                    <div
                      v-if="m.role === 'assistant' && m.status === 'completed' && m.text"
                      class="answer-actions"
                    >
                      <button
                        class="copy-answer"
                        type="button"
                        @click="copyAnswer(m)"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          aria-hidden="true"
                        ><rect
                          x="9"
                          y="9"
                          width="11"
                          height="11"
                          rx="2"
                        /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg>
                        {{ copiedMessageId === String(m.id ?? m._key ?? '') ? '已复制' : '复制' }}
                      </button>
                      <DownloadMenu
                        :content="m.text"
                        :filename="'法律咨询答复'"
                      />
                      <button
                        v-if="projectId && projectRoute === 'llm' && !upgraded && m === messages[messages.length - 1]"
                        class="escalate-btn"
                        :disabled="upgrading"
                        @click="handleUpgrade"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          aria-hidden="true"
                        ><circle
                          cx="12"
                          cy="8"
                          r="4"
                        /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
                        {{ upgrading ? '转交中…' : '转交法务 BP' }}
                      </button>
                    </div>
                  </div>
                  <div
                    v-if="m._files?.length"
                    class="file-tags"
                  >
                    <span
                      v-for="f in m._files"
                      :key="f.id"
                      class="file-tag"
                    >
                      <svg
                        class="ft-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        aria-hidden="true"
                      ><path d="m21.4 11.1-9.2 9.1a6 6 0 0 1-8.5-8.5l9.2-9.1a4 4 0 0 1 5.7 5.6l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5" /></svg>
                      <span class="ft-name">{{ f.name }}</span><span class="ft-size">{{ formatSize(f.size) }}</span>
                    </span>
                  </div>
                </div>
              </div>
              <!-- 思考过程：紧跟最后一条用户消息下方,每次回答仅一个框（P1-2：无内部滚动条,展示尾部,正文开始自动收起） -->
              <div
                v-if="(m.id ?? m._key) === lastUserMsgKey && expectingAI && aiThinking"
                class="thinking-panel"
              >
                <button
                  class="thinking-toggle"
                  @click="showThinking = !showThinking"
                >
                  {{ showThinking ? '▾' : '▸' }} {{ thinkingDone ? '分析完成' : '思考过程' }}
                </button>
                <div
                  v-if="showThinking"
                  class="thinking-body"
                >
                  {{ thinkingTail }}
                </div>
              </div>
            </template>
          </div>
          <!-- P1-3：用户向上滚动暂停自动跟随后，底部悬浮「回到最新」 -->
          <button
            v-if="!stickToBottom && messages.length"
            class="back-to-latest"
            @click="forceScrollBottom"
          >
            ↓ 回到最新
          </button>
        </div>

        <div
          v-if="!upgraded"
          class="conversation-composer"
        >
          <ChatInputBar
            v-model:capability="selectedCapability"
            appearance="conversation"
            placeholder="继续追问，或补充新的事实与材料"
            :disabled="sending || restoring"
            @send="handleSend"
          />
          <p>AI 生成内容仅供参考，重要事项建议由法务复核</p>
        </div>
        <div
          v-else
          class="handoff-state"
        >
          已转交法务 BP，处理进展会在本会话与“我的记录”中同步。
        </div>
        <ErrorState
          v-if="lastError"
          :message="lastError.payload.error"
          :request-id="lastError.payload.requestId"
        />
      </template>
    </div>
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'ConsultView' }</script>

<style scoped>
.consult-page {
  width: min(100%, 1540px);
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: clamp(22px, 4vh, 34px) 48px clamp(24px, 4vh, 38px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  color: #111827;
}

.consult-breadcrumb { margin: 0; color: #53627a; font-size: 13px; }
.consult-breadcrumb span { margin: 0 10px; color: #a8b1bf; }
.consult-welcome-header { min-height: 0; }
.consult-intro { display: grid; grid-template-columns: minmax(500px, 1.05fr) minmax(360px, .95fr); gap: clamp(36px, 5vw, 72px); margin-top: clamp(38px, 7vh, 86px); align-items: start; }
.consult-intro h1 { max-width: 720px; margin: 0; color: #0b1222; font-size: clamp(36px, 3vw, 50px); font-weight: 680; letter-spacing: -.05em; line-height: 1.08; white-space: nowrap; }
.consult-intro p { max-width: 520px; margin: 2px 0 0; color: #526174; font-size: clamp(14px, 1.05vw, 16px); line-height: 1.75; }
.suggestions-section { margin-top: clamp(24px, 4.5vh, 42px); }
.suggestions-heading { display: flex; margin-bottom: 12px; align-items: center; justify-content: space-between; }
.suggestions-heading h2 { margin: 0; color: #111827; font-size: 21px; font-weight: 680; letter-spacing: -.02em; }
.suggestions-heading button { display: inline-flex; padding: 8px 0; align-items: center; gap: 8px; border: 0; background: transparent; color: #0f5fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.suggestions-heading button:hover { color: #004dcc; }
.suggestions-heading svg { width: 18px; height: 18px; }
.suggestions-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 54px; }
.suggestion-item { display: flex; min-height: clamp(54px, 8vh, 70px); padding: 0 8px; align-items: center; justify-content: space-between; gap: 22px; border: 0; border-bottom: 1px solid #d7dee8; background: transparent; color: #0f5fff; font: inherit; font-size: clamp(14px, 1.05vw, 16px); font-weight: 580; text-align: left; cursor: pointer; transition: color 160ms ease, padding 160ms ease; }
.suggestion-item:hover { padding-right: 2px; padding-left: 14px; color: #004dcc; }
.suggestion-item svg { width: 21px; height: 21px; flex: 0 0 auto; }
.welcome-composer { margin-top: clamp(20px, 4vh, 38px); }
.welcome-composer > p,
.conversation-composer > p { margin: 12px 14px 0; color: #718096; font-size: 12px; }

.conversation-state { display: flex; padding-top: 18px; padding-bottom: 18px; flex-direction: column; overflow: hidden; }
.session-heading { display: flex; padding-bottom: 12px; align-items: flex-start; justify-content: space-between; gap: 28px; flex: 0 0 auto; }
.session-heading h1 { max-width: 780px; margin: 26px 0 8px; overflow: hidden; color: #0b1222; font-size: clamp(24px, 2.25vw, 34px); font-weight: 680; letter-spacing: -.035em; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
.session-heading > div > p:last-child { margin: 0; color: #718096; font-size: 13px; }
.new-session-button { display: inline-flex; min-width: 132px; height: 44px; margin-top: 28px; padding: 0 16px; align-items: center; justify-content: center; gap: 8px; border: 1px solid #2563eb; border-radius: 6px; background: #fff; color: #0f5fff; font: inherit; font-size: 14px; font-weight: 620; cursor: pointer; }
.new-session-button:hover:not(:disabled) { background: #f5f8ff; }
.new-session-button:disabled { opacity: .5; cursor: wait; }
.new-session-button svg { width: 18px; height: 18px; }
.msg-scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(71, 85, 105, .28) transparent; }
.msg-thread { display: flex; width: 100%; padding: 0 8px 24px 0; flex-direction: column; gap: 14px; }
.msg-row { display: flex; gap: 14px; }
.msg-row.out { width: fit-content; max-width: min(72%, 720px); margin-left: auto; }
.msg-row.in { width: 100%; }
.msg-avatar { display: grid; width: 34px; height: 34px; margin-top: 1px; border-radius: 6px; place-items: center; flex: 0 0 auto; background: #0f5fff; color: #fff; font-size: 12px; font-weight: 700; }
.msg-body { min-width: 0; width: 100%; }
.msg-bubble { color: #202b3c; font-size: 14px; line-height: 1.65; word-break: break-word; }
.msg-row.out .msg-bubble { padding: 12px 18px; border-radius: 8px 8px 2px 8px; background: #2f7df6; color: #fff; white-space: pre-wrap; }
.msg-row.in .msg-bubble { padding: 16px 18px 0; border: 1px solid #d5dde8; border-radius: 8px; background: #fff; }
.msg-row.in .msg-bubble :deep(.markstream-vue) { --ms-text-h1: 1.25rem; --ms-text-h2: 1.08rem; --ms-flow-paragraph-y: .45em; --ms-flow-list-item-y: .14em; --ms-flow-table-y: .8em; }
.evidence-status { display: flex; margin-bottom: 12px; align-items: center; gap: 6px; color: #16a05d; font-size: 12px; font-weight: 650; }
.research-sources { margin-top: 10px; overflow: hidden; border: 1px solid #dce3ec; border-radius: 6px; background: #fff; }
.research-sources summary { padding: 10px 12px; color: #243b5a; font-size: 12px; font-weight: 700; cursor: pointer; }
.source-row { display: grid; grid-template-columns: minmax(180px, 2fr) repeat(4, minmax(80px, 1fr)); gap: 10px; padding: 9px 12px; align-items: center; border-top: 1px solid #e8edf4; color: #5d6878; font-size: 11px; }
.source-row strong { color: #202b3c; font-size: 12px; }
.source-row a { color: #1d5fd1; }
.answer-actions { display: flex; min-height: 52px; margin: 14px -18px 0; padding: 8px 12px; align-items: center; gap: 6px; border-top: 1px solid #e4e9f0; }
.copy-answer,
.escalate-btn { display: inline-flex; height: 34px; padding: 0 10px; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 5px; background: transparent; color: #53627a; font: inherit; font-size: 12px; cursor: pointer; }
.copy-answer:hover { background: #f4f7fb; color: #2563eb; }
.copy-answer svg,
.escalate-btn svg { width: 16px; height: 16px; }
.answer-actions :deep(.download-wrap) { margin-top: 0; }
.answer-actions :deep(.dl-trigger) { height: 34px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: #53627a; }
.answer-actions :deep(.dl-trigger:hover) { background: #f4f7fb; color: #2563eb; }
.escalate-btn { width: auto; min-width: 148px; margin-top: 0; margin-left: auto; padding: 0 12px; align-self: center; border: 1px solid #2563eb; color: #0f5fff; font-weight: 620; }
.escalate-btn:hover:not(:disabled) { background: #f4f7ff; }
.escalate-btn:disabled { opacity: .55; cursor: wait; }
.msg-error { margin: 10px 0; padding: 8px 10px; border: 1px solid #fecaca; border-radius: 6px; background: #fff1f2; color: #be123c; font-size: 12px; }
.msg-event { align-self: center; padding: 6px 14px; border-radius: 5px; background: #eef2f7; color: #61708a; font-size: 11px; }
.event-actions { display: inline-flex; gap: 6px; margin-left: 8px; }
.event-actions button { padding: 4px 8px; border: 0; border-radius: 5px; background: #fff; color: #1d5fd1; font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; }
.thinking-panel { margin: -4px 0 0 48px; overflow: hidden; border: 1px solid #e1e7ef; border-radius: 7px; background: #f7f9fc; }
.thinking-toggle { display: block; width: 100%; padding: 8px 12px; border: 0; background: none; color: #607087; font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.thinking-body { max-height: 120px; padding: 0 12px 10px; overflow: hidden; color: #718096; font-size: 12px; line-height: 1.7; white-space: pre-wrap; mask-image: linear-gradient(to bottom, transparent 0, #000 22px); }
.back-to-latest { position: sticky; bottom: 8px; display: block; z-index: 10; margin: 0 auto; padding: 7px 14px; border: 1px solid #d7dfeb; border-radius: 18px; background: #fff; color: #2563eb; font: inherit; font-size: 12px; cursor: pointer; box-shadow: 0 5px 16px rgba(15, 23, 42, .08); }
.file-tags { display: flex; margin-top: 6px; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.file-tag { display: inline-flex; padding: 5px 9px; align-items: center; gap: 5px; border-radius: 5px; background: #edf4ff; font-size: 11px; }
.ft-icon { width: 14px; height: 14px; color: #2563eb; }
.ft-name { max-width: 180px; overflow: hidden; color: #2563eb; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.ft-size { color: #718096; }
.conversation-composer { flex: 0 0 auto; padding-top: 12px; }
.conversation-composer > p { text-align: center; }
.handoff-state { flex: 0 0 auto; margin-top: 12px; padding: 14px 18px; border: 1px solid #cfe0ff; border-radius: 7px; background: #f3f7ff; color: #315a9d; font-size: 13px; text-align: center; }

@media (max-width: 1180px) {
  .consult-page { padding-right: 32px; padding-left: 32px; }
  .consult-intro { grid-template-columns: 1fr; gap: 14px; margin-top: clamp(34px, 6vh, 64px); }
  .consult-intro h1 { white-space: normal; }
}

@media (max-width: 760px) {
  .consult-page { padding: 24px 18px 28px; }
  .consult-intro { margin-top: 54px; }
  .consult-intro h1 { font-size: 36px; }
  .consult-intro p br { display: none; }
  .suggestions-grid { grid-template-columns: 1fr; }
  .session-heading h1 { max-width: 420px; font-size: 25px; }
  .new-session-button { min-width: 44px; padding: 0 12px; font-size: 0; }
  .new-session-button svg { width: 20px; height: 20px; }
  .msg-row.out { max-width: 88%; }
  .source-row { grid-template-columns: 1fr; }
  .escalate-btn { min-width: 128px; }
}

@media (max-height: 760px) and (min-width: 761px) {
  .suggestions-heading { margin-bottom: 6px; }
  .suggestions-heading h2 { font-size: 18px; }
  .welcome-composer > p { margin-top: 7px; }
  .welcome-composer :deep(.appearance-welcome .composer-frame textarea) { min-height: 76px; padding-top: 16px; }
  .welcome-composer :deep(.composer-toolbar) { min-height: 56px; padding-bottom: 9px; }
  .welcome-composer :deep(.composer-submit.labeled) { height: 44px; }
}
</style>
