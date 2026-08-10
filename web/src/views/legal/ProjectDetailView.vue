<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError, request, requestForm } from '../../api/client'
import { requestStreamOrJson } from '../../api/sse'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import type { ContractDocStyle } from '../../utils/markdown-to-docx'
import type { ContractFile, ContractTemplate, ProjectDetail, MessageDto, EventDto } from '../../types'
import ErrorState from '../../components/ErrorState.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const project = ref<ProjectDetail | null>(null)
const messages = ref<(MessageDto | (EventDto & { _event: true }))[]>([])
const templateStyle = ref<ContractDocStyle | undefined>()
const input = ref('')
const sending = ref(false)
const streaming = ref('')
const loading = ref(true)
const loadError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const id = route.params.id as string
const contractFiles = ref<ContractFile[]>([])
const uploadingFinal = ref(false)
const finalInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  try {
    const data = await request<ProjectDetail>(`/projects/${id}`)
    project.value = data
    mergeTimeline(data)
    if (data.kind === 'contract') {
      loadFiles()
      // 合同工单：加载对应模板样式供下载（与模板格式一致）
      if (data.contractTemplateSlug) {
        try {
          const templates = await request<ContractTemplate[]>('/contract-templates')
          templateStyle.value = templates.find(t => t.slug === data.contractTemplateSlug)?.style
        } catch (error) {
          actionError.value = error instanceof RequestError
            ? error
            : new RequestError({ error: '合同模板样式加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
        }
      }
    }
  } catch (error) {
    loadError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '工单加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally { loading.value = false }
})

const mergeTimeline = (data: ProjectDetail) => {
  const tl: any[] = []
  for (const m of data.messages) tl.push(m)
  for (const e of data.events) tl.push({ ...e, _event: true })
  tl.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  messages.value = tl
}

const scrollBottom = () => nextTick(() => {
  const el = document.getElementById('msg-container')
  if (el) el.scrollTop = el.scrollHeight
})

const sendMessage = async () => {
  if (!input.value.trim() || sending.value) return
  const text = input.value.trim()
  input.value = ''
  sending.value = true
  actionError.value = null

  messages.value.push({ id: 'tmp-' + Date.now(), role: 'user', text, createdAt: new Date().toISOString() } as any)
  scrollBottom()

  try {
    streaming.value = ''
    let aiMsg: any | undefined
    const data = await requestStreamOrJson<{ route?: string; done?: boolean; error?: boolean; text?: string }>(`/projects/${id}/messages`, {
      method: 'POST',
      body: { text, role: 'user' },
    }, (d) => {
      if (d.done === true) void refreshMessages()
      if (d.error === true || typeof d.text === 'string') {
        aiMsg ??= { id: 'streaming', role: 'assistant', text: '', createdAt: new Date().toISOString() }
        if (messages.value[messages.value.length - 1] !== aiMsg) messages.value.push(aiMsg)
      }
      if (d.error === true) aiMsg!.text = '⚠️ AI 答复生成失败，已通知法务BP处理'
      else if (typeof d.text === 'string') { streaming.value += d.text; aiMsg!.text = streaming.value; scrollBottom() }
    })
    if (data?.route === 'legalbp') {
      messages.value.push({ id: 'ev-' + Date.now(), _event: true, text: '风险升级，已通知法务 BP 人工处理', createdAt: new Date().toISOString() } as any)
      scrollBottom()
    }
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '消息发送失败，请重试', code: 'UNKNOWN', statusCode: 0 })
    messages.value.push({ id: 'err-' + Date.now(), _event: true, text: '消息发送失败，请重试', createdAt: new Date().toISOString() } as any)
  } finally { sending.value = false; streaming.value = '' }
}

const refreshMessages = async () => {
  try {
    const data = await request<ProjectDetail>(`/projects/${id}`)
    project.value = data
    mergeTimeline(data)
    scrollBottom()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '工单刷新失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const canReply = () => project.value?.route === 'legalbp' && project.value?.status !== '已回传' && project.value?.status !== '已取消'

// ── 合同附件 ──
const canUploadFinal = computed(() =>
  project.value?.kind === 'contract' && project.value?.route === 'legalbp' &&
  project.value?.status !== '已回传' && project.value?.status !== '已取消'
)

const loadFiles = async () => {
  try {
    contractFiles.value = await request<ContractFile[]>(`/projects/${id}/files`)
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '附件加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const triggerFinalUpload = () => finalInput.value?.click()

const handleFinalUpload = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  uploadingFinal.value = true
  actionError.value = null
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', 'final')
    await requestForm(`/projects/${id}/files`, fd, { method: 'POST' })
    await loadFiles()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '定稿上传失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
  uploadingFinal.value = false
}

const downloadFile = (f: ContractFile) => {
  window.open(`/api/projects/${id}/files/${f.id}`, '_blank')
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const reply = async () => {
  if (!input.value.trim()) return
  const text = input.value.trim()
  input.value = ''
  try {
    await request(`/projects/${id}/reply`, { method: 'POST', body: { text } })
    await refreshMessages()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '回传失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const goBack = () => router.push('/legal/projects')

const avatarLabel = (role: string) => ({ user: auth.user?.displayName?.[0] || 'U', assistant: 'AI', legal: '法' })[role] || '?'
const authorLabel = (role: string) => ({ user: '业务人员', assistant: 'AI 助手', legal: '法务 BP' })[role] || role
const timeFmt = (ts: string) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }

async function handleLogout() { await auth.logout(); await router.replace('/login') }
</script>

<template>
  <div class="app-shell">
    <div class="aurora">
      <div class="orb orb-1" /><div class="orb orb-2" /><div class="orb orb-3" />
    </div>

    <aside class="app-sidebar sidebar-glass">
      <button
        class="app-brand"
        @click="router.push('/legal/projects')"
      >
        <span class="brand-icon">⚖</span>
        <span class="brand-text"><b>法务 Legal OS</b><small>法律团队项目空间</small></span>
      </button>
      <div class="nav-section">
        <span class="nav-label">项目</span>
        <button
          class="nav-btn active"
          @click="goBack"
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect
            x="9"
            y="3"
            width="6"
            height="4"
            rx="1"
          /><path d="M9 12h6M9 16h4" /></svg></span>
          工单管理
        </button>
        <button
          class="nav-btn"
          disabled
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><circle
            cx="11"
            cy="11"
            r="8"
          /><line
            x1="21"
            y1="21"
            x2="16.65"
            y2="16.65"
          /></svg></span>
          法规检索
        </button>
        <button
          class="nav-btn"
          disabled
        >
          <span class="nav-ico"><svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          ><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg></span>
          技能库
        </button>
      </div>
      <div class="sidebar-footer">
        <div class="user-avatar">
          {{ auth.user?.displayName?.[0] || '法' }}
        </div>
        <div class="user-info">
          <span class="user-name">{{ auth.user?.displayName || '用户' }}</span>
          <span class="user-role">{{ auth.user?.role === 'legal_lead' ? '法务负责人' : '法务 BP' }}</span>
        </div>
        <button
          class="logout-link"
          title="退出登录"
          @click="handleLogout"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line
            x1="21"
            y1="12"
            x2="9"
            y2="12"
          /></svg>
        </button>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar topbar-glass">
        <div class="tb-left">
          <button
            class="back-link"
            @click="goBack"
          >
            ← 工单管理
          </button>
          <template v-if="project">
            <span class="sep">/</span>
            <strong class="tb-title">{{ project.title }}</strong>
            <span
              v-if="project.skillName"
              class="skill-chip"
            >{{ project.skillName }}</span>
            <span :class="['risk-chip', 'risk-' + project.risk + '-bg']">{{ project.risk }}</span>
            <span :class="['status-chip', 'status-' + project.status]">{{ project.status }}</span>
          </template>
        </div>
        <span
          v-if="loading"
          class="tb-muted"
        >加载中…</span>
      </header>

      <div
        v-if="!loading && !loadError"
        class="app-content chat-content animate-in"
      >
        <ErrorState
          v-if="actionError"
          :message="actionError.payload.error"
          :request-id="actionError.payload.requestId"
        />
        <div
          id="msg-container"
          class="msg-scroll"
        >
          <div class="msg-thread">
            <template
              v-for="m in messages"
              :key="m.id"
            >
              <!-- event -->
              <div
                v-if="(m as any)._event"
                class="msg-event"
              >
                {{ (m as EventDto).text }}
              </div>
              <!-- message -->
              <div
                v-else
                :class="['msg-row', (m as MessageDto).role === 'user' ? 'out' : 'in', (m as MessageDto).role === 'legal' ? 'legal' : '']"
              >
                <div :class="['msg-avatar', (m as MessageDto).role]">
                  {{ avatarLabel((m as MessageDto).role) }}
                </div>
                <div class="msg-body">
                  <div class="msg-meta">
                    <span class="msg-author">{{ authorLabel((m as MessageDto).role) }}</span>
                    <span class="msg-time">{{ timeFmt((m as MessageDto).createdAt) }}</span>
                  </div>
                  <div class="msg-bubble">
                    <MarkdownContent
                      v-if="(m as MessageDto).role === 'assistant' || (m as MessageDto).role === 'legal'"
                      :text="(m as MessageDto).text"
                    />
                    <template v-else>
                      {{ (m as MessageDto).text }}
                    </template>
                  </div>
                  <div
                    v-if="(m as MessageDto).role === 'assistant' || (m as MessageDto).role === 'legal'"
                    class="ai-disclaimer"
                  >
                    AI 生成 · 仅供参考
                  </div>
                  <DownloadMenu
                    v-if="((m as MessageDto).role === 'assistant' || (m as MessageDto).role === 'legal') && (m as MessageDto).text"
                    :content="(m as MessageDto).text"
                    :filename="'法律咨询答复'"
                    :docx-style="templateStyle"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 合同附件 -->
        <div
          v-if="project && project.kind === 'contract'"
          class="attach-panel"
        >
          <div class="attach-head">
            <span class="attach-title">📎 合同附件</span>
            <button
              v-if="canUploadFinal"
              class="attach-upload-btn"
              :disabled="uploadingFinal"
              @click="triggerFinalUpload"
            >
              {{ uploadingFinal ? '上传中…' : '上传定稿' }}
            </button>
            <input
              ref="finalInput"
              type="file"
              class="attach-file-input"
              accept=".docx,.doc,.pdf,.md,.txt"
              @change="handleFinalUpload"
            >
          </div>
          <div
            v-if="contractFiles.length"
            class="attach-list"
          >
            <button
              v-for="f in contractFiles"
              :key="f.id"
              class="attach-item"
              @click="downloadFile(f)"
            >
              <span class="att-icon">📄</span>
              <span class="att-name">{{ f.originalName }}</span>
              <span :class="['att-kind', 'att-kind-' + f.kind]">{{ f.kind === 'final' ? '定稿' : '修订版' }}</span>
              <span class="att-size">{{ formatSize(f.size) }}</span>
              <span class="att-uploader">{{ f.uploader?.displayName || '' }}</span>
            </button>
          </div>
          <div
            v-else
            class="attach-empty"
          >
            暂无合同附件
          </div>
        </div>

        <div
          v-if="project && project.status !== '已取消'"
          class="chat-input-bar"
        >
          <textarea
            v-model="input"
            :placeholder="canReply() ? '输入回传意见…' : '输入消息…'"
            rows="1"
            @keydown.enter.exact.prevent="canReply() ? reply() : sendMessage()"
          />
          <button
            v-if="canReply()"
            class="reply-btn"
            :disabled="!input.trim() || sending"
            @click="reply"
          >
            回传
          </button>
          <button
            v-else
            class="chat-send-btn"
            :disabled="!input.trim() || sending"
            @click="sendMessage"
          >
            ↑
          </button>
        </div>
      </div>

      <ErrorState
        v-else-if="loadError"
        :message="loadError.payload.error"
        :request-id="loadError.payload.requestId"
        :on-retry="() => router.go(0)"
      />
      <div
        v-else
        class="welcome-hero"
      >
        <div class="welcome-icon">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#86868b"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><circle
            cx="12"
            cy="12"
            r="9"
          /><path d="M12 7v5l3 3" /></svg>
        </div>
        <h2 class="text-h2">
          加载中…
        </h2>
      </div>
    </div>
  </div>
</template>

<script lang="ts">export default { name: 'ProjectDetailView' }</script>

<style scoped>
.tb-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.back-link { background: none; border: none; font-size: 13px; color: var(--blue); cursor: pointer; font-weight: 500; }
.sep { color: var(--text-tertiary); font-size: 13px; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-muted { font-size: 11px; color: var(--text-tertiary); }

.chat-content { display: flex; flex-direction: column; height: calc(100vh - 56px); max-width: 960px; padding: 0; }
.msg-scroll { flex: 1; overflow-y: auto; padding: 24px 32px 8px; }
.ai-disclaimer { margin-top: 4px; font-size: 10px; color: var(--text-tertiary); padding-left: 4px; }

/* ── 消息作者标签 ── */
.msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.msg-author { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
.msg-row.out .msg-meta { justify-content: flex-end; }
.msg-row.out .msg-author { color: var(--blue); }
.msg-row.in.legal .msg-author { color: #0E7A3C; }
.msg-row.in .msg-meta .msg-author:not(:first-child) { margin-left: 8px; }

.reply-btn {
  padding: 10px 22px; border: none; border-radius: 22px;
  background: #34C759; color: #fff; font-family: inherit;
  font-size: 14px; font-weight: 650; cursor: pointer;
  transition: all 0.3s var(--spring);
}
.reply-btn:hover:not(:disabled) { transform: scale(1.04); }
.reply-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* ── 合同附件 ── */
.attach-panel {
  padding: 12px 24px 16px;
  background: rgba(255,255,255,0.72);
  backdrop-filter: blur(20px);
  border-top: 1px solid rgba(0,0,0,0.05);
  max-height: 220px; overflow-y: auto;
}
.attach-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.attach-title { font-size: 12px; font-weight: 650; color: var(--text-secondary); }
.attach-upload-btn {
  padding: 5px 14px; border: none; border-radius: 14px;
  background: #1E3A8A; color: #fff; font-family: inherit;
  font-size: 11px; font-weight: 600; cursor: pointer;
  transition: all 0.3s var(--spring);
}
.attach-upload-btn:hover:not(:disabled) { background: #1E40AF; }
.attach-upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.attach-file-input { display: none; }
.attach-list { display: flex; flex-direction: column; gap: 6px; }
.attach-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border: none; border-radius: 10px;
  background: rgba(0,0,0,0.02); font-family: inherit;
  cursor: pointer; text-align: left; transition: all 0.2s;
  font-size: 12px;
}
.attach-item:hover { background: rgba(0,113,227,0.06); }
.att-icon { font-size: 14px; flex-shrink: 0; }
.att-name {
  font-weight: 600; color: var(--text); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.att-kind { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 8px; flex-shrink: 0; }
.att-kind-revised { background: rgba(0,113,227,0.08); color: #0055B3; }
.att-kind-final { background: rgba(52,199,89,0.10); color: #0E7A3C; }
.att-size { color: var(--text-tertiary); font-size: 11px; flex-shrink: 0; }
.att-uploader { color: var(--text-tertiary); font-size: 11px; flex-shrink: 0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-empty { font-size: 12px; color: var(--text-tertiary); padding: 6px 0; }
</style>
