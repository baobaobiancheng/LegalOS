<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { getAccessToken, request } from '../../api/client'
import MarkdownContent from '../../components/MarkdownContent.vue'
import DownloadMenu from '../../components/DownloadMenu.vue'
import BusinessSidebarLayout from '../../components/BusinessSidebarLayout.vue'
import type { ContractTemplate } from '../../types'

// ── 步骤状态 ──
const steps = ['选择模板', '填写要素', '生成草稿']
const step = ref(1)

// ── 模板 ──
const templates = ref<ContractTemplate[]>([])
const loadingTemplates = ref(true)
const selected = ref<ContractTemplate | null>(null)

// ── 表单要素（按模板 elementsSchema 动态渲染，每模板字段不同）──
const elements = reactive<Record<string, string>>({})
const schemaFields = computed(() => selected.value?.elementsSchema || [])
const basicFields = computed(() => schemaFields.value.filter(f => f.group !== 'details'))
const detailFields = computed(() => schemaFields.value.filter(f => f.group === 'details'))
const showDetails = ref(false)
/** 草稿中【待补充】计数——提示用户哪些实事需确认（AI 不编造，未填即标注） */
const pendingCount = computed(() => {
  if (!draftComplete.value) return 0
  return (draftText.value.match(/【待补充】/g) || []).length
})

// ── 草稿生成 ──
const generating = ref(false)
const draftText = ref('')
const draftComplete = ref(false)

// ── 工单 ──
const projectId = ref('')
const projectRoute = ref('')
const projectStatus = ref('')
const submittedReview = ref(false)
const submittingReview = ref(false)

// ── 上传修订版 ──
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const events = ref<{ text: string }[]>([])

onMounted(async () => {
  loadingTemplates.value = true
  try {
    templates.value = await request<ContractTemplate[]>('/contract-templates')
  } catch {}
  loadingTemplates.value = false
})

const pickTemplate = (t: ContractTemplate) => {
  selected.value = t
  // 切换模板时重置表单
  for (const k of Object.keys(elements)) delete elements[k]
}
const nextToForm = () => { if (selected.value) step.value = 2 }
const backToTemplates = () => { step.value = 1 }

/** 按模板 elementsSchema 收集非空要素 */
const cleanElements = () => {
  const out: Record<string, string> = {}
  for (const f of schemaFields.value) {
    const v = (elements[f.key] || '').trim()
    if (v) out[f.key] = v
  }
  return out
}

// ── SSE 流式生成草稿 ──
const generateDraft = async () => {
  if (generating.value || !selected.value) return
  generating.value = true
  draftComplete.value = false
  draftText.value = ''

  const body: Record<string, unknown> = {
    templateSlug: selected.value.slug,
    elements: cleanElements(),
  }
  if (projectId.value) body.projectId = projectId.value

  try {
    const res = await fetch('/api/contracts/generate', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` },
      body: JSON.stringify(body),
    })
    const ct = res.headers.get('content-type') || ''

    if (ct.includes('text/event-stream')) {
      const reader = res.body?.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: false })
      let text = ''
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of decoder.decode(value, { stream: true }).split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const d = JSON.parse(line.slice(6))
              if (d.done) {
                if (d.projectId) projectId.value = d.projectId
                if (d.status) projectStatus.value = d.status
                draftComplete.value = true
                step.value = 3
                events.value.push({ text: '合同草稿已生成' })
              } else if (d.error) {
                events.value.push({ text: '草稿生成失败，请重试' })
              } else if (d.text) {
                text += d.text
                draftText.value = text
              }
            } catch {}
          }
        }
      }
    } else {
      events.value.push({ text: '草稿生成失败，请稍后重试' })
    }
  } catch {
    events.value.push({ text: '服务异常，请稍后重试' })
  }
  generating.value = false
}

// ── 上传修订版 ──
const triggerUpload = () => fileInput.value?.click()

const handleUpload = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file || !projectId.value) return
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', 'revised')
    const res = await fetch(`/api/projects/${projectId.value}/files`, {
      method: 'POST', credentials: 'include',
      headers: { authorization: `Bearer ${getAccessToken()}` },
      body: fd,
    })
    events.value.push({ text: res.ok ? `已上传修订版：${file.name}` : '修订版上传失败，请重试' })
  } catch {
    events.value.push({ text: '上传失败，请重试' })
  }
  uploading.value = false
}

// ── 发起法务审阅 ──
const submitReview = async () => {
  if (submittingReview.value || submittedReview.value || !projectId.value) return
  submittingReview.value = true
  try {
    const data = await request<{ projectId: string; status: string }>(`/contracts/${projectId.value}/submit-review`, {
      method: 'POST',
    })
    projectRoute.value = 'legalbp'
    projectStatus.value = data.status
    submittedReview.value = true
    events.value.push({ text: '已提交法务审阅，工单已进入法务 BP 流程' })
  } catch {
    events.value.push({ text: '发起法务审阅失败，请重试' })
  }
  submittingReview.value = false
}
</script>

<template>
  <BusinessSidebarLayout active-key="contract" content-class="contract-content">
    <template #topbar>
      <div class="tb-left">
        <small class="tb-path">Business OS</small>
        <strong class="tb-title">合同助手</strong>
      </div>
      <!-- 2026-08-05：无信息量的"在线"徽章已删除；仅保留真实流程状态 -->
      <span class="tb-badge draft" v-if="draftComplete && !submittedReview">草稿已生成</span>
      <span class="tb-badge submitted" v-else-if="submittedReview">已提交审阅</span>
    </template>
        <!-- 步骤指示 -->
        <div class="step-bar">
          <template v-for="(s, i) in steps" :key="s">
            <div :class="['step-item', { active: step === i + 1, done: step > i + 1 }]">
              <span class="step-dot">{{ step > i + 1 ? '✓' : i + 1 }}</span>
              <span class="step-text">{{ s }}</span>
            </div>
            <div v-if="i < steps.length - 1" class="step-line" :class="{ on: step > i + 1 }"></div>
          </template>
        </div>

        <!-- 步骤1：选模板 -->
        <section v-if="step === 1" class="step-panel">
          <div class="panel-head">
            <h2 class="text-h2">选择合同模板</h2>
            <p class="text-body" style="margin-top:6px">选择所需合同类型，我们将为您生成专业草稿</p>
          </div>
          <div v-if="loadingTemplates" class="template-grid">
            <div v-for="i in 3" :key="'sk-' + i" class="template-card glass-card skeleton" style="height:170px;border:none;cursor:default"></div>
          </div>
          <template v-else>
            <div class="template-grid">
              <article
                v-for="t in templates" :key="t.slug"
                :class="['template-card', 'glass-card', { selected: selected?.slug === t.slug }]"
                @click="pickTemplate(t)"
              >
                <div class="tpl-icon">📋</div>
                <div class="tpl-name">{{ t.name }}</div>
                <div class="tpl-cat">{{ t.category }}</div>
                <p class="tpl-desc">{{ t.description }}</p>
              </article>
            </div>
            <div v-if="templates.length === 0" class="template-empty">暂无可用模板</div>
          </template>
          <div class="btn-row">
            <button class="btn-primary" :disabled="!selected" @click="nextToForm">下一步：填写要素</button>
          </div>
        </section>

        <!-- 步骤2：填要素 -->
        <section v-else-if="step === 2" class="step-panel">
          <div class="panel-head">
            <h2 class="text-h2">填写合同要素</h2>
            <p class="text-body" style="margin-top:6px">尽量补充关键要素，缺省项将由 AI 智能补全</p>
          </div>
          <div class="form-card glass-card">
            <div class="form-selected">
              <span class="fs-label">已选模板</span>
              <span class="fs-value">{{ selected?.name }}</span>
            </div>
            <div class="form-grid">
              <div
                v-for="f in basicFields" :key="f.key"
                class="form-field" :class="{ 'span-full': f.type === 'textarea' }"
              >
                <label>{{ f.label }} <span v-if="f.required" class="req">*</span></label>
                <input
                  v-if="f.type === 'text'" class="input-apple"
                  v-model="elements[f.key]" :placeholder="f.placeholder || ''"
                />
                <textarea
                  v-else class="clauses-input" v-model="elements[f.key]" rows="4"
                  :placeholder="f.placeholder || '补充特别关注的条款'"
                ></textarea>
              </div>
            </div>

            <!-- 详细信息（选填，可折叠：填了进合同，不填 AI 标注【待补充】绝不编造） -->
            <div v-if="detailFields.length" class="form-details">
              <button type="button" class="details-toggle" @click="showDetails = !showDetails">
                <span>{{ showDetails ? '收起' : '展开' }}详细信息（选填）</span>
                <span class="dt-arrow" :class="{ open: showDetails }">▾</span>
              </button>
              <div v-if="showDetails" class="form-grid details-grid">
                <div
                  v-for="f in detailFields" :key="f.key"
                  class="form-field" :class="{ 'span-full': f.type === 'textarea' }"
                >
                  <label>{{ f.label }} <span v-if="f.required" class="req">*</span></label>
                  <input
                    v-if="f.type === 'text'" class="input-apple"
                    v-model="elements[f.key]" :placeholder="f.placeholder || ''"
                  />
                  <textarea
                    v-else class="clauses-input" v-model="elements[f.key]" rows="4"
                    :placeholder="f.placeholder || '补充特别关注的条款'"
                  ></textarea>
                </div>
              </div>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn-secondary" @click="backToTemplates">上一步</button>
            <button class="btn-primary" :disabled="generating" @click="generateDraft">
              {{ generating ? '生成中…' : '生成合同草稿' }}
            </button>
          </div>
        </section>

        <!-- 步骤3：草稿 + 操作 -->
        <section v-else class="step-panel">
          <div v-if="projectStatus" class="status-row">
            <span :class="['status-chip', 'status-' + projectStatus]">{{ projectStatus }}</span>
            <span v-if="submittedReview" class="status-hint">法务 BP 处理中</span>
          </div>

          <div class="draft-card glass-card">
            <div class="draft-head">
              <span class="draft-title">📄 合同草稿</span>
              <button class="edit-link" :disabled="generating" @click="step = 2">编辑要素</button>
            </div>
            <div class="draft-body">
              <MarkdownContent v-if="draftText" :text="draftText" :streaming="generating" :done="draftComplete" />
              <div v-else class="draft-empty">
                {{ generating ? '正在生成合同草稿…' : '草稿为空，请返回上一步重新生成' }}
              </div>
            </div>
            <div v-if="pendingCount > 0" class="pending-hint">
              ⚠️ 本稿有 <b>{{ pendingCount }}</b> 处【待补充】事项——AI 不会自行填写用户未提供的实事，需双方确认后补全
            </div>
            <div v-if="draftComplete" class="draft-actions">
              <DownloadMenu :content="draftText" :filename="'合同草稿'" :docx-style="selected?.style" />
              <button class="btn-secondary" @click="triggerUpload" :disabled="uploading || !projectId">
                {{ uploading ? '上传中…' : '上传修订版' }}
              </button>
              <input ref="fileInput" type="file" class="hidden-input" accept=".docx,.pdf,.md,.txt" @change="handleUpload" />
              <button class="btn-primary review-btn" :disabled="submittingReview || submittedReview || !projectId" @click="submitReview">
                {{ submittedReview ? '已提交法务审阅' : submittingReview ? '提交中…' : '发起法务审阅' }}
              </button>
            </div>
          </div>

          <div v-if="submittedReview" class="legalbp-banner">
            <span>👩‍⚖️ 法务 BP 处理中</span>
            <span class="legalbp-sub">审阅完成后将回传修订意见，您可在「我的记录」中查看进度</span>
          </div>

          <div v-if="events.length" class="event-list">
            <div v-for="(ev, i) in events" :key="i" class="msg-event">{{ ev.text }}</div>
          </div>
        </section>
  </BusinessSidebarLayout>
</template>

<script lang="ts">export default { name: 'ContractView' }</script>

<style scoped>
.tb-left { display: flex; align-items: baseline; gap: 10px; }
.tb-path { font-size: 11px; color: var(--text-tertiary); font-weight: 590; }
.tb-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.tb-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 10px; }
.tb-badge.draft { background: rgba(0,113,227,0.08); color: var(--blue); }
.tb-badge.submitted { background: rgba(175,82,222,0.08); color: #AF52DE; }

/* contract-content 已移至全局 apple.css（BusinessSidebarLayout 渲染的容器收不到 scoped 样式） */

/* ── 步骤指示 ── */
.step-bar { display: flex; align-items: center; justify-content: center; margin-bottom: 30px; }
.step-item { display: flex; align-items: center; gap: 8px; }
.step-dot {
  width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 12px; font-weight: 650;
  background: rgba(0,0,0,0.05); color: var(--text-tertiary);
  transition: all 0.3s var(--spring);
}
.step-item.active .step-dot {
  background: var(--blue); color: #fff;
  box-shadow: 0 0 0 4px rgba(0,113,227,0.15);
}
.step-item.done .step-dot { background: #34C759; color: #fff; }
.step-text { font-size: 13px; font-weight: 550; color: var(--text-tertiary); white-space: nowrap; }
.step-item.active .step-text { color: var(--text); }
.step-item.done .step-text { color: var(--text-secondary); }
.step-line { width: 48px; height: 2px; margin: 0 12px; background: rgba(0,0,0,0.08); border-radius: 1px; }
.step-line.on { background: #34C759; }

.step-panel { animation: fade-in-up 0.5s var(--spring) both; }
.panel-head { margin-bottom: 20px; }

/* ── 模板卡片 ── */
.template-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.template-card {
  padding: 24px; border-radius: var(--radius-sm);
  cursor: pointer; border: 1.5px solid transparent;
  transition: all 0.3s var(--spring); position: relative;
}
.template-card:hover { transform: translateY(-3px); box-shadow: 0 12px 32px rgba(0,0,0,0.08); }
.template-card.selected {
  border-color: var(--blue);
  background: rgba(255,255,255,0.96);
  box-shadow: 0 8px 28px rgba(0,113,227,0.14);
}
.template-card.selected::after {
  content: "✓"; position: absolute; top: 14px; right: 14px;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--blue); color: #fff;
  display: grid; place-items: center; font-size: 13px; font-weight: 700;
}
.tpl-icon { font-size: 30px; margin-bottom: 14px; }
.tpl-name { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.tpl-cat {
  display: inline-block; margin-top: 8px;
  font-size: 11px; font-weight: 600; color: var(--blue);
  background: rgba(0,113,227,0.08); padding: 3px 10px; border-radius: 10px;
}
.tpl-desc { margin-top: 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 0; }
.template-empty { text-align: center; color: var(--text-tertiary); font-size: 13px; padding: 40px 0; }

/* ── 表单 ── */
.form-card { padding: 28px; border-radius: var(--radius-sm); }
.form-selected { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.fs-label { font-size: 11px; color: var(--text-tertiary); font-weight: 600; }
.fs-value { font-size: 14px; font-weight: 650; color: var(--blue); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.form-field { margin-bottom: 18px; }
.form-field.span-full { grid-column: 1 / -1; }

/* ── 详细信息折叠 ── */
.form-details { margin-top: 2px; }
.details-toggle {
  display: flex; align-items: center; gap: 6px;
  border: 1px dashed rgba(30,58,138,0.25); background: rgba(30,58,138,0.03);
  padding: 8px 14px; border-radius: 10px;
  font-family: inherit; font-size: 12px; font-weight: 550; color: var(--blue);
  cursor: pointer; transition: all 0.25s var(--spring); margin-bottom: 16px;
}
.details-toggle:hover { background: rgba(30,58,138,0.07); }
.dt-arrow { display: inline-block; transition: transform 0.3s var(--spring); font-size: 10px; }
.dt-arrow.open { transform: rotate(180deg); }
.details-grid { animation: fade-in-up 0.35s var(--spring) both; }

/* ── 待补充提示 ── */
.pending-hint {
  margin-top: 14px; padding: 10px 14px; border-radius: var(--radius-xs);
  background: rgba(255,149,0,0.08); border: 1px solid rgba(255,149,0,0.2);
  font-size: 12px; color: #C46200; line-height: 1.6;
}
.pending-hint b { font-weight: 700; }
.form-field label {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text);
}
.form-field .opt { font-size: 10px; font-weight: 500; color: var(--text-tertiary); }
.form-field .req { color: #FF3B30; font-size: 12px; }
.clauses-input {
  width: 100%; padding: 14px 16px; border: none; border-radius: var(--radius-xs);
  background: var(--input-bg); color: var(--text);
  font-family: inherit; font-size: 14px; line-height: 1.6;
  resize: vertical; outline: none; transition: all 0.3s var(--spring);
}
.clauses-input:focus { background: #fff; box-shadow: 0 0 0 4px rgba(0,113,227,0.12); }

.btn-row { display: flex; justify-content: center; gap: 14px; margin-top: 28px; }

/* ── 草稿 ── */
.status-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.status-hint { font-size: 12px; color: var(--text-tertiary); }
/* status-chip 使用全局类（status-待复核/已回传 等），无需自定义覆盖 */

.draft-card { padding: 28px; border-radius: var(--radius-sm); }
.draft-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.draft-title { font-size: 15px; font-weight: 650; }
.edit-link {
  border: none; background: none; font-family: inherit;
  font-size: 12px; color: var(--blue); cursor: pointer; font-weight: 500;
}
.edit-link:disabled { opacity: 0.4; cursor: not-allowed; }
.draft-body {
  background: #fff; border-radius: var(--radius-xs);
  padding: 18px 20px; max-height: 460px; overflow-y: auto;
  border: 1px solid rgba(0,0,0,0.05);
}
.draft-empty { color: var(--text-tertiary); font-size: 13px; text-align: center; padding: 40px 0; }
.draft-actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.review-btn { background: #1E3A8A; }
.review-btn:hover { background: #1E40AF; box-shadow: 0 8px 24px rgba(30,58,138,0.30); }
.hidden-input { display: none; }

.legalbp-banner {
  margin-top: 16px; padding: 14px 18px; border-radius: var(--radius-xs);
  background: rgba(255,149,0,0.08); border: 1px solid rgba(255,149,0,0.2);
  display: flex; flex-direction: column; gap: 4px;
  font-size: 13px; font-weight: 600; color: #C46200;
}
.legalbp-sub { font-size: 12px; font-weight: 400; color: var(--text-secondary); }

.event-list { display: flex; flex-direction: column; gap: 6px; margin-top: 20px; }
.event-list .msg-event { align-self: flex-start; }

@media (max-width: 720px) {
  .template-grid { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
