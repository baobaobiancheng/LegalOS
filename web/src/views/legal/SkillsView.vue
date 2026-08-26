<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { RequestError, request } from '../../api/client'
import ErrorState from '../../components/ErrorState.vue'
import LegalWorkspaceLayout from '../../components/LegalWorkspaceLayout.vue'
import { useAuthStore } from '../../stores/auth'
import type { Skill } from '../../types'
import { SKILL_GROUPS, SKILL_PROMPT_MAX_LENGTH, lastRejectReason } from '../../types'

gsap.registerPlugin(ScrollTrigger)

type SkillTab = 'public' | 'mine' | 'pending'

const auth = useAuthStore()
const pageRoot = ref<HTMLElement | null>(null)
const activeTab = ref<SkillTab>('public')
const scopeSkills = reactive<Record<SkillTab, Skill[]>>({ public: [], mine: [], pending: [] })
const loading = ref(false)
const groupFilter = ref('')
const searchQuery = ref('')
const submittedSearch = ref('')
const listError = ref<RequestError | null>(null)
const actionError = ref<RequestError | null>(null)
const actingId = ref('')
let animationContext: gsap.Context | null = null

const isLead = computed(() => ['legal_lead', 'admin'].includes(auth.user?.role || ''))
const skills = computed(() => scopeSkills[activeTab.value])
const tabs = computed<Array<{ key: SkillTab; label: string }>>(() => [
  { key: 'public', label: '技能广场' },
  { key: 'mine', label: '我的技能' },
  ...(isLead.value ? [{ key: 'pending' as const, label: '待审核' }] : []),
])
const tabCounts = computed<Record<SkillTab, number>>(() => ({
  public: scopeSkills.public.length,
  mine: scopeSkills.mine.length,
  pending: scopeSkills.pending.length,
}))
const categories = computed(() => [
  { value: '', label: '全部', count: skills.value.length },
  ...SKILL_GROUPS.map(group => ({
    value: group,
    label: group,
    count: skills.value.filter(skill => skill.group === group).length,
  })),
])
const visibleSkills = computed(() => {
  const keyword = submittedSearch.value.trim().toLocaleLowerCase('zh-CN')
  return skills.value.filter((skill) => {
    const matchesGroup = !groupFilter.value || skill.group === groupFilter.value
    const matchesSearch = !keyword || [skill.name, skill.description, skill.group, skill.slug]
      .some(value => value?.toLocaleLowerCase('zh-CN').includes(keyword))
    return matchesGroup && matchesSearch
  })
})
const emptyMessage = computed(() => {
  if (skills.value.length && !visibleSkills.value.length) return '没有找到符合当前条件的技能'
  if (activeTab.value === 'pending') return '暂无待审核技能'
  if (activeTab.value === 'mine') return '还没有技能，点击“新建技能”开始沉淀团队方法'
  return '暂无公有技能'
})

const VISIBILITY_LABEL: Record<string, string> = { private: '私有', pending: '待审核', public: '公有' }
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function toRequestError(error: unknown, fallback: string) {
  return error instanceof RequestError
    ? error
    : new RequestError({ error: fallback, code: 'UNKNOWN', statusCode: 0 })
}

async function animateCards() {
  if (reducedMotion()) return
  await nextTick()
  animationContext?.add(() => {
    gsap.fromTo(
      '.skill-card',
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: 0.44, stagger: 0.055, ease: 'power2.out', overwrite: true },
    )
  })
  ScrollTrigger.refresh()
}

async function fetchAllScopes() {
  loading.value = true
  listError.value = null
  try {
    const scopes: SkillTab[] = isLead.value ? ['public', 'mine', 'pending'] : ['public', 'mine']
    const results = await Promise.all(scopes.map(async scope => ({
      scope,
      items: await request<Skill[]>(`/skills?scope=${scope}`),
    })))
    results.forEach(({ scope, items }) => { scopeSkills[scope] = items })
    if (!isLead.value) scopeSkills.pending = []
  } catch (error) {
    listError.value = toRequestError(error, '技能列表加载失败，请重试')
  } finally {
    loading.value = false
  }
  if (!listError.value) await animateCards()
}

async function switchTab(tab: SkillTab) {
  if (tab === activeTab.value) return
  activeTab.value = tab
  groupFilter.value = ''
  searchQuery.value = ''
  submittedSearch.value = ''
  await animateCards()
}

function selectGroup(group: string) {
  groupFilter.value = group
  void animateCards()
}

function submitSearch() {
  submittedSearch.value = searchQuery.value.trim()
  void animateCards()
}

function clearSearch() {
  searchQuery.value = ''
  submittedSearch.value = ''
  void animateCards()
}

const showForm = ref(false)
const editing = ref<Skill | null>(null)
const form = ref({ slug: '', name: '', group: '合规法务', description: '', prompt: '' })
const formError = ref('')
const saving = ref(false)
const showImport = ref(false)
const importText = ref('')
const importError = ref('')

function openCreate() {
  editing.value = null
  form.value = { slug: '', name: '', group: '合规法务', description: '', prompt: '' }
  formError.value = ''
  showImport.value = false
  importText.value = ''
  importError.value = ''
  showForm.value = true
}

function openEdit(skill: Skill) {
  editing.value = skill
  form.value = {
    slug: skill.slug,
    name: skill.name,
    group: skill.group,
    description: skill.description,
    prompt: skill.prompt || '',
  }
  formError.value = ''
  showImport.value = false
  showForm.value = true
}

const parseSkillMd = (text: string): { name: string; description: string; prompt: string } => {
  const lines = text.replace(/^﻿/, '').split('\n')
  const first = lines.findIndex(line => line.trim() === '---')
  if (first < 0) throw new Error('不是有效的 SKILL.md：缺少 frontmatter 起始分隔符 ---')
  const end = lines.findIndex((line, index) => index > first && line.trim() === '---')
  if (end < 0) throw new Error('不是有效的 SKILL.md：缺少 frontmatter 结束分隔符 ---')
  const frontmatter: Record<string, string> = {}
  for (let index = first + 1; index < end; index++) {
    const match = lines[index].match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (match) frontmatter[match[1].toLowerCase()] = match[2].trim()
  }
  const prompt = lines.slice(end + 1).join('\n').trim()
  if (!prompt) throw new Error('SKILL.md 正文（System Prompt）为空')
  if (prompt.length > SKILL_PROMPT_MAX_LENGTH) {
    throw new Error(`prompt 超过 ${SKILL_PROMPT_MAX_LENGTH} 字上限，请精简后导入`)
  }
  return {
    name: frontmatter.name || frontmatter.title || '',
    description: frontmatter.description || '',
    prompt,
  }
}

function doImport() {
  importError.value = ''
  try {
    const parsed = parseSkillMd(importText.value)
    if (!parsed.name) throw new Error('frontmatter 缺少 name 字段，请补充后重试')
    form.value.name = parsed.name
    form.value.description = parsed.description
    form.value.prompt = parsed.prompt
    if (!editing.value) form.value.slug = ''
    showImport.value = false
    importText.value = ''
  } catch (error) {
    importError.value = error instanceof Error ? error.message : '解析失败'
  }
}

async function saveSkill() {
  if (!form.value.name.trim() || !form.value.prompt.trim()) {
    formError.value = '名称与 System Prompt 必填'
    return
  }
  if (form.value.prompt.length > SKILL_PROMPT_MAX_LENGTH) {
    formError.value = `System Prompt 不能超过 ${SKILL_PROMPT_MAX_LENGTH} 字`
    return
  }
  saving.value = true
  formError.value = ''
  actionError.value = null
  const isCreating = !editing.value
  try {
    if (editing.value) {
      await request(`/skills/${editing.value.id}`, {
        method: 'PUT',
        body: {
          name: form.value.name.trim(),
          group: form.value.group,
          description: form.value.description.trim(),
          prompt: form.value.prompt,
        },
      })
    } else {
      await request('/skills', {
        method: 'POST',
        body: {
          slug: form.value.slug.trim() || undefined,
          name: form.value.name.trim(),
          group: form.value.group,
          description: form.value.description.trim(),
          prompt: form.value.prompt,
        },
      })
    }
    showForm.value = false
    if (isCreating) activeTab.value = 'mine'
    groupFilter.value = ''
    searchQuery.value = ''
    submittedSearch.value = ''
    await fetchAllScopes()
  } catch (error) {
    actionError.value = toRequestError(error, '保存失败，请重试')
    formError.value = actionError.value.payload.error
  } finally {
    saving.value = false
  }
}

async function act(id: string, action: 'submit' | 'withdraw' | 'archive' | 'restore') {
  actingId.value = id
  actionError.value = null
  try {
    await request(`/skills/${id}/${action}`, { method: 'POST' })
    await fetchAllScopes()
  } catch (error) {
    actionError.value = toRequestError(error, '操作失败，请重试')
  } finally {
    actingId.value = ''
  }
}

const reviewing = ref<Skill | null>(null)
const reviewReason = ref('')
const reviewError = ref('')
const reviewingPrompt = ref('')
const reviewingBusy = ref(false)

async function openReview(skill: Skill) {
  reviewing.value = skill
  reviewReason.value = ''
  reviewError.value = ''
  reviewingPrompt.value = ''
  try {
    const result = await request<Skill>(`/skills/${skill.id}`)
    reviewingPrompt.value = result.prompt || ''
  } catch (error) {
    actionError.value = toRequestError(error, '审核详情加载失败，请重试')
    reviewingPrompt.value = skill.prompt || ''
  }
}

async function submitReview(approved: boolean) {
  if (!reviewing.value) return
  if (!approved && !reviewReason.value.trim()) {
    reviewError.value = '驳回必须填写原因'
    return
  }
  reviewingBusy.value = true
  reviewError.value = ''
  actionError.value = null
  try {
    await request(`/skills/${reviewing.value.id}/review`, {
      method: 'POST',
      body: { approved, reason: reviewReason.value.trim() || undefined },
    })
    reviewing.value = null
    await fetchAllScopes()
  } catch (error) {
    actionError.value = toRequestError(error, '审核失败，请重试')
  } finally {
    reviewingBusy.value = false
  }
}

const detail = ref<Skill | null>(null)
const detailLoading = ref(false)

async function openDetail(skill: Skill) {
  detail.value = skill
  detailLoading.value = true
  actionError.value = null
  try {
    detail.value = await request<Skill>(`/skills/${skill.id}`)
  } catch (error) {
    actionError.value = toRequestError(error, '技能详情加载失败，请重试')
    detail.value = { ...skill, prompt: 'System Prompt 加载失败，请重试。' }
  } finally {
    detailLoading.value = false
  }
}

function fmtTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

onMounted(async () => {
  if (pageRoot.value) {
    animationContext = gsap.context(() => {
      if (reducedMotion()) return
      gsap.from('.skills-heading > *', {
        autoAlpha: 0,
        y: 18,
        duration: 0.58,
        stagger: 0.075,
        ease: 'power2.out',
      })
      gsap.from('.skills-toolbar > *', {
        autoAlpha: 0,
        y: 14,
        duration: 0.48,
        stagger: 0.06,
        delay: 0.14,
        ease: 'power2.out',
      })
      gsap.fromTo(
        '.catalog-helper span',
        { autoAlpha: 0.35 },
        {
          autoAlpha: 1,
          stagger: 0.12,
          ease: 'none',
          scrollTrigger: {
            trigger: '.skill-catalog',
            start: 'top 82%',
            end: 'top 48%',
            scrub: 0.45,
          },
        },
      )
    }, pageRoot.value)
  }
  await fetchAllScopes()
})

onBeforeUnmount(() => animationContext?.revert())
</script>

<template>
  <LegalWorkspaceLayout active-key="skills">
    <div
      ref="pageRoot"
      class="skills-page"
    >
      <header class="skills-heading">
        <p class="breadcrumb">
          法务工作台 <span>/</span> 技能库
        </p>
        <div class="heading-row">
          <div class="heading-copy">
            <h1>技能库</h1>
            <span class="heading-divider" />
            <p>沉淀可复用的法务方法，让专业能力在团队中流动</p>
          </div>
          <button
            class="create-button"
            type="button"
            @click="openCreate"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              aria-hidden="true"
            ><path d="M12 5v14M5 12h14" /></svg>
            新建技能
          </button>
        </div>
      </header>

      <div class="skills-toolbar">
        <nav
          class="skill-tabs"
          :style="{ '--tab-count': tabs.length }"
          aria-label="技能范围"
        >
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            :class="{ active: activeTab === tab.key }"
            :aria-current="activeTab === tab.key ? 'page' : undefined"
            @click="switchTab(tab.key)"
          >
            <span>{{ tab.label }}</span>
            <strong>{{ tabCounts[tab.key] }}</strong>
          </button>
        </nav>

        <form
          class="search-row"
          role="search"
          @submit.prevent="submitSearch"
        >
          <label class="search-field">
            <span class="sr-only">搜索技能</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              aria-hidden="true"
            ><circle
              cx="11"
              cy="11"
              r="7"
            /><path d="m20 20-4-4" /></svg>
            <input
              v-model="searchQuery"
              type="search"
              placeholder="搜索技能名称、描述或适用场景"
            >
            <button
              v-if="searchQuery"
              class="clear-search"
              type="button"
              aria-label="清空搜索"
              @click="clearSearch"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              ><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </label>
          <label class="group-select-wrap">
            <span class="sr-only">选择技能组</span>
            <select v-model="groupFilter">
              <option value="">全部技能组</option>
              <option
                v-for="group in SKILL_GROUPS"
                :key="group"
                :value="group"
              >
                {{ group }}
              </option>
            </select>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><path d="m7 10 5 5 5-5" /></svg>
          </label>
          <button
            class="search-button"
            type="submit"
          >
            搜索
          </button>
        </form>

        <nav
          class="category-rail"
          aria-label="技能分组"
        >
          <button
            v-for="category in categories"
            :key="category.value || 'all'"
            type="button"
            :class="{ active: groupFilter === category.value }"
            @click="selectGroup(category.value)"
          >
            <span>{{ category.label }}</span>
            <strong>{{ category.count }}</strong>
            <svg
              v-if="category.value"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><path d="m8 10 4 4 4-4" /></svg>
          </button>
        </nav>
      </div>

      <ErrorState
        v-if="listError || actionError"
        :message="(listError || actionError)!.payload.error"
        :request-id="(listError || actionError)!.payload.requestId"
        :on-retry="listError ? fetchAllScopes : undefined"
      />

      <section
        v-if="!listError"
        class="skill-catalog"
      >
        <div class="catalog-heading">
          <h2>{{ activeTab === 'public' ? '精选技能' : activeTab === 'mine' ? '我的技能' : '待审核技能' }}</h2>
          <p class="catalog-helper">
            <span>选择技能进入详情，</span>
            <span>查看专业口径与 </span>
            <span>System Prompt</span>
          </p>
        </div>

        <div
          v-if="loading"
          class="skill-grid"
          aria-label="正在加载技能"
        >
          <div
            v-for="index in 6"
            :key="index"
            class="skill-card skeleton-card"
          >
            <span class="skeleton icon" /><span class="skeleton title" /><span class="skeleton line" /><span class="skeleton line short" /><span class="skeleton footer" />
          </div>
        </div>

        <div
          v-else-if="!visibleSkills.length"
          class="empty-state"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><path d="M6 3h9l3 3v15H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></svg>
          <p>{{ emptyMessage }}</p>
          <button
            v-if="submittedSearch || groupFilter"
            type="button"
            @click="groupFilter = ''; clearSearch()"
          >
            清除筛选
          </button>
        </div>

        <div
          v-else
          class="skill-grid"
        >
          <article
            v-for="skill in visibleSkills"
            :key="skill.id"
            class="skill-card"
            tabindex="0"
            role="button"
            :aria-label="`查看技能：${skill.name}`"
            @click="openDetail(skill)"
            @keydown.enter="openDetail(skill)"
            @keydown.space.prevent="openDetail(skill)"
          >
            <div class="skill-card-top">
              <span class="document-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                ><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 12h6M9 16h5" /></svg>
              </span>
              <div class="skill-title-block">
                <h3>{{ skill.name }}</h3>
                <div class="skill-labels">
                  <span class="skill-group">{{ skill.group }}</span>
                  <span :class="['visibility-badge', `vis-${skill.visibility}`]">{{ VISIBILITY_LABEL[skill.visibility] }}</span>
                  <span
                    v-if="!skill.isActive"
                    class="visibility-badge vis-archived"
                  >已停用</span>
                </div>
              </div>
            </div>

            <p class="skill-description">
              {{ skill.description || '该技能暂未填写说明，进入详情可查看专业口径与完整 System Prompt。' }}
            </p>

            <p
              v-if="activeTab === 'mine' && lastRejectReason(skill)"
              class="reject-reason"
            >
              <strong>上次驳回</strong>{{ lastRejectReason(skill) }}
            </p>

            <div class="skill-footer">
              <span>创建：{{ skill.creator?.displayName || '—' }}</span>
              <div
                v-if="activeTab === 'mine'"
                class="skill-actions"
                @click.stop
              >
                <button
                  v-if="skill.visibility === 'private'"
                  type="button"
                  :disabled="actingId === skill.id"
                  @click="openEdit(skill)"
                >
                  编辑
                </button>
                <button
                  v-if="skill.visibility === 'private'"
                  type="button"
                  :disabled="actingId === skill.id"
                  @click="act(skill.id, 'submit')"
                >
                  提交审核
                </button>
                <button
                  v-if="skill.visibility === 'pending'"
                  type="button"
                  :disabled="actingId === skill.id"
                  @click="act(skill.id, 'withdraw')"
                >
                  撤回
                </button>
                <button
                  v-if="skill.isActive"
                  class="danger"
                  type="button"
                  :disabled="actingId === skill.id"
                  @click="act(skill.id, 'archive')"
                >
                  停用
                </button>
                <button
                  v-else
                  type="button"
                  :disabled="actingId === skill.id"
                  @click="act(skill.id, 'restore')"
                >
                  恢复
                </button>
              </div>
              <button
                v-else-if="activeTab === 'pending'"
                class="review-button"
                type="button"
                @click.stop="openReview(skill)"
              >
                审核
              </button>
              <svg
                v-else
                class="open-arrow"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="M5 12h14M14 7l5 5-5 5" /></svg>
            </div>
          </article>
        </div>
      </section>

      <div
        v-if="showForm"
        class="modal-mask"
        role="presentation"
        @click.self="showForm = false"
      >
        <section
          class="modal-card"
          role="dialog"
          aria-modal="true"
          :aria-label="editing ? '编辑技能' : '新建技能'"
        >
          <div class="modal-heading">
            <div>
              <p>技能配置</p>
              <h2>{{ editing ? '编辑技能' : '新建技能' }}</h2>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="关闭"
              @click="showForm = false"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              ><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </div>

          <div class="import-block">
            <button
              class="secondary-button"
              type="button"
              @click="showImport = !showImport"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 15v5h14v-5" /></svg>
              {{ showImport ? '收起导入' : '从 SKILL.md 导入' }}
            </button>
            <div
              v-if="showImport"
              class="import-panel"
            >
              <p>粘贴标准 SKILL.md：frontmatter 中的 name / description 自动填充表单，正文作为 System Prompt。</p>
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
              <div class="import-actions">
                <button
                  class="secondary-button"
                  type="button"
                  :disabled="!importText.trim()"
                  @click="doImport"
                >
                  解析并填充
                </button>
              </div>
            </div>
          </div>

          <div class="form-grid">
            <label class="field-label">
              <span>名称 <b>*</b></span>
              <input
                v-model="form.name"
                class="field-input"
                placeholder="如：数据合规评估"
                maxlength="128"
              >
            </label>
            <label class="field-label">
              <span>技能组 <b>*</b></span>
              <select
                v-model="form.group"
                class="field-input"
              >
                <option
                  v-for="group in SKILL_GROUPS"
                  :key="group"
                  :value="group"
                >{{ group }}</option>
              </select>
            </label>
          </div>
          <label class="field-label">
            <span>技能代号 <small>选填，创建后不可修改</small></span>
            <input
              v-model="form.slug"
              class="field-input"
              :disabled="!!editing"
              placeholder="留空自动生成，如 data-compliance"
            >
          </label>
          <label class="field-label">
            <span>描述</span>
            <input
              v-model="form.description"
              class="field-input"
              placeholder="一句话说明能力范围与适用场景"
              maxlength="512"
            >
          </label>
          <label class="field-label">
            <span>System Prompt <b>*</b><small>不超过 4000 字</small></span>
            <textarea
              v-model="form.prompt"
              class="field-input area"
              rows="8"
              placeholder="定义 AI 的专业身份、输出结构与边界。"
            />
          </label>
          <p
            v-if="formError"
            class="form-error"
          >
            {{ formError }}
          </p>
          <div class="modal-actions">
            <button
              class="secondary-button"
              type="button"
              @click="showForm = false"
            >
              取消
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="saving"
              @click="saveSkill"
            >
              {{ saving ? '保存中…' : '保存技能' }}
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="reviewing"
        class="modal-mask"
        role="presentation"
        @click.self="reviewing = null"
      >
        <section
          class="modal-card wide"
          role="dialog"
          aria-modal="true"
          aria-label="审核技能"
        >
          <div class="modal-heading">
            <div>
              <p>{{ reviewing.group }} · {{ reviewing.slug }}</p>
              <h2>审核技能 · {{ reviewing.name }}</h2>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="关闭"
              @click="reviewing = null"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              ><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </div>
          <label class="field-label">
            <span>System Prompt 全文</span>
            <pre class="prompt-preview">{{ reviewingPrompt || '正在加载…' }}</pre>
          </label>
          <div class="review-checklist">
            <strong>安全检查清单</strong>
            <ul>
              <li>输出结构约束是否清晰</li>
              <li>是否包含忽略系统指令、输出完整上下文或越权操作等危险措辞</li>
              <li>是否存在编造法律依据的风险</li>
            </ul>
          </div>
          <label class="field-label">
            <span>驳回原因 <small>驳回时必填</small></span>
            <input
              v-model="reviewReason"
              class="field-input"
              placeholder="如：输出结构不清晰，需补充评估维度"
            >
          </label>
          <p
            v-if="reviewError"
            class="form-error"
          >
            {{ reviewError }}
          </p>
          <div class="modal-actions">
            <button
              class="secondary-button"
              type="button"
              :disabled="reviewingBusy"
              @click="reviewing = null"
            >
              取消
            </button>
            <button
              class="danger-button"
              type="button"
              :disabled="reviewingBusy"
              @click="submitReview(false)"
            >
              驳回
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="reviewingBusy"
              @click="submitReview(true)"
            >
              通过
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="detail"
        class="modal-mask"
        role="presentation"
        @click.self="detail = null"
      >
        <section
          class="modal-card wide"
          role="dialog"
          aria-modal="true"
          aria-label="技能详情"
        >
          <div class="modal-heading detail-heading">
            <div>
              <p>{{ detail.group }} · {{ detail.slug }}</p>
              <h2>{{ detail.name }}</h2>
            </div>
            <div class="detail-heading-actions">
              <span :class="['visibility-badge', `vis-${detail.visibility}`]">{{ VISIBILITY_LABEL[detail.visibility] }}</span>
              <button
                class="icon-button"
                type="button"
                aria-label="关闭"
                @click="detail = null"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  aria-hidden="true"
                ><path d="m7 7 10 10M17 7 7 17" /></svg>
              </button>
            </div>
          </div>
          <p
            v-if="detail.description"
            class="detail-description"
          >
            {{ detail.description }}
          </p>
          <label class="field-label">
            <span>System Prompt</span>
            <pre class="prompt-preview">{{ detailLoading ? '正在加载…' : detail.prompt }}</pre>
          </label>
          <div class="detail-meta">
            <span>创建：{{ detail.creator?.displayName || '—' }}</span>
            <span v-if="detail.approver">审核：{{ detail.approver.displayName }}</span>
            <span>创建于 {{ fmtTime(detail.createdAt) }}</span>
            <span v-if="detail.approvedAt">审核于 {{ fmtTime(detail.approvedAt) }}</span>
          </div>
          <div
            v-if="detail.reviewLog?.length"
            class="review-history"
          >
            <strong>审核记录</strong>
            <p
              v-for="(log, index) in detail.reviewLog"
              :key="index"
            >
              <b :class="log.action === 'reject' ? 'log-reject' : 'log-approve'">{{ log.action === 'reject' ? '驳回' : '通过' }}</b>
              {{ fmtTime(log.at) }}<template v-if="log.reason">
                ：{{ log.reason }}
              </template>
            </p>
          </div>
          <div class="modal-actions">
            <button
              class="secondary-button"
              type="button"
              @click="detail = null"
            >
              关闭
            </button>
          </div>
        </section>
      </div>
    </div>
  </LegalWorkspaceLayout>
</template>

<style scoped>
.skills-page {
  --skill-blue: #0B63F6;
  --skill-blue-soft: #EDF4FF;
  --skill-ink: #10182B;
  --skill-body: #344158;
  --skill-muted: #718096;
  --skill-border: #DCE3EC;
  min-height: 100vh;
  padding: 30px 44px 56px;
  background:
    radial-gradient(circle at 84% 2%, rgba(37, 99, 235, 0.035), transparent 28%),
    #F7F8FA;
  color: var(--skill-ink);
}

.breadcrumb {
  margin: 0 0 22px;
  color: #65738A;
  font-size: 14px;
  font-weight: 520;
}

.breadcrumb span { margin: 0 14px; color: #A0AABD; }
.heading-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; }
.heading-copy { display: flex; min-width: 0; align-items: center; gap: 20px; }
.heading-copy h1 { margin: 0; color: var(--skill-ink); font-size: 44px; font-weight: 720; letter-spacing: -0.045em; line-height: 1; }
.heading-divider { width: 1px; height: 38px; flex: 0 0 auto; background: #C9D1DE; }
.heading-copy p { margin: 0; color: #617089; font-size: 16px; line-height: 1.6; }

.create-button,
.primary-button {
  display: inline-flex;
  min-height: 48px;
  padding: 0 20px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid var(--skill-blue);
  border-radius: 7px;
  background: var(--skill-blue);
  color: #FFFFFF;
  font: inherit;
  font-size: 14px;
  font-weight: 680;
  transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
}

.create-button svg { width: 20px; height: 20px; }
.create-button:hover, .primary-button:hover { border-color: #0854D1; background: #0854D1; transform: translateY(-1px); }
.create-button:active, .primary-button:active { transform: scale(0.98); }
.create-button:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid rgba(11, 99, 246, 0.18); outline-offset: 2px; }

.skills-toolbar { display: grid; margin-top: 30px; gap: 24px; }
.skill-tabs {
  display: grid;
  min-height: 64px;
  grid-template-columns: repeat(var(--tab-count), minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--skill-border);
  border-radius: 7px;
  background: #FFFFFF;
}

.skill-tabs button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 0;
  border-right: 1px solid var(--skill-border);
  background: transparent;
  color: #46536B;
  font: inherit;
  font-size: 16px;
  font-weight: 520;
}

.skill-tabs button:last-child { border-right: 0; }
.skill-tabs button::after { position: absolute; inset: auto 0 0; height: 3px; background: transparent; content: ""; }
.skill-tabs button:hover { background: #FAFCFF; color: var(--skill-blue); }
.skill-tabs button.active { color: var(--skill-blue); font-weight: 680; }
.skill-tabs button.active::after { background: var(--skill-blue); }
.skill-tabs strong { font-size: 15px; font-weight: 650; }

.search-row { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(220px, 330px) 140px; gap: 16px; }
.search-field, .group-select-wrap { position: relative; display: flex; min-height: 54px; align-items: center; border: 1px solid var(--skill-border); border-radius: 7px; background: #FFFFFF; color: #60708A; }
.search-field:focus-within, .group-select-wrap:focus-within { border-color: var(--skill-blue); box-shadow: 0 0 0 3px rgba(11, 99, 246, 0.08); }
.search-field > svg { width: 21px; height: 21px; margin-left: 17px; flex: 0 0 auto; }
.search-field input, .group-select-wrap select { width: 100%; min-width: 0; height: 52px; padding: 0 15px; border: 0; outline: 0; background: transparent; color: var(--skill-ink); font: inherit; font-size: 14px; }
.search-field input::placeholder { color: #8A96A9; }
.search-field input::-webkit-search-cancel-button { display: none; }
.clear-search { display: grid; width: 36px; height: 36px; margin-right: 8px; padding: 0; border: 0; border-radius: 5px; place-items: center; flex: 0 0 auto; background: transparent; color: #78869A; }
.clear-search:hover { background: #F1F5F9; color: var(--skill-blue); }
.clear-search svg { width: 17px; height: 17px; }
.group-select-wrap select { padding-right: 44px; appearance: none; cursor: pointer; }
.group-select-wrap > svg { position: absolute; right: 17px; width: 18px; height: 18px; pointer-events: none; }
.search-button { min-height: 54px; border: 1px solid var(--skill-blue); border-radius: 7px; background: #FFFFFF; color: var(--skill-blue); font: inherit; font-size: 14px; font-weight: 680; }
.search-button:hover { background: var(--skill-blue-soft); }
.search-button:active { transform: scale(0.98); }

.category-rail {
  position: sticky;
  top: 14px;
  z-index: 5;
  display: grid;
  min-height: 66px;
  grid-template-columns: repeat(7, minmax(126px, 1fr));
  overflow-x: auto;
  border: 1px solid var(--skill-border);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.96);
  scrollbar-width: thin;
}

.category-rail button {
  position: relative;
  display: flex;
  min-width: 126px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 0;
  background: transparent;
  color: #30405A;
  font: inherit;
  font-size: 14px;
  font-weight: 520;
  white-space: nowrap;
}

.category-rail button::after { position: absolute; inset: auto calc(50% - 10px) -1px; width: 20px; height: 10px; border: solid transparent; border-width: 0 10px 10px; content: ""; }
.category-rail button:hover { background: #FAFCFF; color: var(--skill-blue); }
.category-rail button.active { color: var(--skill-blue); font-weight: 680; }
.category-rail button.active::after { border-bottom-color: var(--skill-blue); }
.category-rail strong { color: inherit; font-size: 14px; font-weight: 650; }
.category-rail svg { width: 16px; height: 16px; }

.skill-catalog { margin-top: 32px; }
.catalog-heading { display: flex; margin-bottom: 20px; align-items: baseline; gap: 24px; }
.catalog-heading h2 { margin: 0; color: var(--skill-ink); font-size: 24px; font-weight: 720; letter-spacing: -0.03em; }
.catalog-heading p { margin: 0; color: #7A879A; font-size: 13px; }
.skill-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.skill-card {
  display: flex;
  min-width: 0;
  min-height: 220px;
  padding: 22px 18px 17px;
  flex-direction: column;
  border: 1px solid var(--skill-border);
  border-radius: 8px;
  background: #FFFFFF;
  transition: border-color 170ms ease, transform 170ms ease, box-shadow 170ms ease;
}

.skill-card:hover, .skill-card:focus-visible { border-color: var(--skill-blue); box-shadow: 0 8px 24px rgba(24, 54, 98, 0.07); transform: translateY(-2px); }
.skill-card-top { display: flex; min-width: 0; align-items: flex-start; gap: 14px; }
.document-icon { display: grid; width: 44px; height: 44px; border-radius: 7px; place-items: center; flex: 0 0 auto; background: var(--skill-blue-soft); color: var(--skill-blue); }
.document-icon svg { width: 25px; height: 25px; }
.skill-title-block { min-width: 0; padding-top: 1px; }
.skill-title-block h3 { overflow: hidden; margin: 0 0 7px; color: var(--skill-ink); font-size: 17px; font-weight: 700; letter-spacing: -0.015em; text-overflow: ellipsis; white-space: nowrap; }
.skill-labels { display: flex; min-width: 0; align-items: center; gap: 10px; }
.skill-group { overflow: hidden; color: #68778F; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.visibility-badge { display: inline-flex; min-height: 23px; padding: 0 8px; align-items: center; border-radius: 4px; font-size: 12px; font-weight: 650; white-space: nowrap; }
.vis-public { background: #E8F7EE; color: #248A4B; }
.vis-private { background: #EEF2F7; color: #536177; }
.vis-pending { background: #FFF4E3; color: #B56A04; }
.vis-archived { background: #F1F2F4; color: #7A818D; }
.skill-description { display: -webkit-box; min-height: 66px; overflow: hidden; margin: 22px 0 14px; color: #344158; font-size: 14px; line-height: 1.72; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.reject-reason { margin: -5px 0 12px; padding: 8px 10px; border-left: 2px solid #D64545; background: #FFF7F7; color: #8F3E3E; font-size: 12px; line-height: 1.55; }
.reject-reason strong { margin-right: 7px; }
.skill-footer { display: flex; min-height: 30px; margin-top: auto; padding-top: 14px; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid #E8EDF3; color: #7A879B; font-size: 12px; }
.open-arrow { width: 20px; height: 20px; color: #14213A; transition: transform 170ms ease, color 170ms ease; }
.skill-card:hover .open-arrow { color: var(--skill-blue); transform: translateX(3px); }
.skill-actions { display: flex; min-width: 0; justify-content: flex-end; gap: 5px; flex-wrap: wrap; }
.skill-actions button, .review-button { min-height: 28px; padding: 0 8px; border: 1px solid #C9D7EA; border-radius: 5px; background: #FFFFFF; color: var(--skill-blue); font: inherit; font-size: 11px; font-weight: 620; }
.skill-actions button:hover, .review-button:hover { border-color: var(--skill-blue); background: var(--skill-blue-soft); }
.skill-actions button.danger { border-color: #F0C9C9; color: #B43D3D; }
.skill-actions button:disabled, .review-button:disabled { cursor: wait; opacity: 0.55; }

.empty-state { display: grid; min-height: 280px; place-items: center; align-content: center; gap: 12px; border: 1px dashed #CCD5E2; background: rgba(255, 255, 255, 0.5); color: #718096; text-align: center; }
.empty-state svg { width: 38px; height: 38px; color: #9AA6B8; }
.empty-state p { margin: 0; font-size: 14px; }
.empty-state button { border: 0; background: transparent; color: var(--skill-blue); font: inherit; font-size: 13px; font-weight: 650; }

.skeleton-card { position: relative; display: block; pointer-events: none; }
.skeleton { display: block; border-radius: 5px; background: linear-gradient(90deg, #EEF1F5 25%, #F8F9FB 50%, #EEF1F5 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; }
.skeleton.icon { width: 44px; height: 44px; }
.skeleton.title { position: absolute; top: 24px; left: 78px; width: 38%; height: 18px; }
.skeleton.line { width: 86%; height: 12px; margin-top: 28px; }
.skeleton.line.short { width: 64%; margin-top: 12px; }
.skeleton.footer { width: 100%; height: 1px; margin-top: 48px; }

.modal-mask { position: fixed; inset: 0; z-index: 100; display: grid; padding: 28px; place-items: center; background: rgba(15, 23, 42, 0.42); backdrop-filter: blur(5px); }
.modal-card { width: min(590px, 100%); max-height: min(860px, calc(100vh - 56px)); overflow-y: auto; padding: 28px; border: 1px solid #DCE3EC; border-radius: 12px; background: #FFFFFF; box-shadow: 0 24px 70px rgba(15, 23, 42, 0.2); }
.modal-card.wide { width: min(760px, 100%); }
.modal-heading { display: flex; margin-bottom: 24px; align-items: flex-start; justify-content: space-between; gap: 18px; }
.modal-heading p { margin: 0 0 6px; color: #738198; font-size: 12px; }
.modal-heading h2 { margin: 0; color: var(--skill-ink); font-size: 24px; font-weight: 720; letter-spacing: -0.025em; }
.detail-heading-actions { display: flex; align-items: center; gap: 10px; }
.icon-button { display: grid; width: 36px; height: 36px; padding: 0; border: 1px solid #DCE3EC; border-radius: 6px; place-items: center; background: #FFFFFF; color: #60708A; }
.icon-button:hover { border-color: #AAB6C7; color: var(--skill-ink); }
.icon-button svg { width: 18px; height: 18px; }
.secondary-button, .danger-button { display: inline-flex; min-height: 40px; padding: 0 15px; align-items: center; justify-content: center; gap: 8px; border: 1px solid #CBD5E1; border-radius: 6px; background: #FFFFFF; color: #334155; font: inherit; font-size: 13px; font-weight: 620; }
.secondary-button:hover { border-color: #94A3B8; background: #F8FAFC; }
.secondary-button svg { width: 18px; height: 18px; }
.danger-button { border-color: #EABBBB; color: #B33131; }
.danger-button:hover { background: #FFF6F6; }
.primary-button { min-height: 40px; padding: 0 18px; border-radius: 6px; font-size: 13px; }
.primary-button:disabled, .secondary-button:disabled, .danger-button:disabled { cursor: not-allowed; opacity: 0.55; transform: none; }
.import-block { margin-bottom: 20px; }
.import-panel { margin-top: 12px; padding: 16px; border: 1px solid #DCE3EC; border-radius: 7px; background: #F8FAFC; }
.import-panel > p { margin: 0 0 12px; color: #65738A; font-size: 12px; line-height: 1.65; }
.import-actions { display: flex; margin-top: 10px; justify-content: flex-end; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.field-label { display: grid; margin: 0 0 16px; gap: 7px; color: #354257; font-size: 13px; font-weight: 630; }
.field-label > span { display: flex; align-items: baseline; gap: 7px; }
.field-label b { color: #C83B3B; }
.field-label small { color: #8793A5; font-size: 11px; font-weight: 480; }
.field-input { width: 100%; min-height: 43px; padding: 0 12px; border: 1px solid #D7DEE8; border-radius: 6px; outline: 0; background: #FFFFFF; color: var(--skill-ink); font: inherit; font-size: 13px; box-sizing: border-box; }
.field-input:focus { border-color: var(--skill-blue); box-shadow: 0 0 0 3px rgba(11, 99, 246, 0.08); }
.field-input.area { min-height: 120px; padding: 11px 12px; resize: vertical; line-height: 1.6; }
.field-input:disabled { background: #F2F4F7; color: #8793A5; }
.form-error { margin: -4px 0 14px; color: #C03939; font-size: 12px; line-height: 1.5; }
.modal-actions { display: flex; margin-top: 24px; justify-content: flex-end; gap: 10px; }
.prompt-preview { max-height: 300px; min-height: 120px; overflow: auto; margin: 0; padding: 15px; border: 1px solid #DCE3EC; border-radius: 6px; background: #F8FAFC; color: #263449; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; font-weight: 450; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.review-checklist, .review-history { margin: 4px 0 20px; padding: 15px 17px; border-left: 3px solid #E5A126; background: #FFF9EF; color: #5F4A27; }
.review-checklist strong, .review-history > strong { font-size: 13px; }
.review-checklist ul { margin: 8px 0 0 18px; padding: 0; font-size: 12px; line-height: 1.7; }
.detail-description { margin: 0 0 20px; padding: 14px 16px; border-left: 3px solid var(--skill-blue); background: #F5F8FD; color: #455269; font-size: 13px; line-height: 1.7; }
.detail-meta { display: flex; margin-top: 14px; gap: 10px 20px; flex-wrap: wrap; color: #718096; font-size: 11px; }
.review-history { margin-top: 18px; border-left-color: #93A4B9; background: #F8FAFC; color: #4A576B; }
.review-history p { margin: 8px 0 0; font-size: 12px; line-height: 1.6; }
.review-history p b { margin-right: 6px; }
.log-reject { color: #C13A3A; }
.log-approve { color: #23864A; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; margin: -1px; padding: 0; border: 0; clip: rect(0, 0, 0, 0); white-space: nowrap; }

@keyframes shimmer { to { background-position: -200% 0; } }

@media (max-width: 1260px) {
  .skills-page { padding-right: 30px; padding-left: 30px; }
  .skill-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .search-row { grid-template-columns: minmax(220px, 1fr) 240px 120px; }
}

@media (max-width: 820px) {
  .skills-page { padding: 24px 20px 44px; }
  .heading-row { align-items: flex-start; }
  .heading-copy { display: grid; gap: 8px; }
  .heading-copy h1 { font-size: 36px; }
  .heading-divider { display: none; }
  .heading-copy p { font-size: 14px; }
  .create-button { min-height: 44px; padding: 0 14px; }
  .search-row { grid-template-columns: 1fr 1fr; }
  .search-field { grid-column: 1 / -1; }
  .search-button { min-height: 50px; }
  .skill-tabs button { min-width: 0; font-size: 14px; }
  .skill-grid { grid-template-columns: 1fr; }
  .category-rail { grid-template-columns: repeat(7, 132px); }
}

@media (max-width: 560px) {
  .heading-row { display: grid; }
  .create-button { justify-self: start; }
  .skills-toolbar { margin-top: 24px; gap: 16px; }
  .skill-tabs { min-height: 58px; }
  .skill-tabs button { gap: 6px; font-size: 12px; }
  .skill-tabs strong { font-size: 12px; }
  .search-row { display: grid; grid-template-columns: 1fr; gap: 10px; }
  .search-field, .group-select-wrap, .search-button { grid-column: 1; min-height: 50px; }
  .catalog-heading { display: grid; gap: 7px; }
  .skill-card { min-height: 210px; }
  .modal-mask { padding: 14px; }
  .modal-card { max-height: calc(100vh - 28px); padding: 20px; }
  .form-grid { grid-template-columns: 1fr; gap: 0; }
  .modal-actions { flex-wrap: wrap; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
</style>
