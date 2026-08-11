<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { request, RequestError } from '../../api/client'
import { requestStreamOrJson } from '../../api/sse'
import { useFileUpload } from '../../composables/useFileUpload'
import type { AttachedFile } from '../../composables/useFileUpload'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import ChatInputBar from '../../components/ChatInputBar.vue'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import ErrorState from '../../components/ErrorState.vue'
import type { Skill, ProjectDetail } from '../../types'
import { GENERAL_SKILL } from '../../types'

const auth = useAuthStore()
const { buildFullInput, buildDisplayText } = useFileUpload()

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

// 技能选择（2026-08-04 技能库模块）：默认兜底"通用法务咨询"（skillId=null 不注入）
// 交互（frontend-design 重设计）：欢迎页领域卡片选择（对话方向感），对话开始后不再显示
const usableSkills = ref<Skill[]>([])
const selectedSkill = ref<{ id?: string; name: string }>({ name: GENERAL_SKILL.name })
const skillsError = ref<RequestError | null>(null)
const lastError = ref<RequestError | null>(null)

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

const startNewSession = () => {
  sessionGen++
  clearSession()
  projectId.value = ''
  projectRoute.value = ''
  upgraded.value = false
  messages.value = []
  lastError.value = null
  scrollBottom()
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
    for (const m of data.messages) tl.push(m)
    for (const e of data.events) tl.push({ ...e, _event: true })
    tl.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    messages.value = tl
    scrollBottom()
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

const scrollBottom = () => nextTick(() => {
  const el = msgContainer.value
  if (el) el.scrollTop = el.scrollHeight
})

// 建议问题快捷入口
const suggestedQuestions = [
  '促销活动合规吗？',
  '客户要求修改合同付款条款',
  '数据出境需要什么审批流程',
  '劳动用工有哪些法律风险',
]

const sendSuggested = (q: string) => {
  handleSend(q, [])
}

const handleSend = async (text: string, files: AttachedFile[]) => {
  const fullInput = buildFullInput(text, files)
  const displayText = buildDisplayText(text, files)

  sending.value = true
  lastError.value = null
  messages.value.push({ role: 'user', text: displayText, _files: files })
  scrollBottom()

  if (!projectId.value) {
    try {
      // 建单含风险分类(glm-5-2 推理模型,约 6-15s),超时给到 90s 对齐后端
      const data = await request<{ id: string; route: string; risk?: string }>('/projects', {
        method: 'POST',
        timeoutMs: 90_000,
        body: {
          kind: 'consult',
          title: text.slice(0, 50) || '文件咨询',
          input: fullInput,
          // 技能（2026-08-04）：选中兜底"通用法务咨询"时 skillId=undefined → 后端不注入（工程评审决策 #2）
          skillId: selectedSkill.value.id || undefined,
        },
      })
      projectId.value = data.id; projectRoute.value = data.route
      saveSession()
      if (data.route === 'legalbp') {
        messages.value.push({ _event: true, text: '系统判定 ' + data.risk + ' 风险，已创建工单并通知法务 BP' })
        upgraded.value = true
      }
    } catch (error) {
      lastError.value = error instanceof RequestError
        ? error
        : new RequestError({ error: '服务异常，请稍后重试', code: 'UNKNOWN', statusCode: 0 })
      messages.value.push({ _event: true, text: lastError.value.payload.error })
      sending.value = false
      return
    }
  }

  if (projectRoute.value === 'llm' && !upgraded.value) {
    expectingAI.value = true
    aiThinking.value = ''
    showThinking.value = true
    try {
      let fullText = ''
      let aiMsg: any | undefined
      const data = await requestStreamOrJson<{ route?: string; done?: boolean; error?: boolean; text?: string; thinking?: string }>(`/projects/${projectId.value}/messages`, {
        method: 'POST',
        body: { text: fullInput, role: 'user' },
      }, (d) => {
        // 思考过程独立流（app-server 双路）：增量累积,不混入答案
        if (d.thinking) aiThinking.value += String(d.thinking)
        if (d.text || d.error) {
          aiMsg ??= { id: 'streaming', role: 'assistant', text: '' }
          if (messages.value[messages.value.length - 1] !== aiMsg) messages.value.push(aiMsg)
        }
        if (d.text) { fullText += String(d.text); aiMsg!.text = fullText; scrollBottom() }
        if (d.error) aiMsg!.text = '⚠️ AI 答复生成失败，已通知法务BP处理'
      })
      if (data?.route === 'legalbp') {
        messages.value.push({ _event: true, text: '追问触发风险升级，已通知法务 BP 人工处理' })
        upgraded.value = true; projectRoute.value = 'legalbp'
      }
    } catch (error) {
      lastError.value = error instanceof RequestError
        ? error
        : new RequestError({ error: '消息发送失败，请重试', code: 'UNKNOWN', statusCode: 0 })
      messages.value.push({ _event: true, text: lastError.value.payload.error })
    }
    expectingAI.value = false
  } else {
    messages.value.push({ _event: true, text: '已收到，法务 BP 处理后将回传至此处' })
  }
  sending.value = false
  scrollBottom()
}

const handleUpgrade = async () => {
  if (upgrading.value || !projectId.value) return
  upgrading.value = true
  lastError.value = null
  try {
    await request(`/projects/${projectId.value}/messages`, {
      method: 'POST',
      body: { text: '申请升级为人工处理', role: 'user' },
    })
    upgraded.value = true; projectRoute.value = 'legalbp'
    messages.value.push({ _event: true, text: '已申请升级人工处理，法务 BP 将尽快跟进' })
    scrollBottom()
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
    >
      <div
        v-if="expectingAI && aiThinking"
        class="thinking-panel"
      >
        <button
          class="thinking-toggle"
          @click="showThinking = !showThinking"
        >
          {{ showThinking ? '▾' : '▸' }} 思考过程
        </button>
        <div
          v-if="showThinking"
          class="thinking-body"
        >
          {{ aiThinking }}
        </div>
      </div>
      <div class="msg-thread">
        <template
          v-for="(m, i) in messages"
          :key="i"
        >
          <div
            v-if="m._event"
            class="msg-event"
          >
            {{ m.text }}
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
                <MarkdownContent
                  v-if="m.role === 'assistant'"
                  :text="m.text"
                  :streaming="m.id === 'streaming'"
                  :done="!expectingAI"
                />
                <template v-else>
                  {{ m.text }}
                </template>
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
                  <span class="ft-icon">📎</span><span class="ft-name">{{ f.name }}</span><span class="ft-size">{{ f.size }}</span>
                </span>
              </div>
              <div
                v-if="m.role === 'assistant'"
                class="ai-disclaimer"
              >
                AI 生成 · 仅供参考
              </div>
              <DownloadMenu
                v-if="m.role === 'assistant' && m.text"
                :content="m.text"
                :filename="'法律咨询答复'"
              />
              <button
                v-if="m.role === 'assistant' && projectId && projectRoute === 'llm' && !upgraded && i === messages.length - 1"
                class="escalate-btn"
                :disabled="upgrading"
                @click="handleUpgrade"
              >
                {{ upgrading ? '升级中…' : '↑ 升级人工处理' }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <ChatInputBar
      v-if="!upgraded"
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
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.chat-content { max-width: 860px; padding: 0; }
.msg-scroll { padding: 24px 32px 8px; }
.thinking-panel { margin: 0 0 14px; border: 1px solid rgba(0,113,227,0.14); background: rgba(0,113,227,0.04); border-radius: 12px; overflow: hidden; }
.thinking-toggle { display: block; width: 100%; text-align: left; font-size: 12px; font-weight: 600; color: var(--blue); background: none; border: none; padding: 8px 14px; cursor: pointer; }
.thinking-body { padding: 0 14px 12px; font-size: 12px; line-height: 1.7; color: var(--text-secondary); white-space: pre-wrap; }
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
