<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useFileUpload } from '../composables/useFileUpload'
import type { AttachedFile } from '../composables/useFileUpload'

const props = defineProps<{
  disabled?: boolean
  placeholder?: string
  capability?: ConsultationCapability
}>()

const emit = defineEmits<{
  send: [text: string, files: AttachedFile[], capability: ConsultationCapability]
  'update:capability': [capability: ConsultationCapability]
}>()

type ConsultationCapability = 'general' | 'law_search' | 'similar_case'
const capabilities: Array<{ id: ConsultationCapability; label: string; description: string }> = [
  { id: 'general', label: '通用咨询', description: '直接分析并回答，不检索外部法律数据' },
  { id: 'law_search', label: 'AI 搜法', description: '检索国内法规，并核验回答引用的具体条文' },
  { id: 'similar_case', label: 'AI 类案', description: '检索相似案例，结果取决于案例库可用性' },
]
const menuOpen = ref(false)
const activeOption = ref(0)
const trigger = ref<HTMLButtonElement | null>(null)
const optionRefs = ref<HTMLButtonElement[]>([])
const selectedCapability = () => props.capability ?? 'general'
const selected = () => capabilities.find(item => item.id === selectedCapability()) ?? capabilities[0]
const openMenu = async () => {
  if (props.disabled) return
  activeOption.value = Math.max(0, capabilities.findIndex(item => item.id === selectedCapability()))
  menuOpen.value = true
  await nextTick()
  optionRefs.value[activeOption.value]?.focus()
}
const closeMenu = (restoreFocus = true) => {
  menuOpen.value = false
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}
const selectCapability = (capability: ConsultationCapability) => {
  emit('update:capability', capability)
  closeMenu()
}
const onMenuKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') return closeMenu()
  if (event.key === 'Tab') return closeMenu(false)
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') activeOption.value = 0
  else if (event.key === 'End') activeOption.value = capabilities.length - 1
  else activeOption.value = (activeOption.value + (event.key === 'ArrowDown' ? 1 : -1) + capabilities.length) % capabilities.length
  optionRefs.value[activeOption.value]?.focus()
}

const input = ref('')
const { files, fileInput, triggerFilePick, removeFile, formatSize, handleFiles, hasPending, clearFiles } = useFileUpload()

// review 2026-08-13：完全取消字符数限制(前后端一致只留非空)。
// 后端 CreateProjectDto 已移除 @MinLength(5);纯文本非空即可发,
// 仅附件(空文本)时 handleSend 自动补"请分析所附文件"。
const canSend = () =>
  (input.value.trim().length > 0 || files.value.some(f => f.status === 'ready' || f.status === 'warning')) &&
  !props.disabled &&
  !hasPending.value

const handleSend = () => {
  if (!canSend()) return
  // P1-1：仅附件发送（空文本）时自动生成非空问题，后端 DTO 禁止空文本
  const text = input.value.trim() || '请分析所附文件'
  emit('send', text, [...files.value], selectedCapability())
  input.value = ''
  clearFiles()
}
</script>

<template>
  <div class="doubao-input-area">
    <div class="capability-row">
      <div class="capability-picker">
        <button
          ref="trigger"
          class="capability-trigger"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          :aria-label="`当前能力：${selected().label}`"
          :disabled="disabled"
          @click="menuOpen ? closeMenu(false) : openMenu()"
          @keydown.down.prevent="openMenu"
          @keydown.enter.prevent="openMenu"
          @keydown.space.prevent="openMenu"
        >
          <span aria-hidden="true">⌕</span> {{ selected().label }} <span aria-hidden="true">⌄</span>
        </button>
        <div
          v-if="menuOpen"
          class="capability-menu"
          role="menu"
          aria-label="选择咨询能力"
          @keydown="onMenuKeydown"
        >
          <button
            v-for="(item, index) in capabilities"
            :key="item.id"
            :ref="el => { if (el) optionRefs[index] = el as HTMLButtonElement }"
            class="capability-option"
            role="menuitemradio"
            :aria-checked="item.id === selectedCapability()"
            :tabindex="index === activeOption ? 0 : -1"
            @focus="activeOption = index"
            @click="selectCapability(item.id)"
          >
            <span class="capability-check">{{ item.id === selectedCapability() ? '✓' : '' }}</span>
            <span><b>{{ item.label }}</b><small>{{ item.description }}</small></span>
          </button>
        </div>
      </div>
      <p
        class="capability-hint"
        aria-live="polite"
      >
        {{ selected().description }}
      </p>
    </div>
    <div
      v-if="files.length"
      class="file-preview-bar"
    >
      <div
        v-for="f in files"
        :key="f.id"
        :class="['file-chip', f.status]"
      >
        <span class="fc-icon">
          {{ f.status === 'uploading' ? '↻' : f.status === 'failed' ? '!' : 'W' }}
        </span>
        <span class="fc-info">
          <span
            class="fc-name"
            :title="f.name"
          >{{ f.name }}</span>
          <span class="fc-meta">
            {{ f.type.includes('word') || f.name.toLowerCase().endsWith('.docx') ? 'DOCX' : f.name.toLowerCase().endsWith('.md') ? 'MD' : 'TXT' }}
            · {{ formatSize(f.size) }}
            <template v-if="f.warning"> · ⚠ {{ f.warning }}</template>
            <template v-else-if="f.status === 'ready'"> · ✓ 已解析 {{ f.extractedChars?.toLocaleString() }} 字</template>
            <template v-else-if="f.status === 'uploading'"> · 上传中…</template>
            <template v-else-if="f.status === 'failed'"> · {{ f.warning || '上传失败' }}</template>
          </span>
        </span>
        <button
          class="fc-remove"
          :aria-label="'删除 ' + f.name"
          @click="removeFile(f.id)"
        >
          ×
        </button>
      </div>
    </div>

    <div class="input-container">
      <button
        class="attach-btn"
        title="上传文件"
        @click="triggerFilePick"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        ><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
      </button>
      <textarea
        v-model="input"
        :placeholder="placeholder || '描述您的法律问题，可上传合同、协议等文件…'"
        rows="1"
        :disabled="disabled"
        @keydown.enter.exact.prevent="handleSend"
      />
      <button
        class="send-btn"
        :disabled="!canSend()"
        @click="handleSend"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
        ><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
      </button>
    </div>

    <input
      ref="fileInput"
      type="file"
      multiple
      hidden
      accept=".docx,.txt,.md"
      @change="handleFiles"
    >
  </div>
</template>

<style scoped>
.capability-row { position: relative; display: flex; align-items: center; gap: 12px; margin: 0 0 8px; padding: 0 6px; }
.capability-picker { position: relative; flex: none; }
.capability-trigger { border: 1px solid rgba(30,58,138,.16); border-radius: 999px; background: rgba(255,255,255,.78); color: #1e3a8a; padding: 7px 11px; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.capability-trigger:focus-visible, .capability-option:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.capability-trigger:disabled { opacity: .5; cursor: not-allowed; }
.capability-menu { position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: 330px; padding: 7px; border: 1px solid rgba(30,58,138,.14); border-radius: 16px; background: rgba(255,255,255,.98); box-shadow: 0 18px 45px rgba(20,35,80,.16); }
.capability-option { display: grid; grid-template-columns: 20px 1fr; gap: 7px; width: 100%; padding: 10px; border: 0; border-radius: 10px; background: transparent; color: #172033; font: inherit; text-align: left; cursor: pointer; }
.capability-option:hover, .capability-option[aria-checked="true"] { background: #eef4ff; }
.capability-option b, .capability-option small { display: block; }
.capability-option b { font-size: 13px; }
.capability-option small { margin-top: 3px; color: #667085; font-size: 11px; line-height: 1.4; }
.capability-check { color: #2563eb; font-weight: 700; }
.capability-hint { min-width: 0; margin: 0; color: #667085; font-size: 11px; line-height: 1.45; }
@media (max-width: 1023px) { .capability-row { display: none; } }
</style>
