<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { getAccessToken, request } from '../../api/client'
import { useFileUpload } from '../../composables/useFileUpload'
import type { AttachedFile } from '../../composables/useFileUpload'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import ChatInputBar from '../../components/ChatInputBar.vue'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import type { Skill } from '../../types'
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

// 技能选择（2026-08-04 技能库模块）：默认兜底"通用法务咨询"（skillId=null 不注入）
// 交互（frontend-design 重设计）：欢迎页领域卡片选择（对话方向感），对话开始后不再显示
const usableSkills = ref<Skill[]>([])
const selectedSkill = ref<{ id?: string; name: string }>({ name: GENERAL_SKILL.name })

onMounted(async () => {
  try {
    usableSkills.value = await request<Skill[]>('/skills?scope=usable')
  } catch { usableSkills.value = [] }
})

const pickSkill = (s: { id?: string; name: string }) => {
  selectedSkill.value = s
}

// 技能组 → 图标（Apple SF 风格语义映射）
const GROUP_ICONS: Record<string, string> = {
  合规法务: '🛡️',
  合同与交易: '📄',
  劳动法务: '👥',
  争议法务: '⚖️',
  法律研究: '📚',
  知识运营: '🧠',
}
const groupIcon = (g: string) => GROUP_ICONS[g] || '✦'

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
  messages.value.push({ role: 'user', text: displayText, _files: files })
  scrollBottom()

  if (!projectId.value) {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({
          kind: 'consult',
          title: text.slice(0, 50) || '文件咨询',
          input: fullInput,
          // 技能（2026-08-04）：选中兜底"通用法务咨询"时 skillId=undefined → 后端不注入（工程评审决策 #2）
          skillId: selectedSkill.value.id || undefined,
        }),
      })
      const data = await res.json()
      projectId.value = data.id; projectRoute.value = data.route
      if (data.route === 'legalbp') {
        messages.value.push({ _event: true, text: '系统判定 ' + data.risk + ' 风险，已创建工单并通知法务 BP' })
        upgraded.value = true
      }
    } catch { messages.value.push({ _event: true, text: '服务异常，请稍后重试' }); sending.value = false; return }
  }

  if (projectRoute.value === 'llm' && !upgraded.value) {
    expectingAI.value = true
    try {
      const res = await fetch(`/api/projects/${projectId.value}/messages`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({ text: fullInput, role: 'user' }),
      })
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('text/event-stream')) {
        let fullText = ''
        const aiMsg: any = { role: 'assistant', text: '' }
        messages.value.push(aiMsg); scrollBottom()
        const reader = res.body?.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: false })
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (const line of decoder.decode(value, { stream: true }).split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                const d = JSON.parse(line.slice(6))
                if (d.done || d.error) break
                if (d.text) { fullText += d.text; aiMsg.text = fullText; scrollBottom() }
              } catch {}
            }
          }
        }
      } else {
        const d = await res.json()
        if (d.route === 'legalbp') {
          messages.value.push({ _event: true, text: '追问触发风险升级，已通知法务 BP 人工处理' })
          upgraded.value = true; projectRoute.value = 'legalbp'
        }
      }
    } catch { messages.value.push({ _event: true, text: '消息发送失败，请重试' }) }
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
  try {
    await fetch(`/api/projects/${projectId.value}/messages`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` },
      body: JSON.stringify({ text: '申请升级为人工处理', role: 'user' }),
    })
    upgraded.value = true; projectRoute.value = 'legalbp'
    messages.value.push({ _event: true, text: '已申请升级人工处理，法务 BP 将尽快跟进' })
    scrollBottom()
  } catch {}
  upgrading.value = false
}

</script>

<template>
  <BusinessSidebarLayout active-key="consult" content-class="chat-content">
    <template #topbar>
      <div class="tb-left">
        <small class="tb-path">Business OS</small>
        <strong class="tb-title">法律咨询</strong>
      </div>
      <!-- 2026-08-05：无信息量的"在线"徽章已删除；仅保留真实状态 -->
      <span v-if="expectingAI" class="tb-badge thinking">AI 思考中…</span>
      <span v-else-if="upgraded" class="tb-badge escalated">已升级人工</span>
    </template>
        <div v-if="messages.length === 0 && !expectingAI" class="welcome-hero">
          <div class="welcome-icon">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1E3A8A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>
          </div>
          <h2 class="text-h2">业务法律咨询</h2>
          <p class="text-body" style="max-width:420px">用自然语言描述您的法律问题<br/>常规问题 AI 将在 1 分钟内答复<br/>高风险问题将自动升级法务 BP</p>

          <!-- 咨询领域选择（2026-08-04 技能库模块）：对话方向感，点选即锁定 -->
          <div class="domain-group">
            <span class="domain-label">选择咨询领域</span>
            <div class="domain-cards">
              <button class="domain-card" :class="{ active: !selectedSkill.id }" @click="pickSkill({ name: GENERAL_SKILL.name })">
                <span class="dc-ico">✦</span>
                <span class="dc-name">{{ GENERAL_SKILL.name }}</span>
                <span v-if="!selectedSkill.id" class="dc-check">✓</span>
              </button>
              <button v-for="s in usableSkills" :key="s.id" class="domain-card" :class="{ active: selectedSkill.id === s.id }" @click="pickSkill({ id: s.id, name: s.name })">
                <span class="dc-ico">{{ groupIcon(s.group) }}</span>
                <span class="dc-name">{{ s.name }}</span>
                <span v-if="selectedSkill.id === s.id" class="dc-check">✓</span>
              </button>
            </div>
          </div>

          <div class="suggest-grid">
            <button v-for="q in suggestedQuestions" :key="q" class="suggest-chip" @click="sendSuggested(q)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              {{ q }}
            </button>
          </div>
        </div>

        <div ref="msgContainer" class="msg-scroll">
          <div class="msg-thread">
            <template v-for="(m, i) in messages" :key="i">
              <div v-if="m._event" class="msg-event">{{ m.text }}</div>
              <div v-else :class="['msg-row', m.role === 'user' ? 'out' : 'in']">
                <div :class="['msg-avatar', m.role === 'user' ? 'user' : 'ai']">
                  {{ m.role === 'user' ? (auth.user?.displayName?.[0] || 'U') : 'AI' }}
                </div>
                <div class="msg-body">
                  <div class="msg-bubble">
                    <MarkdownContent v-if="m.role === 'assistant'" :text="m.text" :streaming="m.id === 'streaming'" :done="!expectingAI" />
                    <template v-else>{{ m.text }}</template>
                  </div>
                  <div v-if="m._files?.length" class="file-tags">
                    <span v-for="f in m._files" :key="f.id" class="file-tag">
                      <span class="ft-icon">📎</span><span class="ft-name">{{ f.name }}</span><span class="ft-size">{{ f.size }}</span>
                    </span>
                  </div>
                  <div v-if="m.role === 'assistant'" class="ai-disclaimer">AI 生成 · 仅供参考</div>
                  <DownloadMenu v-if="m.role === 'assistant' && m.text" :content="m.text" :filename="'法律咨询答复'" />
                  <button v-if="m.role === 'assistant' && projectId && projectRoute === 'llm' && !upgraded && i === messages.length - 1"
                    class="escalate-btn" @click="handleUpgrade" :disabled="upgrading"
                  >{{ upgrading ? '升级中…' : '↑ 升级人工处理' }}</button>
                </div>
              </div>
            </template>
          </div>
        </div>

        <ChatInputBar v-if="!upgraded" :disabled="sending" @send="handleSend" />
  </BusinessSidebarLayout>
</template>

/* ── 咨询领域选择（2026-08-04 技能库模块，frontend-design 重设计） ──
   欢迎页内容卡片（对话方向感）：有内容而非控件，对话开始后不出现 */
.domain-group { margin-top: 30px; max-width: 480px; text-align: left; animation: domain-in 0.5s var(--spring) 0.15s backwards; }
@keyframes domain-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.domain-label {
  display: block; font-size: 11px; color: var(--text-tertiary);
  font-weight: 590; letter-spacing: 0.03em; margin-bottom: 10px;
  text-transform: uppercase;
}
.domain-cards { display: flex; flex-wrap: wrap; gap: 8px; }
.domain-card {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 14px 9px 11px; border-radius: 14px;
  background: rgba(255,255,255,0.72); border: 1px solid rgba(0,0,0,0.08);
  backdrop-filter: blur(12px);
  font-family: inherit; font-size: 12.5px; color: var(--text); font-weight: 550;
  cursor: pointer; transition: all 0.25s var(--spring);
}
.domain-card:hover {
  transform: translateY(-1px);
  border-color: rgba(0,113,227,0.3);
  box-shadow: 0 4px 16px rgba(0,0,0,0.07);
}
.domain-card.active {
  border-color: var(--blue);
  background: rgba(0,113,227,0.08);
  color: var(--blue);
  box-shadow: 0 2px 12px rgba(0,113,227,0.16);
}
.dc-ico { font-size: 13px; line-height: 1; }
.dc-name { line-height: 1.1; }
.dc-check { margin-left: 1px; font-size: 11px; font-weight: 700; }

<script lang="ts">export default { name: 'ConsultView' }</script>

<style scoped>
.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.tb-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 10px; }
.tb-badge.thinking { background: rgba(0,113,227,0.08); color: var(--blue); animation: pulse 2s infinite; }
.tb-badge.escalated { background: rgba(255,149,0,0.08); color: #FF9500; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.chat-content { max-width: 860px; padding: 0; }
.msg-scroll { padding: 24px 32px 8px; }
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
</style>
