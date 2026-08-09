<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { request } from '../../api/client'
import type { Skill } from '../../types'
import { SKILL_GROUPS, SKILL_PROMPT_MAX_LENGTH, lastRejectReason } from '../../types'

/**
 * 技能库（2026-08-04 技能库模块，设计文档 §6）。
 * 三 tab：技能广场（公有）/ 我的技能（CRUD + 状态机操作）/ 待审核（lead/admin）。
 * 状态机：private →(提交审核)→ pending →(通过)→ public；pending →(撤回/驳回)→ private。
 */

const router = useRouter()
const auth = useAuthStore()

const isLead = computed(() => ['legal_lead', 'admin'].includes(auth.user?.role || ''))
const activeTab = ref<'public' | 'mine' | 'pending'>('public')
const skills = ref<Skill[]>([])
const loading = ref(false)
const groupFilter = ref('')

// 新建/编辑表单
const showForm = ref(false)
const editing = ref<Skill | null>(null)
const form = ref({ slug: '', name: '', group: '合规法务', description: '', prompt: '' })
const formError = ref('')
const saving = ref(false)

// 审核面板
const reviewing = ref<Skill | null>(null)
const reviewReason = ref('')
const reviewingPrompt = ref('')

// 详情查看（三个 tab 通用：卡片点击 → detail API 拉 prompt 全文）
const detail = ref<Skill | null>(null)
const openDetail = async (s: Skill) => {
  detail.value = null
  try {
    detail.value = await request<Skill>(`/skills/${s.id}`)
  } catch {
    // 列表数据无 prompt（服务端剥离），失败时仅展示基础信息
    detail.value = { ...s, prompt: '（prompt 加载失败，请重试）' }
  }
}

// ── SKILL.md 标准导入（frontmatter name/description + 正文 → System Prompt）──
const showImport = ref(false)
const importText = ref('')
const importError = ref('')

const parseSkillMd = (text: string): { name: string; description: string; prompt: string } => {
  const lines = text.replace(/^﻿/, '').split('\n')
  const first = lines.findIndex((l) => l.trim() === '---')
  if (first < 0) throw new Error('不是有效的 SKILL.md：缺少 frontmatter 起始分隔符 ---')
  const end = lines.findIndex((l, i) => i > first && l.trim() === '---')
  if (end < 0) throw new Error('不是有效的 SKILL.md：缺少 frontmatter 结束分隔符 ---')
  const fm: Record<string, string> = {}
  for (let i = first + 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (m) fm[m[1].toLowerCase()] = m[2].trim()
  }
  const prompt = lines.slice(end + 1).join('\n').trim()
  if (!prompt) throw new Error('SKILL.md 正文（System Prompt）为空')
  if (prompt.length > SKILL_PROMPT_MAX_LENGTH) {
    throw new Error(`prompt 超过 ${SKILL_PROMPT_MAX_LENGTH} 字上限，请精简后导入`)
  }
  return { name: fm.name || fm.title || '', description: fm.description || '', prompt }
}

const doImport = () => {
  importError.value = ''
  try {
    const p = parseSkillMd(importText.value)
    if (!p.name) throw new Error('frontmatter 缺少 name 字段，请补充后重试')
    form.value.name = p.name
    form.value.description = p.description
    form.value.prompt = p.prompt
    if (!editing.value) form.value.slug = '' // 导入后 slug 自动生成（拼音）
    showImport.value = false
    importText.value = ''
  } catch (e: any) {
    importError.value = e?.message || '解析失败'
  }
}

const fmtTime = (t?: string) => {
  if (!t) return ''
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const VISIBILITY_LABEL: Record<string, string> = { private: '私有', pending: '待审核', public: '公有' }

const fetchList = async () => {
  loading.value = true
  try {
    const q = groupFilter.value ? `&group=${encodeURIComponent(groupFilter.value)}` : ''
    skills.value = await request<Skill[]>(`/skills?scope=${activeTab.value}${q}`)
  } catch (e: any) {
    console.error('技能列表加载失败', e)
  } finally {
    loading.value = false
  }
}

onMounted(fetchList)

const switchTab = (tab: 'public' | 'mine' | 'pending') => {
  activeTab.value = tab
  groupFilter.value = ''
  fetchList()
}

// ── 新建 / 编辑 ──

const openCreate = () => {
  editing.value = null
  form.value = { slug: '', name: '', group: '合规法务', description: '', prompt: '' }
  formError.value = ''
  showForm.value = true
}

const openEdit = (s: Skill) => {
  editing.value = s
  form.value = {
    slug: s.slug,
    name: s.name,
    group: s.group,
    description: s.description,
    prompt: s.prompt || '',
  }
  formError.value = ''
  showForm.value = true
}

const saveSkill = async () => {
  if (!form.value.name.trim() || !form.value.prompt.trim()) {
    formError.value = '名称与 prompt 必填'
    return
  }
  if (form.value.prompt.length > SKILL_PROMPT_MAX_LENGTH) {
    formError.value = `prompt 不能超过 ${SKILL_PROMPT_MAX_LENGTH} 字`
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      await request(`/skills/${editing.value.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.value.name,
          group: form.value.group,
          description: form.value.description,
          prompt: form.value.prompt,
        }),
      })
    } else {
      await request('/skills', {
        method: 'POST',
        body: JSON.stringify({
          slug: form.value.slug.trim() || undefined,
          name: form.value.name,
          group: form.value.group,
          description: form.value.description,
          prompt: form.value.prompt,
        }),
      })
    }
    showForm.value = false
    fetchList()
  } catch (e: any) {
    formError.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

// ── 状态机操作 ──

const act = async (id: string, action: 'submit' | 'withdraw' | 'archive' | 'restore') => {
  try {
    await request(`/skills/${id}/${action}`, { method: 'POST' })
    fetchList()
  } catch (e: any) {
    alert(e?.message || '操作失败')
  }
}

// ── 审核 ──

const openReview = async (s: Skill) => {
  reviewing.value = s
  reviewReason.value = ''
  try {
    const d = await request<Skill>(`/skills/${s.id}`)
    reviewingPrompt.value = d.prompt || ''
  } catch {
    reviewingPrompt.value = s.prompt || ''
  }
}

const submitReview = async (approved: boolean) => {
  if (!reviewing.value) return
  if (!approved && !reviewReason.value.trim()) {
    alert('驳回必须填写原因')
    return
  }
  try {
    await request(`/skills/${reviewing.value.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ approved, reason: reviewReason.value.trim() || undefined }),
    })
    reviewing.value = null
    fetchList()
  } catch (e: any) {
    alert(e?.message || '审核失败')
  }
}

const logout = () => {
  auth.logout()
  router.push('/login')
}
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
          class="nav-btn"
          @click="router.push('/legal/projects')"
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
        <button class="nav-btn active">
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
      <div class="nav-section">
        <span class="nav-label">企业能力</span>
        <button
          class="nav-btn"
          disabled
        >
          知识库 · v0.2.0
        </button>
        <button
          class="nav-btn"
          disabled
        >
          数字分身 · v0.2.0
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
          @click="logout"
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
          <small class="tb-path">法务 Legal OS</small>
          <strong class="tb-title">技能库</strong>
        </div>
        <!-- 2026-08-05：右上角状态徽章（就绪/数量）无信息量，已删除 -->
      </header>

      <div class="app-content animate-in">
        <!-- Tab 切换 -->
        <div class="tab-row">
          <button
            :class="['tab-btn', activeTab === 'public' && 'active']"
            @click="switchTab('public')"
          >
            技能广场
          </button>
          <button
            :class="['tab-btn', activeTab === 'mine' && 'active']"
            @click="switchTab('mine')"
          >
            我的技能
          </button>
          <button
            v-if="isLead"
            :class="['tab-btn', activeTab === 'pending' && 'active']"
            @click="switchTab('pending')"
          >
            待审核
          </button>
          <div class="tab-right">
            <select
              v-if="activeTab !== 'pending'"
              v-model="groupFilter"
              class="group-select"
              @change="fetchList"
            >
              <option value="">
                全部技能组
              </option>
              <option
                v-for="g in SKILL_GROUPS"
                :key="g"
                :value="g"
              >
                {{ g }}
              </option>
            </select>
            <button
              v-if="activeTab === 'mine'"
              class="btn-primary"
              @click="openCreate"
            >
              ＋ 新建技能
            </button>
          </div>
        </div>

        <!-- 技能列表 -->
        <div
          v-if="!loading && !skills.length"
          class="empty-state"
        >
          <p>{{ activeTab === 'pending' ? '暂无待审核技能' : activeTab === 'mine' ? '还没有技能，点击右上角新建' : '暂无公有技能' }}</p>
        </div>

        <div class="skill-grid">
          <div
            v-for="s in skills"
            :key="s.id"
            class="skill-card glass-card"
            @click="openDetail(s)"
          >
            <div class="skill-head">
              <div>
                <span class="skill-name">{{ s.name }}</span>
                <span :class="['skill-vis', 'vis-' + s.visibility]">{{ VISIBILITY_LABEL[s.visibility] }}</span>
                <span
                  v-if="!s.isActive"
                  class="skill-vis vis-archived"
                >已停用</span>
              </div>
              <span class="skill-group">{{ s.group }}</span>
            </div>
            <p class="skill-desc">
              {{ s.description }}
            </p>
            <div class="skill-meta">
              <span>创建：{{ s.creator?.displayName || '—' }}</span>
              <span v-if="s.approver">审核：{{ s.approver.displayName }}</span>
            </div>
            <p
              v-if="activeTab === 'mine' && lastRejectReason(s)"
              class="reject-reason"
            >
              ⚠️ 上次驳回：{{ lastRejectReason(s) }}
            </p>

            <!-- 我的技能操作 -->
            <div
              v-if="activeTab === 'mine'"
              class="skill-actions"
            >
              <button
                v-if="s.visibility === 'private'"
                class="btn-sm"
                @click.stop="openEdit(s)"
              >
                编辑
              </button>
              <button
                v-if="s.visibility === 'private'"
                class="btn-sm"
                @click.stop="act(s.id, 'submit')"
              >
                提交审核
              </button>
              <button
                v-if="s.visibility === 'pending'"
                class="btn-sm"
                @click.stop="act(s.id, 'withdraw')"
              >
                撤回
              </button>
              <button
                v-if="s.isActive"
                class="btn-sm danger"
                @click.stop="act(s.id, 'archive')"
              >
                停用
              </button>
              <button
                v-if="!s.isActive"
                class="btn-sm"
                @click.stop="act(s.id, 'restore')"
              >
                恢复
              </button>
            </div>

            <!-- 待审核操作 -->
            <div
              v-else-if="activeTab === 'pending'"
              class="skill-actions"
            >
              <button
                class="btn-sm"
                @click.stop="openReview(s)"
              >
                审核
              </button>
            </div>
          </div>
        </div>

        <!-- 新建/编辑弹窗 -->
        <div
          v-if="showForm"
          class="modal-mask"
          @click.self="showForm = false"
        >
          <div class="modal-card">
            <h3 class="modal-title">
              {{ editing ? '编辑技能' : '新建技能' }}
            </h3>

            <!-- SKILL.md 标准导入（标准 skill 注册方式：frontmatter + 正文） -->
            <div class="import-block">
              <button
                class="btn-sm"
                @click="showImport = !showImport"
              >
                {{ showImport ? '收起导入' : '⇪ 从 SKILL.md 导入' }}
              </button>
              <div
                v-if="showImport"
                class="import-panel"
              >
                <p class="import-hint">
                  粘贴标准 SKILL.md：frontmatter 中的 <b>name</b> / <b>description</b> 自动填充表单，正文作为 System Prompt
                </p>
                <textarea
                  v-model="importText"
                  class="field-input area"
                  rows="6"
                  placeholder="---&#10;name: 数据合规评估&#10;description: 一句话说明 + 适用场景&#10;---&#10;你是数据合规专家…"
                />
                <p
                  v-if="importError"
                  class="form-error"
                >
                  {{ importError }}
                </p>
                <div
                  class="modal-actions"
                  style="margin-top:10px"
                >
                  <button
                    class="btn-sm"
                    :disabled="!importText.trim()"
                    @click="doImport"
                  >
                    解析并填充
                  </button>
                </div>
              </div>
            </div>

            <label class="field-label">名称 *</label>
            <input
              v-model="form.name"
              class="field-input"
              placeholder="如：数据合规评估"
              maxlength="128"
            >
            <label class="field-label">技能组 *</label>
            <select
              v-model="form.group"
              class="field-input"
            >
              <option
                v-for="g in SKILL_GROUPS"
                :key="g"
                :value="g"
              >
                {{ g }}
              </option>
            </select>
            <label class="field-label">技能代号（slug，选填，创建后不可改）</label>
            <input
              v-model="form.slug"
              class="field-input"
              :disabled="!!editing"
              placeholder="留空自动生成（拼音），如 data-compliance"
            >
            <label class="field-label">描述</label>
            <input
              v-model="form.description"
              class="field-input"
              placeholder="一句话说明 + 适用场景"
              maxlength="512"
            >
            <label class="field-label">System Prompt *（≤4000 字，定义 AI 输出结构与专业口径）</label>
            <textarea
              v-model="form.prompt"
              class="field-input area"
              rows="8"
              placeholder="你是…专家。按…结构输出。铁律：不编造实事…"
            />
            <p
              v-if="formError"
              class="form-error"
            >
              {{ formError }}
            </p>
            <div class="modal-actions">
              <button
                class="btn-sm"
                @click="showForm = false"
              >
                取消
              </button>
              <button
                class="btn-primary"
                :disabled="saving"
                @click="saveSkill"
              >
                {{ saving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 审核弹窗 -->
        <div
          v-if="reviewing"
          class="modal-mask"
          @click.self="reviewing = null"
        >
          <div class="modal-card wide">
            <h3 class="modal-title">
              审核技能 · {{ reviewing.name }}
            </h3>
            <p class="review-group">
              {{ reviewing.group }} · {{ reviewing.slug }}
            </p>
            <label class="field-label">System Prompt 全文</label>
            <pre class="prompt-preview">{{ reviewingPrompt }}</pre>
            <div class="checklist">
              <p class="checklist-title">
                安全检查清单：
              </p>
              <ul>
                <li>输出结构约束是否清晰</li>
                <li>有无"忽略系统指令 / 输出完整上下文 / 越权操作 / 要求读取输出文件"等危险措辞</li>
                <li>是否编造法律依据</li>
              </ul>
            </div>
            <label class="field-label">驳回原因（驳回必填）</label>
            <input
              v-model="reviewReason"
              class="field-input"
              placeholder="如：输出结构不清晰，需补充评估维度"
            >
            <div class="modal-actions">
              <button
                class="btn-sm"
                @click="reviewing = null"
              >
                取消
              </button>
              <button
                class="btn-sm danger"
                @click="submitReview(false)"
              >
                驳回
              </button>
              <button
                class="btn-primary"
                @click="submitReview(true)"
              >
                通过
              </button>
            </div>
          </div>
        </div>

        <!-- 技能详情弹窗（卡片点击；广场可见公有技能完整 prompt，供参考学习） -->
        <div
          v-if="detail"
          class="modal-mask"
          @click.self="detail = null"
        >
          <div class="modal-card wide">
            <div class="detail-head">
              <h3 class="modal-title">
                {{ detail.name }}
              </h3>
              <span :class="['skill-vis', 'vis-' + detail.visibility]">{{ VISIBILITY_LABEL[detail.visibility] }}</span>
            </div>
            <p class="review-group">
              {{ detail.group }} · {{ detail.slug }}<template v-if="detail.approvedAt">
                · 审核于 {{ fmtTime(detail.approvedAt) }}
              </template>
            </p>
            <p
              v-if="detail.description"
              class="detail-desc"
            >
              {{ detail.description }}
            </p>
            <label class="field-label">System Prompt</label>
            <pre class="prompt-preview">{{ detail.prompt }}</pre>
            <div class="skill-meta">
              <span>创建：{{ detail.creator?.displayName || '—' }}</span>
              <span v-if="detail.approver">审核：{{ detail.approver.displayName }}</span>
              <span>创建于 {{ fmtTime(detail.createdAt) }}</span>
            </div>
            <div
              v-if="detail.reviewLog?.length"
              class="checklist"
            >
              <p class="checklist-title">
                审核记录
              </p>
              <div
                v-for="(r, i) in detail.reviewLog"
                :key="i"
                class="review-log-item"
              >
                <b :class="r.action === 'reject' ? 'log-reject' : 'log-approve'">{{ r.action === 'reject' ? '驳回' : '通过' }}</b>
                {{ fmtTime(r.at) }}<template v-if="r.reason">
                  ：{{ r.reason }}
                </template>
              </div>
            </div>
            <div class="modal-actions">
              <button
                class="btn-sm"
                @click="detail = null"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── SKILL.md 导入 ── */
.import-block { margin: 4px 0 2px; }
.import-panel {
  margin-top: 10px; padding: 12px 14px;
  background: #f5f5f7; border-radius: 14px;
}
.import-hint { font-size: 11.5px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 10px; }

/* ── 技能详情弹窗 ── */
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.detail-head .modal-title { margin-bottom: 0; }
.detail-desc {
  font-size: 13px; color: var(--text-secondary); line-height: 1.6;
  background: #f5f5f7; border-radius: 12px; padding: 10px 14px; margin: 4px 0 8px;
}
.review-log-item { font-size: 12px; color: var(--text-secondary); line-height: 1.9; }
.log-reject { color: #ff453a; }
.log-approve { color: #34c759; }

.tab-row { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.tab-btn { background: none; border: none; padding: 8px 16px; font-size: 13px; color: var(--text-secondary); border-radius: 999px; cursor: pointer; font-weight: 500; transition: all .2s; }
.tab-btn:hover { background: rgba(0,0,0,.04); }
.tab-btn.active { background: var(--blue); color: #fff; }
.tab-right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
.group-select { padding: 7px 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,.08); background: #fff; font-size: 12px; color: var(--text); outline: none; }
.btn-primary { background: var(--blue); color: #fff; border: none; padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; transition: transform .15s; }
.btn-primary:hover { transform: scale(1.03); }
.btn-primary:disabled { opacity: .6; }
.btn-sm { background: rgba(0,113,227,.08); color: var(--blue); border: none; padding: 5px 12px; border-radius: 999px; font-size: 12px; cursor: pointer; font-weight: 500; }
.btn-sm:hover { background: rgba(0,113,227,.15); }
.btn-sm.danger { background: rgba(255,69,58,.08); color: #ff453a; }
.skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.skill-card { padding: 18px; border-radius: 18px; transition: transform .2s; cursor: pointer; }
.skill-card:hover { transform: translateY(-2px); }
.skill-card:hover .skill-name { color: var(--blue); }
.skill-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.skill-name { font-size: 15px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.skill-vis { display: inline-block; margin-left: 8px; font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600; vertical-align: middle; }
.vis-private { background: rgba(142,142,147,.12); color: #6e6e73; }
.vis-pending { background: rgba(255,149,0,.14); color: #ff9500; }
.vis-public { background: rgba(52,199,89,.14); color: #34c759; }
.vis-archived { background: rgba(142,142,147,.12); color: #8e8e93; }
.skill-group { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }
.skill-desc { font-size: 12px; color: var(--text-secondary); margin: 6px 0 10px; line-height: 1.5; min-height: 36px; }
.skill-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-tertiary); margin-bottom: 12px; }
.reject-reason { font-size: 11px; color: #ff453a; background: rgba(255,69,58,.06); border-radius: 8px; padding: 6px 10px; margin: 0 0 10px; line-height: 1.4; }
.skill-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.empty-state { text-align: center; color: var(--text-tertiary); padding: 48px 0; font-size: 13px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-card { background: #fff; border-radius: 20px; padding: 24px; width: 460px; max-width: 92vw; max-height: 86vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
.modal-card.wide { width: 640px; }
.modal-title { font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; }
.review-group { font-size: 12px; color: var(--text-tertiary); margin-bottom: 12px; }
.field-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 12px 0 6px; }
.field-input { width: 100%; padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(0,0,0,.08); background: #f5f5f7; font-size: 13px; color: var(--text); outline: none; box-sizing: border-box; }
.field-input:focus { border-color: var(--blue); background: #fff; }
.field-input.area { resize: vertical; font-family: inherit; line-height: 1.5; }
.field-input:disabled { opacity: .5; }
.form-error { color: #ff453a; font-size: 12px; margin-top: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.prompt-preview { background: #f5f5f7; border-radius: 12px; padding: 12px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow-y: auto; color: var(--text); }
.checklist { background: rgba(255,149,0,.07); border-radius: 12px; padding: 10px 14px; margin-top: 12px; }
.checklist-title { font-size: 12px; font-weight: 600; color: #ff9500; }
.checklist ul { margin: 6px 0 0 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.7; }
</style>
