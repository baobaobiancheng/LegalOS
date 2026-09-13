<script setup lang="ts">
import type { ConsultationCapabilityChoice } from '../../types'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'
import { useRoute, useRouter } from 'vue-router'
import { RequestError, request } from '../../api/client'
import { requestStreamOrJson, type ConsultStreamEvent } from '../../api/sse'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import ChatInputBar from '../../components/ChatInputBar.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import ErrorState from '../../components/ErrorState.vue'
import ProjectHistoryButton from '../../components/ProjectHistoryButton.vue'
import { prependProjectHistory } from '../../utils/project-history'
import MarkdownContent from '../../components/MarkdownContent.vue'
import type { AttachedFile } from '../../composables/useFileUpload'
import { useFileUpload } from '../../composables/useFileUpload'
import { useSmoothStream } from '../../composables/useSmoothStream'
import { crmDeliveryStatusLabel, statusClass, statusLabel } from '../../domain/project-status'
import type { ContractTemplate, EventDto, MessageDto, ProjectDetail, ProjectKind } from '../../types'
import type { ContractDocStyle } from '../../utils/markdown-to-docx'

type TimelineEvent = EventDto & { _event: true }
type TimelineItem = MessageDto | TimelineEvent

const selectedCapability = ref<ConsultationCapabilityChoice>('auto')

const route = useRoute()
const router = useRouter()
const { buildFullInput, buildDisplayText } = useFileUpload()
const pageRoot = ref<HTMLElement | null>(null)
const project = ref<ProjectDetail | null>(null)
const messages = ref<TimelineItem[]>([])
const templateStyle = ref<ContractDocStyle | undefined>()
const sending = ref(false)
const upgrading = ref(false)
const loading = ref(true)
const copiedMessageId = ref('')
const loadError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const id = String(route.params.id)
let animationContext: gsap.Context | null = null
let streamScrollFrame: number | null = null

const kindLabel = (kind: ProjectKind) => ({ consult: '咨询', contract: '合同', research: '检索', draft: '文书' })[kind]
const kindClass = (kind: ProjectKind) => `kind-${kind}`
const isTimelineEvent = (item: TimelineItem): item is TimelineEvent => '_event' in item
const sourceRecords = (message: MessageDto) => message.research?.trace.calls.flatMap(call => call.records) ?? []
const sourceValue = (source: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}
const sourceKey = (source: Record<string, unknown>, index: number) => sourceValue(source, 'recordId', 'sourceId', 'id') || `source-${index}`
const formatDateTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const formatTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
const mergeTimeline = (data: ProjectDetail) => {
  const timeline: TimelineItem[] = [...data.messages, ...data.events.map(event => ({ ...event, _event: true as const }))]
  timeline.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
  messages.value = timeline
}
const lastAssistantId = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const item = messages.value[index]
    if (!isTimelineEvent(item) && item.role === 'assistant') return item.id
  }
  return ''
})
const loadHistory = (page: ProjectDetail) => {
  messages.value = prependProjectHistory(messages.value, page)
  if (project.value) project.value.history = page.history
}
const canContinue = computed(() => Boolean(project.value && project.value.status !== '已取消' && project.value.route === 'llm'))
const canEscalate = computed(() => Boolean(project.value && project.value.status !== '已取消' && project.value.route === 'llm'))

const scrollBottom = () => nextTick(() => {
  const element = document.getElementById('record-message-scroll')
  if (element) element.scrollTop = element.scrollHeight
})
const scheduleStreamScroll = () => {
  if (streamScrollFrame !== null) return
  streamScrollFrame = requestAnimationFrame(() => {
    streamScrollFrame = null
    const element = document.getElementById('record-message-scroll')
    if (element) element.scrollTop = element.scrollHeight
  })
}
const animatePage = async () => {
  await nextTick()
  if (!pageRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  animationContext?.revert()
  animationContext = gsap.context(() => {
    gsap.from('.record-heading > *', { autoAlpha: 0, y: 14, duration: .5, stagger: .06, ease: 'power2.out' })
    gsap.from('.timeline-item', { autoAlpha: 0, y: 12, duration: .42, stagger: .045, delay: .1, ease: 'power2.out' })
  }, pageRoot.value)
}
const loadProject = async () => {
  loading.value = true
  loadError.value = null
  try {
    const data = await request<ProjectDetail>(`/projects/${id}`)
    project.value = data
    mergeTimeline(data)
    if (data.kind === 'contract' && data.contractTemplateSlug) {
      try {
        const templates = await request<ContractTemplate[]>('/contract-templates')
        templateStyle.value = templates.find(template => template.slug === data.contractTemplateSlug)?.style
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
  } finally {
    loading.value = false
  }
  await animatePage()
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
      : new RequestError({ error: '记录刷新失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  }
}
const handleSend = async (text: string, files: AttachedFile[], capability = selectedCapability.value) => {
  if ((!text && !files.length) || sending.value || !canContinue.value) return
  const fullInput = buildFullInput(text, files)
  const displayText = buildDisplayText(text, files)
  sending.value = true
  actionError.value = null
  messages.value.push({ id: `tmp-${Date.now()}`, role: 'user', text: displayText, createdAt: new Date().toISOString() })
  let aiMessage: MessageDto | undefined
  const streamRenderer = useSmoothStream()
  streamRenderer.setListener((value) => {
    if (aiMessage) aiMessage.text = value
    scheduleStreamScroll()
  })
  scrollBottom()
  try {
    const attachmentIds = files.filter(file => file.status === 'ready' || file.status === 'warning').map(file => file.id)
    const data = await requestStreamOrJson<ConsultStreamEvent | { route?: string }>(`/projects/${id}/messages`, {
      method: 'POST', timeoutMs: 45_000, timeoutCode: 'SSE_HEADER_TIMEOUT', body: { text: fullInput, attachmentIds, capability },
    }, (event) => {
      if (!('type' in event)) return
      if (event.type === 'message_start') {
        aiMessage ??= { id: event.messageId, role: 'assistant', text: '', createdAt: new Date().toISOString() }
        if (!messages.value.some(message => message.id === event.messageId)) messages.value.push(aiMessage)
      } else if (event.type === 'text_delta') {
        streamRenderer.enqueue(event.delta)
      } else if (event.type === 'message_end') {
        streamRenderer.finish(event.finalText)
        if (aiMessage && event.research && typeof event.research === 'object') {
          aiMessage.research = event.research as NonNullable<MessageDto['research']>
        }
        void refreshMessages()
      } else if (event.type === 'error') {
        streamRenderer.finish(event.message || 'AI 答复生成失败，请稍后重试')
      }
    }) as { route?: string } | undefined
    if (data?.route === 'legalbp') {
      messages.value.push({ id: `event-${Date.now()}`, _event: true, text: '该问题已转交法务 BP，处理进展会同步到本记录。', createdAt: new Date().toISOString() })
      if (project.value) project.value.route = 'legalbp'
      scrollBottom()
    }
  } catch (error) {
    streamRenderer.cancel()
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '消息发送失败，请重试', code: 'UNKNOWN', statusCode: 0 })
    messages.value.push({ id: `event-${Date.now()}`, _event: true, text: '消息发送失败，请重试。', createdAt: new Date().toISOString() })
  } finally {
    sending.value = false
  }
}
const copyAnswer = async (message: MessageDto) => {
  try {
    await navigator.clipboard.writeText(message.text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = message.text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copiedMessageId.value = message.id
  window.setTimeout(() => { if (copiedMessageId.value === message.id) copiedMessageId.value = '' }, 1600)
}
const handleEscalate = async () => {
  if (!project.value || !canEscalate.value || upgrading.value) return
  upgrading.value = true
  actionError.value = null
  try {
    const result = await request<{ upgraded: boolean; route: 'legalbp'; status: ProjectDetail['status'] }>(`/projects/${id}/escalate`, { method: 'POST' })
    project.value.route = result.route
    project.value.status = result.status
    project.value.updatedAt = new Date().toISOString()
    messages.value.push({ id: `event-${Date.now()}`, _event: true, text: '已转交法务 BP，后续处理进展会同步到本记录。', createdAt: new Date().toISOString() })
    scrollBottom()
  } catch (error) {
    actionError.value = error instanceof RequestError
      ? error
      : new RequestError({ error: '转交失败，请重试', code: 'UNKNOWN', statusCode: 0 })
  } finally {
    upgrading.value = false
  }
}

onMounted(loadProject)
onBeforeUnmount(() => {
  animationContext?.revert()
  if (streamScrollFrame !== null) cancelAnimationFrame(streamScrollFrame)
})
</script>

<template>
  <BusinessSidebarLayout active-key="records">
    <div
      ref="pageRoot"
      class="record-detail-page"
    >
      <ErrorState
        v-if="loadError"
        class="page-error"
        :message="loadError.payload.error"
        :request-id="loadError.payload.requestId"
        :on-retry="loadProject"
      />
      <template v-else-if="project">
        <p class="record-breadcrumb">
          业务工作台 <span>/</span> 我的记录 <span>/</span> 咨询详情
        </p>
        <header class="record-heading">
          <div class="heading-copy">
            <h1>{{ project.title }}</h1>
            <div class="record-meta">
              <em :class="['kind-tag', kindClass(project.kind)]">{{ kindLabel(project.kind) }}</em>
              <em :class="['risk-tag', `risk-${project.risk}`]">{{ project.risk }}</em>
              <span :class="['record-status', statusClass(project.status)]">{{ statusLabel(project.status) }}</span>
              <span
                v-if="project.crmDeliveryStatus"
                class="record-status"
              >{{ crmDeliveryStatusLabel(project.crmDeliveryStatus) }}</span>
              <i />
              <span>创建于 {{ formatDateTime(project.createdAt) }}</span>
              <span>更新于 {{ formatDateTime(project.updatedAt) }}</span>
            </div>
          </div>
          <button
            class="back-button"
            type="button"
            @click="router.push('/business/records')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="m15 18-6-6 6-6" /></svg>
            返回记录
          </button>
        </header>

        <section
          id="record-message-scroll"
          class="record-thread"
          aria-label="咨询对话"
        >
          <div class="timeline-list">
            <ProjectHistoryButton
              :project-id="id"
              :cursors="project?.history"
              :disabled="sending"
              @loaded="loadHistory"
            />
            <template
              v-for="item in messages"
              :key="item.id"
            >
              <div
                v-if="isTimelineEvent(item)"
                class="timeline-event timeline-item"
              >
                {{ item.text }}
              </div>
              <article
                v-else-if="item.role === 'user'"
                class="user-message timeline-item"
              >
                <div class="user-bubble">
                  {{ item.text }}
                </div>
                <time>{{ formatTime(item.createdAt) }}</time>
              </article>
              <article
                v-else
                class="answer-row timeline-item"
              >
                <span :class="['message-avatar', { legal: item.role === 'legal' }]">{{ item.role === 'legal' ? '法' : 'AI' }}</span>
                <div class="answer-card">
                  <div class="answer-body">
                    <div
                      v-if="item.role === 'assistant' && item.research"
                      class="evidence-state"
                    >
                      {{ item.research.trace.status === 'success_hit' ? '已完成法规检索与来源核验' : '未检索到可核验来源' }}
                    </div>
                    <MarkdownContent :text="item.text" />
                    <section
                      v-if="item.role === 'assistant' && sourceRecords(item).length"
                      class="source-panel"
                    >
                      <h2>参考来源</h2>
                      <div
                        v-for="(source, sourceIndex) in sourceRecords(item)"
                        :key="sourceKey(source, sourceIndex)"
                        class="source-row"
                      >
                        <strong>{{ sourceValue(source, 'lawName', 'title') || '法律来源' }}</strong>
                        <span>{{ sourceValue(source, 'issuingOrgan', 'court') || '—' }}</span>
                        <span :class="{ valid: Boolean(sourceValue(source, 'timeliness')) }">{{ sourceValue(source, 'timeliness', 'date', 'implementDate') || '—' }}</span>
                        <a
                          v-if="sourceValue(source, 'url')"
                          :href="sourceValue(source, 'url')"
                          target="_blank"
                          rel="noopener noreferrer"
                        >查看来源</a>
                      </div>
                    </section>
                  </div>
                  <footer class="answer-actions">
                    <button
                      type="button"
                      @click="copyAnswer(item)"
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
                      {{ copiedMessageId === item.id ? '已复制' : '复制' }}
                    </button>
                    <DownloadMenu
                      :content="item.text"
                      filename="法律咨询答复"
                      :docx-style="templateStyle"
                      :audit-project-id="id"
                      audit-resource-type="consultation_record"
                      :audit-resource-id="item.id"
                    />
                    <button
                      v-if="item.role === 'assistant' && item.id === lastAssistantId && canEscalate"
                      class="handoff-button"
                      type="button"
                      :disabled="upgrading"
                      @click="handleEscalate"
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
                  </footer>
                </div>
              </article>
            </template>
          </div>
        </section>

        <div
          v-if="canContinue"
          class="record-composer"
        >
          <ChatInputBar
            v-model:capability="selectedCapability"
            :disabled="sending"
            placeholder="继续追问，或补充新的事实与材料"
            @send="handleSend"
          />
          <p>AI 生成内容仅供参考，重要事项建议由法务复核</p>
        </div>
        <div
          v-else-if="project.route === 'legalbp'"
          class="handoff-state"
        >
          已转交法务 BP，处理进展会在本记录中同步。
        </div>
        <ErrorState
          v-if="actionError"
          class="action-error"
          :message="actionError.payload.error"
          :request-id="actionError.payload.requestId"
        />
      </template>
      <div
        v-else
        class="loading-state"
      >
        <span /><strong>{{ loading ? '正在加载咨询记录' : '暂无记录' }}</strong>
      </div>
    </div>
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'RecordDetailView' }</script>

<style scoped>
.record-detail-page { display:flex;width:min(100%,1540px);height:100%;min-height:0;margin:0 auto;padding:28px 38px 24px;flex-direction:column;overflow:hidden;color:#111827 }
.record-breadcrumb{margin:0 0 18px;color:#53627a;font-size:13px}.record-breadcrumb span{margin:0 10px;color:#a8b1bf}.record-heading{display:flex;padding-bottom:18px;align-items:flex-start;justify-content:space-between;gap:28px;border-bottom:1px solid #dbe2eb;flex:0 0 auto}.heading-copy{min-width:0}.heading-copy h1{max-width:900px;margin:0 0 10px;overflow:hidden;color:#0b1222;font-size:clamp(27px,2.45vw,36px);font-weight:680;letter-spacing:-.04em;line-height:1.15;text-overflow:ellipsis;white-space:nowrap}.record-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;color:#617087;font-size:12px}.record-meta em{font-style:normal}.record-meta i{width:1px;height:16px;background:#cfd7e2}.kind-tag,.risk-tag{display:inline-flex;min-height:24px;padding:0 8px;align-items:center;border-radius:4px;font-size:11px;font-weight:650}.kind-consult{background:#eaf3ff;color:#1764ef}.kind-contract{background:#eaf8ef;color:#15804a}.kind-research{background:#eef0ff;color:#4f5edb}.kind-draft{background:#fff4e5;color:#b86a00}.risk-tag{border:1px solid currentColor;background:#fff}.risk-P0{color:#e11d48}.risk-P1{color:#e8671d}.risk-P2{color:#1764ef}.record-status{font-weight:650}.status-info,.status-warning{color:#1764ef}.status-success{color:#159447}.status-neutral{color:#64748b}.back-button{display:inline-flex;height:42px;padding:0 14px;align-items:center;gap:7px;border:1px solid #ccd6e3;border-radius:6px;background:#fff;color:#41516a;font:inherit;font-size:13px;cursor:pointer}.back-button:hover{border-color:#95add0;color:#1764ef}.back-button svg{width:17px;height:17px}
.record-thread{min-height:0;padding:24px 8px 18px 0;flex:1;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.timeline-list{display:flex;width:100%;flex-direction:column;gap:14px}.timeline-event{align-self:center;padding:7px 13px;border-radius:5px;background:#eef2f7;color:#61708a;font-size:11px}.user-message{width:fit-content;max-width:min(72%,760px);margin-left:auto}.user-bubble{padding:12px 17px;border-radius:8px 8px 2px 8px;background:#2e7df5;color:#fff;font-size:14px;line-height:1.55;white-space:pre-wrap}.user-message time{display:block;margin:7px 2px 0;color:#8a96a8;font-size:11px;text-align:right}.answer-row{display:grid;width:100%;grid-template-columns:34px minmax(0,1fr);gap:13px}.message-avatar{display:grid;width:34px;height:34px;border-radius:6px;place-items:center;background:#145ff0;color:#fff;font-size:11px;font-weight:750}.message-avatar.legal{background:#159447}.answer-card{min-width:0;overflow:hidden;border:1px solid #d7dfe9;border-radius:8px;background:#fff}.answer-body{padding:17px 19px 0;color:#39475d;font-size:13px;line-height:1.68}.answer-body :deep(.markstream-vue){--ms-text-h1:1.15rem;--ms-text-h2:1rem;--ms-flow-paragraph-y:.42em;--ms-flow-list-item-y:.13em;--ms-flow-table-y:.72em}.evidence-state{margin-bottom:10px;color:#16975a;font-size:12px;font-weight:650}.source-panel{margin-top:12px;overflow:hidden;border:1px solid #dce3ec;border-radius:6px}.source-panel h2{margin:0;padding:9px 12px;background:#f8fafc;color:#35445b;font-size:12px;font-weight:650}.source-row{display:grid;grid-template-columns:minmax(280px,1.8fr) minmax(120px,.7fr) minmax(90px,.5fr) auto;gap:14px;padding:9px 12px;align-items:center;border-top:1px solid #e5e9ef;color:#637087;font-size:11px}.source-row strong{color:#29364a}.source-row .valid{color:#159757}.source-row a{color:#1764ef;text-decoration:none}.answer-actions{display:flex;min-height:49px;padding:7px 11px;align-items:center;gap:5px;border-top:1px solid #e5e9ef}.answer-actions>button{display:inline-flex;height:32px;padding:0 9px;align-items:center;gap:6px;border:0;border-radius:5px;background:#fff;color:#58667a;font:inherit;font-size:11px;cursor:pointer}.answer-actions>button:hover{background:#f4f7fb;color:#1764ef}.answer-actions>button svg{width:15px;height:15px}.answer-actions :deep(.download-wrap){margin-top:0}.answer-actions :deep(.dl-trigger){height:32px;padding:0 9px;border:0;border-radius:5px;background:#fff;color:#58667a;font-size:11px}.answer-actions :deep(.dl-trigger:hover){background:#f4f7fb;color:#1764ef}.answer-actions>.handoff-button{min-width:140px;margin-left:auto;padding:0 12px;border:1px solid #2368e8;color:#135ee7;font-weight:650}.answer-actions>.handoff-button:hover:not(:disabled){background:#f4f8ff}.answer-actions>.handoff-button:disabled{opacity:.55;cursor:wait}
.answer-body :deep(.markstream-vue){--ms-text-h1:1.08rem;--ms-text-h2:.98rem;--ms-flow-paragraph-y:.28em;--ms-flow-list-item-y:.08em;--ms-flow-table-y:.42em;font-size:13px;line-height:1.58}.answer-body :deep(.markstream-vue h1),.answer-body :deep(.markstream-vue h2),.answer-body :deep(.markstream-vue h3){margin-top:10px;margin-bottom:6px;line-height:1.35}.answer-body :deep(.markstream-vue h1:first-child),.answer-body :deep(.markstream-vue h2:first-child),.answer-body :deep(.markstream-vue h3:first-child){margin-top:0}.answer-body :deep(.markstream-vue p){margin-top:0;margin-bottom:4px}.answer-body :deep(.markstream-vue ol),.answer-body :deep(.markstream-vue ul){margin-top:4px!important;margin-bottom:4px!important;padding-left:24px}.answer-body :deep(.markstream-vue .list-item){min-height:0!important;margin:0!important;padding-top:0!important;padding-bottom:0!important;line-height:1.4!important}.answer-body :deep(.markstream-vue .paragraph-node){min-height:0!important;margin:0!important;padding:0!important;line-height:1.4!important}.answer-body :deep(.markstream-vue table){margin:5px 0 7px!important;font-size:12px;line-height:1.3!important}.answer-body :deep(.markstream-vue th),.answer-body :deep(.markstream-vue td){height:auto!important;padding:3px 10px!important;line-height:1.3!important}.source-panel{margin-top:8px}.source-panel h2{padding-top:7px;padding-bottom:7px}.source-row{padding-top:6px;padding-bottom:6px}.answer-actions{min-height:43px;padding-top:5px;padding-bottom:5px}
.record-composer{margin-left:47px;flex:0 0 auto}.record-composer :deep(.composer-frame textarea){min-height:54px;padding:14px 17px 4px;font-size:13px}.record-composer :deep(.composer-toolbar){min-height:45px;padding:5px 8px 8px 13px;gap:10px}.record-composer :deep(.composer-attach),.record-composer :deep(.capability-trigger){font-size:11px}.record-composer :deep(.composer-attach svg),.record-composer :deep(.capability-trigger>svg){width:16px;height:16px}.record-composer :deep(.toolbar-divider){height:18px}.record-composer :deep(.composer-submit){width:34px;height:30px;border-radius:5px}.record-composer>p{margin:7px 0 0;color:#8a96a8;font-size:10px;text-align:center}.handoff-state{margin:0 0 0 47px;padding:13px 16px;border:1px solid #cfe0ff;border-radius:7px;background:#f3f7ff;color:#315a9d;font-size:12px;text-align:center}.action-error{margin:10px 0 0 47px;flex:0 0 auto}.page-error{margin:24px}.loading-state{display:grid;min-height:100%;place-items:center;align-content:center;gap:12px;color:#5f6e84}.loading-state span{width:28px;height:28px;border:2px solid #dbe5f3;border-top-color:#1764ef;border-radius:50%;animation:record-spin .8s linear infinite}.loading-state strong{font-size:13px;font-weight:600}@keyframes record-spin{to{transform:rotate(360deg)}}
@media(max-width:920px){.record-detail-page{padding-right:24px;padding-left:24px}.record-meta span:last-child{display:none}.source-row{grid-template-columns:1fr;gap:5px}}
@media(max-width:700px){.record-detail-page{padding:22px 16px 18px}.record-heading{gap:14px}.heading-copy h1{max-width:58vw;font-size:24px}.record-meta i,.record-meta span:nth-last-child(-n+2){display:none}.back-button{width:42px;padding:0;justify-content:center;font-size:0}.user-message{max-width:88%}.record-composer,.handoff-state,.action-error{margin-left:0}.answer-actions{flex-wrap:wrap}.answer-actions>.handoff-button{min-width:126px}}
</style>
