<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError, request, requestBlob, requestForm } from '../../api/client'
import { requestStreamOrJson } from '../../api/sse'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import type { ContractDocStyle } from '../../utils/markdown-to-docx'
import type { ContractFile, ContractTemplate, ProjectDetail, MessageDto, EventDto } from '../../types'
import ErrorState from '../../components/ErrorState.vue'
import ProjectHistoryButton from '../../components/ProjectHistoryButton.vue'
import ProjectAssignment from '../../components/ProjectAssignment.vue'
import LegalWorkspaceLayout from '../../components/LegalWorkspaceLayout.vue'
import { prependProjectHistory } from '../../utils/project-history'
import { crmDeliveryStatusLabel, isStatusInGroup, statusLabel } from '../../domain/project-status'

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
const selectedDeliveryFileId = ref('')
const assigneeLabel = computed(() => {
  const current = project.value
  if (!current) return ''
  if (current.legalBp) return current.legalBp.displayName
  if (current.route !== 'legalbp') return '数字分身处理'
  return isStatusInGroup(current.status, 'processing') && current.reviewStatus !== 'review_completed'
    ? '待领导分配' : '无指派法务'
})

onMounted(async () => {
  try {
    const data = await request<ProjectDetail>(`/projects/${id}`)
    project.value = data
    selectedDeliveryFileId.value = data.crmDeliveryFileId ?? ''
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

const loadHistory = (page: ProjectDetail) => {
  messages.value = prependProjectHistory(messages.value, page)
  if (project.value) project.value.history = page.history
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

const isCrmProject = computed(() => Boolean(project.value?.sourceAppId && project.value?.crmTaskId))
const isLegalDeliveryFile = (file: ContractFile) =>
  Boolean(
    (file.kind === 'final' || file.kind === 'revised') &&
    file.uploader &&
    ['legal_bp', 'legal_lead', 'admin'].includes(file.uploader.role)
  )
const contractFileKindLabel = (kind: ContractFile['kind']) => ({
  source: 'CRM 原始合同',
  attachment: 'CRM 参考附件',
  main_contract: 'CRM 主合同',
  revised: '修订版',
  final: '定稿',
})[kind]

const loadFiles = async () => {
  try {
    contractFiles.value = await request<ContractFile[]>(`/projects/${id}/files`)
    if (!contractFiles.value.some(file => file.id === selectedDeliveryFileId.value && isLegalDeliveryFile(file))) {
      const preferred = contractFiles.value.find(file => file.kind === 'final' && isLegalDeliveryFile(file))
        ?? contractFiles.value.find(isLegalDeliveryFile)
      selectedDeliveryFileId.value = preferred?.id ?? ''
    }
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
    const uploaded = await requestForm<{ fileId: string }>(`/projects/${id}/files`, fd, { method: 'POST' })
    await loadFiles()
    selectedDeliveryFileId.value = uploaded.fileId
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '定稿上传失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
  uploadingFinal.value = false
}

const downloadFile = async (f: ContractFile) => {
  actionError.value = null
  try {
    const blob = await requestBlob(`/projects/${id}/files/${f.id}`)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = f.originalName
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '附件下载失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const reply = async () => {
  if (!input.value.trim() || sending.value) return
  if (isCrmProject.value && !selectedDeliveryFileId.value) {
    actionError.value = new RequestError({
      error: '请先上传并选择一个由法务确认的回传文件',
      code: 'CRM_DELIVERY_FILE_REQUIRED',
      statusCode: 409,
    })
    return
  }
  const text = input.value.trim()
  sending.value = true
  actionError.value = null
  try {
    await request(`/projects/${id}/reply`, {
      method: 'POST',
      body: {
        text,
        ...(isCrmProject.value ? { deliveryFileId: selectedDeliveryFileId.value } : {}),
      },
    })
    input.value = ''
    await refreshMessages()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '回传失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    sending.value = false
  }
}

const goBack = () => router.push('/legal/projects')

const avatarLabel = (role: string) => ({ user: '业', assistant: 'AI', legal: '法' })[role] || '?'
const authorLabel = (role: string) => ({ user: '业务人员', assistant: 'AI 助手', legal: '法务 BP' })[role] || role
const timeFmt = (ts: string) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
</script>

<template>
  <LegalWorkspaceLayout active-key="projects">
    <div class="project-detail-page">
      <header class="detail-header">
        <nav
          class="detail-breadcrumb"
          aria-label="面包屑"
        >
          <button
            class="back-link"
            @click="goBack"
          >
            工单管理
          </button>
          <span aria-hidden="true">/</span>
          <span>工单详情</span>
        </nav>
        <template v-if="project">
          <div class="detail-heading">
            <h1>{{ project.title }}</h1>
            <div class="detail-badges">
              <span
                v-if="project.skillName"
                class="skill-chip"
              >{{ project.skillName }}</span>
              <span :class="['risk-chip', 'risk-' + project.risk + '-bg']">{{ project.risk }}</span>
              <span :class="['status-chip', 'status-' + project.status]">{{ statusLabel(project.status) }}</span>
              <span
                v-if="project.crmDeliveryStatus"
                class="status-chip"
              >{{ crmDeliveryStatusLabel(project.crmDeliveryStatus) }}</span>
            </div>
          </div>
          <div class="detail-meta">
            <span>申请人 <strong>{{ project.requesterName || project.creator.displayName }}</strong></span>
            <span>处理归属 <strong>{{ assigneeLabel }}</strong></span>
            <span
              class="detail-id"
              :title="project.id"
            >工单 ID {{ project.id }}</span>
          </div>
        </template>
        <h1 v-else>
          工单详情
        </h1>
      </header>

      <div
        v-if="!loading && !loadError"
        class="chat-content detail-conversation"
      >
        <ErrorState
          v-if="actionError"
          :message="actionError.payload.error"
          :request-id="actionError.payload.requestId"
        />
        <ProjectAssignment
          v-if="project && ['admin', 'legal_lead'].includes(auth.user?.role || '') && project.route === 'legalbp' && !['已回传', '已取消'].includes(project.status) && project.reviewStatus !== 'review_completed'"
          :project-id="id"
          :assignee-name="project.legalBp?.displayName"
          @assigned="refreshMessages"
        />
        <div
          id="msg-container"
          class="msg-scroll"
        >
          <div class="msg-thread">
            <ProjectHistoryButton
              :project-id="id"
              :cursors="project?.history"
              :disabled="sending"
              @loaded="loadHistory"
            />
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
                    v-if="(m as MessageDto).role === 'assistant'"
                    class="ai-disclaimer"
                  >
                    AI 生成 · 仅供参考
                  </div>
                  <DownloadMenu
                    v-if="((m as MessageDto).role === 'assistant' || (m as MessageDto).role === 'legal') && (m as MessageDto).text"
                    :content="(m as MessageDto).text"
                    :filename="'法律咨询答复'"
                    :docx-style="templateStyle"
                    :audit-project-id="id"
                    :audit-resource-type="project?.kind === 'contract' ? 'contract' : 'consultation_record'"
                    :audit-resource-id="String((m as MessageDto).id ?? '') || undefined"
                  />
                </div>
              </div>
            </template>
          </div>

          <!-- 合同附件 -->
          <div
            v-if="project && project.kind === 'contract'"
            class="attach-panel"
          >
            <div class="attach-head">
              <span class="attach-title">合同附件 <small>{{ contractFiles.length }}</small></span>
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
              <div
                v-for="f in contractFiles"
                :key="f.id"
                :class="['attach-item', { 'attach-item-selected': selectedDeliveryFileId === f.id }]"
              >
                <label
                  v-if="isCrmProject"
                  class="delivery-choice"
                  :title="!isLegalDeliveryFile(f) ? '仅法务角色上传的文件可回传' : canReply() ? '选择为 CRM 回传文件' : '审核已完成，回传文件不可变更'"
                >
                  <input
                    v-model="selectedDeliveryFileId"
                    type="radio"
                    name="crm-delivery-file"
                    :value="f.id"
                    :disabled="!isLegalDeliveryFile(f) || !canReply()"
                  >
                  <span>回传</span>
                </label>
                <button
                  type="button"
                  class="att-download"
                  @click="downloadFile(f)"
                >
                  <span class="att-icon">📄</span>
                  <span class="att-name">{{ f.originalName }}</span>
                  <span :class="['att-kind', 'att-kind-' + f.kind]">{{ contractFileKindLabel(f.kind) }}</span>
                  <span class="att-size">{{ formatSize(f.size) }}</span>
                  <span class="att-uploader">{{ f.uploader?.displayName || '' }}</span>
                </button>
              </div>
            </div>
            <div
              v-else
              class="attach-empty"
            >
              暂无合同附件
            </div>
          </div>
        </div>

        <div
          v-if="project && project.status !== '已取消'"
          class="detail-composer"
        >
          <label for="project-reply">{{ canReply() ? '法务回传意见' : '继续沟通' }}</label>
          <textarea
            id="project-reply"
            v-model="input"
            :placeholder="canReply() ? '填写审核结论、处理意见或需要业务补充的内容…' : '输入消息，继续沟通…'"
            :disabled="sending"
            rows="2"
            @keydown.enter.exact.prevent="canReply() ? reply() : sendMessage()"
          />
          <div class="composer-actions">
            <span>{{ isCrmProject && canReply() && !selectedDeliveryFileId ? '请先上传并选择法务确认的 CRM 回传文件' : 'Enter 提交 · Shift + Enter 换行' }}</span>
            <button
              class="submit-reply"
              :disabled="!input.trim() || sending || (canReply() && isCrmProject && !selectedDeliveryFileId)"
              @click="canReply() ? reply() : sendMessage()"
            >
              {{ sending ? '提交中…' : canReply() ? '回传意见' : '发送消息' }}
            </button>
          </div>
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
        class="detail-loading"
        role="status"
      >
        <span
          class="loading-indicator"
          aria-hidden="true"
        />
        正在加载工单…
      </div>
    </div>
  </LegalWorkspaceLayout>
</template>

<script lang="ts">export default { name: 'ProjectDetailView' }</script>

<style scoped>
.project-detail-page { display: flex; flex-direction: column; height: 100dvh; min-height: 600px; max-width: 1440px; margin: 0 auto; padding: 28px 36px 24px; color: var(--workspace-text); }
.detail-header { flex-shrink: 0; padding-bottom: 22px; }
.detail-breadcrumb { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; color: var(--workspace-tertiary); font-size: 13px; }
.back-link { padding: 0; border: 0; background: none; color: var(--workspace-secondary); font: inherit; cursor: pointer; }
.back-link:hover { color: var(--workspace-blue); }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 14px 24px; }
.detail-header h1 { flex: 1 1 480px; margin: 0; font-size: 22px; font-weight: 650; line-height: 1.5; letter-spacing: -.025em; overflow-wrap: anywhere; }
.detail-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 5px; }
.detail-badges :is(.skill-chip, .status-chip, .risk-chip) { font-size: 12px; border-radius: 6px; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 14px; color: var(--workspace-tertiary); font-size: 12px; line-height: 1.6; }
.detail-meta strong { margin-left: 6px; color: var(--workspace-secondary); font-weight: 500; }
.detail-id { overflow-wrap: anywhere; }
.detail-conversation { flex: 1; min-height: 0; height: auto; max-width: none; border: 1px solid var(--workspace-border); border-radius: 12px; background: #fff; }
.detail-conversation > :not(.msg-scroll) { flex-shrink: 0; }
.detail-conversation .msg-scroll { padding: 0; background: #fff; }
.detail-conversation .msg-thread { width: min(calc(100% - 48px), 1040px); gap: 18px; padding: 28px 0; }
.msg-row.out { max-width: min(80%, 720px); }
.msg-row.in { width: min(100%, 880px); }
.msg-avatar { width: 32px; height: 32px; border-radius: 8px; font-size: 12px; }
.msg-avatar.user, .msg-avatar.legal, .msg-avatar.assistant { color: #2563eb; background: #eff6ff; }
.msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.msg-author { font-size: 12px; font-weight: 600; color: var(--workspace-secondary); }
.msg-time { padding: 0; font-size: 11px; color: var(--workspace-tertiary); }
.msg-row.out .msg-meta { justify-content: flex-end; }
.msg-bubble { padding: 14px 18px; font-size: 14px; line-height: 1.8; border-radius: 10px; }
.msg-row.out .msg-bubble { border: 1px solid #dbeafe; background: #eff6ff; color: #1e3a8a; border-bottom-right-radius: 4px; }
.msg-row.in .msg-bubble, .msg-row.in.legal .msg-bubble { border: 1px solid var(--workspace-border); background: #fff; color: var(--workspace-text); box-shadow: none; border-bottom-left-radius: 4px; }
.msg-event { max-width: 100%; padding: 0; border-radius: 0; background: transparent; color: var(--workspace-tertiary); font-size: 12px; line-height: 1.6; text-align: center; overflow-wrap: anywhere; }
.ai-disclaimer { margin-top: 4px; font-size: 11px; color: var(--workspace-tertiary); }
.detail-composer { padding: 18px 24px; border-top: 1px solid var(--workspace-border); background: #fff; }
.detail-composer label { display: block; margin-bottom: 10px; font-size: 13px; font-weight: 600; }
.detail-composer textarea { display: block; width: 100%; padding: 12px 14px; border: 1px solid var(--workspace-border); border-radius: 8px; background: #f9fafb; font: inherit; font-size: 14px; line-height: 1.6; resize: vertical; min-height: 76px; max-height: 160px; }
.detail-composer textarea:focus { outline: 2px solid #bfdbfe; border-color: var(--workspace-blue); background: #fff; }
.detail-composer textarea::placeholder { color: #9ca3af; }
.composer-actions { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 12px; }
.composer-actions > span { color: var(--workspace-tertiary); font-size: 11px; line-height: 1.6; }
.submit-reply { flex-shrink: 0; min-height: 38px; padding: 8px 20px; border: 1px solid #2563eb; border-radius: 8px; background: #2563eb; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.submit-reply:hover:not(:disabled) { background: #1d4ed8; }
.submit-reply:disabled { border-color: #e5e7eb; background: #f3f4f6; color: #9ca3af; cursor: not-allowed; }
.project-detail-page :is(button, input):focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.attach-panel { padding: 16px 24px; border-top: 1px solid var(--workspace-border); }
.attach-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.attach-title { font-size: 13px; font-weight: 600; }
.attach-title small { margin-left: 6px; color: var(--workspace-tertiary); font-weight: 400; }
.attach-upload-btn { min-height: 32px; padding: 6px 12px; border: 1px solid #bfdbfe; border-radius: 6px; background: #eff6ff; color: #2563eb; font: inherit; font-size: 12px; cursor: pointer; }
.attach-upload-btn:disabled { opacity: .5; cursor: not-allowed; }
.attach-file-input { display: none; }
.attach-list { display: flex; flex-direction: column; gap: 6px; }
.attach-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--workspace-border); border-radius: 8px; background: #f9fafb; font-size: 12px; }
.attach-item:hover, .attach-item-selected { border-color: #bfdbfe; background: #eff6ff; }
.delivery-choice { display: inline-flex; align-items: center; gap: 4px; color: #2563eb; cursor: pointer; }
.delivery-choice:has(input:disabled) { color: var(--workspace-tertiary); cursor: not-allowed; }
.att-download { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 0; border: none; background: transparent; font: inherit; text-align: left; cursor: pointer; }
.att-icon { font-size: 14px; flex-shrink: 0; }
.att-name { font-weight: 500; color: var(--workspace-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-kind { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; flex-shrink: 0; background: #f3f4f6; color: #4b5563; }
.att-kind-revised { background: #eff6ff; color: #2563eb; }
.att-kind-final { background: #f0fdf4; color: #15803d; }
.att-size, .att-uploader { color: var(--workspace-tertiary); font-size: 11px; flex-shrink: 0; }
.att-uploader { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-empty { font-size: 12px; color: var(--workspace-tertiary); padding: 6px 0; }
.detail-loading { display: flex; flex: 1; align-items: center; justify-content: center; gap: 12px; color: var(--workspace-tertiary); font-size: 14px; }
.loading-indicator { width: 18px; height: 18px; border: 2px solid #dbeafe; border-top-color: #2563eb; border-radius: 50%; animation: loading-spin 1s linear infinite; }
@keyframes loading-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-indicator { animation: none; } }
@media (max-width: 1100px) { .project-detail-page { padding: 24px; } .detail-header h1 { font-size: 20px; } }
@media (max-width: 600px) {
  .project-detail-page { height: auto; min-height: 100dvh; padding: 18px 12px; }
  .detail-header { padding-bottom: 16px; }
  .detail-header h1 { font-size: 18px; }
  .detail-conversation { min-height: 520px; }
  .detail-conversation .msg-thread { width: calc(100% - 24px); padding: 20px 0; }
  .msg-row.out { max-width: 100%; }
  .msg-avatar { display: none; }
  .detail-composer, .attach-panel { padding: 16px 12px; }
  .att-uploader, .att-size { display: none; }
}
</style>
