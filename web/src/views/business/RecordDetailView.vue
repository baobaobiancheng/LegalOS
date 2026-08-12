<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError, request } from '../../api/client'
import { requestStreamOrJson, type ConsultStreamEvent } from '../../api/sse'
import { useFileUpload } from '../../composables/useFileUpload'
import type { AttachedFile } from '../../composables/useFileUpload'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import ChatInputBar from '../../components/ChatInputBar.vue'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import ErrorState from '../../components/ErrorState.vue'
import type { ContractDocStyle } from '../../utils/markdown-to-docx'
import type { ProjectDetail, MessageDto, EventDto, ContractTemplate } from '../../types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { buildFullInput, buildDisplayText } = useFileUpload()

const project = ref<ProjectDetail | null>(null)
const messages = ref<(MessageDto | (EventDto & { _event: true }))[]>([])
const templateStyle = ref<ContractDocStyle | undefined>()
const sending = ref(false)
const streaming = ref('')
const loading = ref(true)
const loadError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const id = route.params.id as string

onMounted(async () => {
  try {
    const data = await request<ProjectDetail>(`/projects/${id}`)
    project.value = data; mergeTimeline(data)
    // 合同工单：加载对应模板样式供下载（与模板格式一致）
    if (data.kind === 'contract' && data.contractTemplateSlug) {
      try {
        const templates = await request<ContractTemplate[]>('/contract-templates')
        templateStyle.value = templates.find(t => t.slug === data.contractTemplateSlug)?.style
      } catch (error) {
        actionError.value = error instanceof RequestError
          ? error
          : new RequestError({ error: '合同模板样式加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
      }
    }
  } catch (error) {
    loadError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '记录加载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
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

const handleSend = async (text: string, files: AttachedFile[]) => {
  if ((!text && !files.length) || sending.value) return
  const fullInput = buildFullInput(text, files)
  const displayText = buildDisplayText(text, files)
  sending.value = true
  actionError.value = null

  messages.value.push({ id: 'tmp-' + Date.now(), role: 'user', text: displayText, createdAt: new Date().toISOString() } as any)
  scrollBottom()

  try {
    streaming.value = ''
    let aiMsg: any | undefined
    const attachmentIds = files.filter(f => f.status === 'ready' || f.status === 'warning').map(f => f.id)
    const data = (await requestStreamOrJson<ConsultStreamEvent | { route?: string }>(`/projects/${id}/messages`, {
      method: 'POST',
      body: { text: fullInput, attachmentIds },
    }, (d) => {
      // 有身份流式协议（review 2026-08-12）：与咨询页一致
      if (!('type' in d)) return
      const evt = d as ConsultStreamEvent
      if (evt.type === 'message_start') {
        aiMsg ??= { id: evt.messageId, role: 'assistant', text: '' }
        if (!messages.value.some(m => m.id === evt.messageId)) messages.value.push(aiMsg)
      } else if (evt.type === 'text_delta') {
        if (aiMsg) { streaming.value += evt.delta; aiMsg.text = streaming.value; scrollBottom() }
      } else if (evt.type === 'message_end') {
        streaming.value = evt.finalText
        if (aiMsg) aiMsg.text = evt.finalText
        void refreshMessages()
      } else if (evt.type === 'error') {
        if (aiMsg) aiMsg.text = '⚠️ AI 答复生成失败，已通知法务BP处理'
      }
    })) as { route?: string } | undefined
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
    project.value = data; mergeTimeline(data); scrollBottom()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '记录刷新失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const goBack = () => router.push('/business/records')
const avatarLabel = (role: string) => ({ user: auth.user?.displayName?.[0] || 'U', assistant: 'AI', legal: '法' })[role] || '?'
const timeFmt = (ts: string) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
</script>

<template>
  <BusinessSidebarLayout
    active-key="records"
    content-class="chat-content"
  >
    <template #topbar>
      <div class="tb-left">
        <button
          class="back-link"
          @click="goBack"
        >
          ← 我的记录
        </button>
        <template v-if="project">
          <span class="sep">/</span>
          <strong class="tb-title">{{ project.title }}</strong>
          <span
            v-if="project.skillName"
            class="skill-chip"
          >{{ project.skillName }}</span>
          <span :class="['status-chip', 'status-' + project.status]">{{ project.status }}</span>
        </template>
      </div>
      <span
        v-if="loading"
        class="tb-muted"
      >加载中…</span>
    </template>
    <template v-if="!loading && !loadError">
      <div
        id="msg-container"
        class="msg-scroll"
      >
        <div class="msg-thread">
          <template
            v-for="m in messages"
            :key="m.id"
          >
            <div
              v-if="(m as any)._event"
              class="msg-event"
            >
              {{ (m as EventDto).text }}
            </div>
            <div
              v-else
              :class="['msg-row', (m as MessageDto).role === 'user' ? 'out' : 'in']"
            >
              <div :class="['msg-avatar', (m as MessageDto).role]">
                {{ avatarLabel((m as MessageDto).role) }}
              </div>
              <div class="msg-body">
                <div class="msg-bubble">
                  <MarkdownContent
                    v-if="(m as MessageDto).role === 'assistant'"
                    :text="(m as MessageDto).text"
                  />
                  <template v-else>
                    {{ (m as MessageDto).text }}
                  </template>
                </div>
                <span class="msg-time">{{ timeFmt((m as MessageDto).createdAt) }}</span>
                <div
                  v-if="(m as MessageDto).role === 'assistant'"
                  class="ai-disclaimer"
                >
                  AI 生成 · 仅供参考
                </div>
                <DownloadMenu
                  v-if="(m as MessageDto).role === 'assistant' && (m as MessageDto).text"
                  :content="(m as MessageDto).text"
                  :filename="'法律咨询答复'"
                  :docx-style="templateStyle"
                />
              </div>
            </div>
          </template>
        </div>
      </div>

      <ChatInputBar
        v-if="project && project.status !== '已取消' && project.route === 'llm'"
        :disabled="sending"
        placeholder="继续追问，可上传文件…"
        @send="handleSend"
      />
      <ErrorState
        v-if="actionError"
        :message="actionError.payload.error"
        :request-id="actionError.payload.requestId"
      />
    </template>
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
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'RecordDetailView' }</script>

<style scoped>
.tb-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.back-link { background: none; border: none; font-size: 13px; color: var(--blue); cursor: pointer; font-weight: 500; }
.sep { color: var(--text-tertiary); font-size: 13px; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-muted { font-size: 11px; color: var(--text-tertiary); }
.chat-content { max-width: 960px; padding: 0; }
.msg-scroll { padding: 24px 32px 8px; }
.ai-disclaimer { margin-top: 4px; font-size: 10px; color: var(--text-tertiary); padding-left: 4px; }
</style>
