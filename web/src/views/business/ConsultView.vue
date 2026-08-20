<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '../../stores/auth'
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
import type { Skill, ProjectDetail } from '../../types'
import { GENERAL_SKILL } from '../../types'

const auth = useAuthStore()
const { buildFullInput, buildDisplayText, formatSize } = useFileUpload()

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

// 技能选择（2026-08-04 技能库模块）：默认兜底"通用法务咨询"（skillId=null 不注入）
// 交互（frontend-design 重设计）：欢迎页领域卡片选择（对话方向感），对话开始后不再显示
const usableSkills = ref<Skill[]>([])
const selectedSkill = ref<{ id?: string; name: string }>({ name: GENERAL_SKILL.name })
const skillsError = ref<RequestError | null>(null)
const lastError = ref<RequestError | null>(null)
type ConsultationCapability = 'general' | 'law_search' | 'similar_case'
const selectedCapability = ref<ConsultationCapability>('general')
const lastSubmission = ref<{ text: string; files: AttachedFile[]; capability: ConsultationCapability } | null>(null)

const loadSkills = async () => {
  try {
    usableSkills.value = await request<Skill[]>('/skills?scope=usable')
    skillsError.value = null
  } catch (error) {
    skillsError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '咨询领域加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

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

onMounted(() => {
  loadSkills()
  restoreSession()
})
onUnmounted(abortActiveRequest) // 离开页面中止在途请求

const pickSkill = (s: { id?: string; name: string }) => {
  selectedSkill.value = s
}

// 技能组 → 图标（Apple SF 风格语义映射）
const GROUP_ICONS: Record<string, string> = {
  合规法务: '规',
  合同与交易: '约',
  劳动法务: '人',
  争议法务: '争',
  法律研究: '研',
  知识运营: '知',
}
const groupIcon = (g: string) => GROUP_ICONS[g] || '法'

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

// 建议问题快捷入口
const suggestedQuestions = [
  '促销活动合规吗？',
  '客户要求修改合同付款条款',
  '数据出境需要什么审批流程',
  '劳动用工有哪些法律风险',
]

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
          // 技能（2026-08-04）：选中兜底"通用法务咨询"时 skillId=undefined → 后端不注入（工程评审决策 #2）
          skillId: selectedSkill.value.id || undefined,
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

</script>

<template>
  <BusinessSidebarLayout
    active-key="consult"
    content-class="chat-content"
  >
    <template #topbar>
      <div class="tb-left">
        <small class="tb-path">Business OS</small>
        <strong class="tb-title">法律咨询</strong>
      </div>
      <!-- 2026-08-05：无信息量的"在线"徽章已删除；仅保留真实状态 -->
      <span
        v-if="expectingAI"
        class="tb-badge thinking"
      >AI 思考中…</span>
      <span
        v-else-if="upgraded"
        class="tb-badge escalated"
      >已升级人工</span>
      <button
        v-if="projectId"
        class="tb-new-btn"
        :disabled="sending || expectingAI"
        @click="startNewSession"
      >
        ＋ 新建会话
      </button>
    </template>
    <!-- 多轮上下文轻提示（2026-08-12）：会话内追问参考此前问答，新建会话才重新开始 -->
    <div
      v-if="projectId && messages.length > 0"
      class="ctx-tip"
    >
      本会话内的后续问题会参考此前问答；新建会话后上下文将重新开始。
    </div>
    <div
      v-if="messages.length === 0 && !expectingAI"
      class="welcome-hero"
    >
      <div class="welcome-icon">
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1E3A8A"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
      </div>
      <h2 class="text-h2">
        业务法律咨询
      </h2>
      <p
        class="text-body"
        style="max-width:420px"
      >
        用自然语言描述您的法律问题<br>常规问题 AI 将在 1 分钟内答复<br>高风险问题将自动升级法务 BP
      </p>

      <!-- 咨询领域选择（2026-08-04 技能库模块）：对话方向感，点选即锁定 -->
      <div class="domain-group">
        <span class="domain-label">选择咨询领域</span>
        <div class="domain-cards">
          <button
            class="domain-card"
            :class="{ active: !selectedSkill.id }"
            @click="pickSkill({ name: GENERAL_SKILL.name })"
          >
            <span class="dc-ico">法</span>
            <span class="dc-name">{{ GENERAL_SKILL.name }}</span>
            <span
              v-if="!selectedSkill.id"
              class="dc-check"
            >✓</span>
          </button>
          <button
            v-for="s in usableSkills"
            :key="s.id"
            class="domain-card"
            :class="{ active: selectedSkill.id === s.id }"
            @click="pickSkill({ id: s.id, name: s.name })"
          >
            <span class="dc-ico">{{ groupIcon(s.group) }}</span>
            <span class="dc-name">{{ s.name }}</span>
            <span
              v-if="selectedSkill.id === s.id"
              class="dc-check"
            >✓</span>
          </button>
        </div>
      </div>

      <div class="suggest-grid">
        <button
          v-for="q in suggestedQuestions"
          :key="q"
          class="suggest-chip"
          @click="sendSuggested(q)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
          {{ q }}
        </button>
      </div>
    </div>

    <ErrorState
      v-if="skillsError"
      :message="skillsError.payload.error"
      :request-id="skillsError.payload.requestId"
      :on-retry="loadSkills"
    />

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
            <div :class="['msg-avatar', m.role === 'user' ? 'user' : 'ai']">
              {{ m.role === 'user' ? (auth.user?.displayName?.[0] || 'U') : 'AI' }}
            </div>
            <div class="msg-body">
              <div class="msg-bubble">
                <div
                  v-if="m.role === 'assistant' && m.research"
                  class="evidence-status"
                >
                  <span>✓ {{ m.research.trace.status === 'success_hit' ? '已完成来源检索' : '未检索到可核验来源' }}</span>
                  <span>· {{ m.research.trace.limitations?.[0] }}</span>
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
              </div>
              <details
                v-if="m.role === 'assistant' && m.research?.trace?.calls?.some((c: any) => c.records?.length)"
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
                v-if="m._files?.length"
                class="file-tags"
              >
                <span
                  v-for="f in m._files"
                  :key="f.id"
                  class="file-tag"
                >
                  <span class="ft-icon">📎</span><span class="ft-name">{{ f.name }}</span><span class="ft-size">{{ formatSize(f.size) }}</span>
                </span>
              </div>
              <div
                v-if="m.role === 'assistant' && m.status === 'completed' && m.text"
                class="ai-disclaimer"
              >
                AI 生成 · 仅供参考
              </div>
              <DownloadMenu
                v-if="m.role === 'assistant' && m.status === 'completed' && m.text"
                :content="m.text"
                :filename="'法律咨询答复'"
              />
              <button
                v-if="m.role === 'assistant' && m.status === 'completed' && projectId && projectRoute === 'llm' && !upgraded && m === messages[messages.length - 1]"
                class="escalate-btn"
                :disabled="upgrading"
                @click="handleUpgrade"
              >
                {{ upgrading ? '升级中…' : '↑ 升级人工处理' }}
              </button>
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

    <ChatInputBar
      v-if="!upgraded"
      v-model:capability="selectedCapability"
      :disabled="sending || restoring"
      @send="handleSend"
    />
    <ErrorState
      v-if="lastError"
      :message="lastError.payload.error"
      :request-id="lastError.payload.requestId"
    />
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'ConsultView' }</script>

<style scoped>
.event-actions { display: inline-flex; gap: 6px; margin-left: 8px; }.event-actions button { border: 0; border-radius: 7px; background: #eef4ff; color: #1e3a8a; padding: 4px 8px; font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; }
.evidence-status { display: flex; flex-wrap: wrap; gap: 5px; margin: -2px 0 12px; padding: 8px 10px; border: 1px solid #d8e5f8; border-radius: 9px; background: #f4f8ff; color: #35506f; font-size: 11px; line-height: 1.45; }
.research-sources { margin-top: 8px; border: 1px solid rgba(30,58,138,.12); border-radius: 12px; background: rgba(255,255,255,.94); overflow: hidden; }
.research-sources summary { padding: 10px 12px; color: #243b5a; font-size: 12px; font-weight: 700; cursor: pointer; }
.source-row { display: grid; grid-template-columns: minmax(180px,2fr) repeat(4,minmax(80px,1fr)); gap: 10px; align-items: center; padding: 10px 12px; border-top: 1px solid #e8edf4; color: #5d6878; font-size: 11px; }
.source-row strong { color: #202b3c; font-size: 12px; }
.source-row a { color: #1d5fd1; }
@media (max-width: 1023px) { .source-row { grid-template-columns: 1fr; } }
.domain-group {
  width: min(620px, 100%);
  margin-top: 26px;
  text-align: left;
  animation: domain-in 0.5s var(--spring) 0.15s backwards;
}
@keyframes domain-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.domain-label {
  display: block;
  margin: 0 0 10px 2px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
}
.domain-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.domain-card {
  position: relative;
  display: flex;
  min-height: 78px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 12px 12px;
  border: 1px solid rgba(30, 58, 138, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.58);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: transform 0.25s var(--spring), border-color 0.25s var(--spring), background 0.25s var(--spring), box-shadow 0.25s var(--spring);
}
.domain-card::after {
  content: "";
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(30, 58, 138, 0.14);
}
.domain-card:hover {
  transform: translateY(-2px);
  border-color: rgba(30, 58, 138, 0.30);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 8px 20px rgba(30, 58, 138, 0.08);
}
.domain-card.active {
  border-color: #1e3a8a;
  background: linear-gradient(145deg, rgba(239, 245, 255, 0.96), rgba(228, 237, 255, 0.78));
  color: #1e3a8a;
  box-shadow: 0 7px 18px rgba(30, 58, 138, 0.12);
}
.domain-card.active::after {
  background: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.10);
}
.dc-ico {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid rgba(30, 58, 138, 0.12);
  border-radius: 9px;
  background: rgba(30, 58, 138, 0.06);
  color: #1e3a8a;
  font-size: 12px;
  font-weight: 750;
  line-height: 1;
}
.domain-card.active .dc-ico {
  border-color: rgba(30, 58, 138, 0.18);
  background: #1e3a8a;
  color: #fff;
}
.dc-name { max-width: calc(100% - 4px); line-height: 1.2; }
.dc-check {
  position: absolute;
  top: 12px;
  right: 11px;
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border-radius: 50%;
  background: #1e3a8a;
  color: #fff;
  font-size: 10px;
  font-weight: 750;
}

.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.tb-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 10px; }
.tb-badge.thinking { background: rgba(0,113,227,0.08); color: var(--blue); animation: pulse 2s infinite; }
.tb-badge.escalated { background: rgba(255,149,0,0.08); color: #FF9500; }
.tb-new-btn { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--blue); background: rgba(0,113,227,0.08); border: none; padding: 5px 12px; border-radius: 999px; cursor: pointer; }
.tb-new-btn:hover { background: rgba(0,113,227,0.15); }
/* 多轮上下文轻提示（2026-08-12） */
.ctx-tip { font-size: 11px; color: var(--text-tertiary); padding: 6px 16px 0; text-align: center; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
/* 布局由 apple.css .chat-content/.msg-scroll 全局管理（scoped 收不到 BusinessSidebarLayout 容器） */
.thinking-panel { margin: 2px 0 12px 52px; border: 1px solid rgba(15,23,42,0.08); background: rgba(100,116,139,0.06); border-radius: 12px; overflow: hidden; }
.thinking-toggle { display: block; width: 100%; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-secondary); background: none; border: none; padding: 8px 14px; cursor: pointer; }
.thinking-body { padding: 0 14px 12px; font-size: 12px; line-height: 1.7; color: var(--text-secondary); white-space: pre-wrap; max-height: 132px; overflow: hidden; mask-image: linear-gradient(to bottom, transparent 0, #000 26px); -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26px); }
/* P1-3：用户向上滚暂停跟随后的「回到最新」悬浮按钮 */
.back-to-latest { position: sticky; bottom: 12px; display: block; margin: 0 auto 8px; font-size: 12px; font-weight: 600; color: var(--blue); background: #fff; border: 1px solid rgba(15,23,42,0.1); border-radius: 999px; padding: 6px 14px; box-shadow: 0 4px 16px rgba(15,23,42,0.1); cursor: pointer; z-index: 10; }
.ai-disclaimer { margin-top: 4px; font-size: 10px; color: var(--text-tertiary); padding-left: 4px; }
.file-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.file-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 8px; background: rgba(0,113,227,0.06); font-size: 11px; }
.ft-icon { font-size: 12px; }
.ft-name { color: var(--blue); font-weight: 550; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft-size { color: var(--text-tertiary); }

/* ── 建议问题快捷卡 ── */
.suggest-grid {
  display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  margin-top: 30px; max-width: 480px;
}
.suggest-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 10px 18px; border: 1px solid rgba(30,58,138,0.15);
  border-radius: 18px; background: rgba(255,255,255,0.7);
  backdrop-filter: blur(10px);
  font-family: inherit; font-size: 13px; color: #1E3A8A; font-weight: 550;
  cursor: pointer; transition: all 0.25s var(--spring);
}
.suggest-chip:hover {
  background: #1E3A8A; color: #fff;
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(30,58,138,0.25);
}

@media (max-width: 620px) {
  .domain-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
