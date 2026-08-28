<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useFileUpload } from '../composables/useFileUpload'
import type { AttachedFile } from '../composables/useFileUpload'

type ConsultationCapability = 'general' | 'law_search' | 'similar_case'

const props = withDefaults(defineProps<{
  disabled?: boolean
  placeholder?: string
  capability?: ConsultationCapability
  appearance?: 'welcome' | 'conversation'
}>(), {
  appearance: 'conversation',
  placeholder: '',
  capability: 'general',
})

const emit = defineEmits<{
  send: [text: string, files: AttachedFile[], capability: ConsultationCapability]
  'update:capability': [capability: ConsultationCapability]
}>()

const capabilities: Array<{ id: ConsultationCapability; label: string; description: string }> = [
  { id: 'general', label: '通用法务咨询', description: '直接分析并回答，不检索外部法律数据' },
  { id: 'law_search', label: 'AI 搜法', description: '检索国内法规，并核验回答引用的具体条文' },
  { id: 'similar_case', label: 'AI 类案', description: '检索相似案例，结果取决于案例库可用性' },
]

const menuOpen = ref(false)
const activeOption = ref(0)
const trigger = ref<HTMLButtonElement | null>(null)
const optionRefs = ref<HTMLButtonElement[]>([])
const selectedCapability = () => props.capability ?? 'general'
const selected = () => capabilities.find(item => item.id === selectedCapability()) ?? capabilities[0]
const fileFormatLabel = (file: AttachedFile) => {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.docx')) return 'DOCX'
  if (lower.endsWith('.doc')) return 'DOC'
  if (lower.endsWith('.md')) return 'MD'
  return 'TXT'
}

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

const canSend = () =>
  (input.value.trim().length > 0 || files.value.some(f => f.status === 'ready' || f.status === 'warning')) &&
  !props.disabled &&
  !hasPending.value

const handleSend = () => {
  if (!canSend()) return
  const text = input.value.trim() || '请分析所附文件'
  emit('send', text, [...files.value], selectedCapability())
  input.value = ''
  clearFiles()
}
</script>

<template>
  <div :class="['consult-composer', `appearance-${appearance}`]">
    <div
      v-if="files.length"
      class="file-preview-bar"
    >
      <div
        v-for="file in files"
        :key="file.id"
        :class="['file-chip', file.status]"
      >
        <span class="file-type">{{ file.status === 'uploading' ? '↻' : file.status === 'failed' ? '!' : 'W' }}</span>
        <span class="file-copy">
          <strong :title="file.name">{{ file.name }}</strong>
          <small>
            {{ fileFormatLabel(file) }}
            · {{ formatSize(file.size) }}
            <template v-if="file.warning"> · {{ file.warning }}</template>
            <template v-else-if="file.status === 'ready'"> · 已解析 {{ file.extractedChars?.toLocaleString() }} 字</template>
            <template v-else-if="file.status === 'uploading'"> · 上传中…</template>
          </small>
        </span>
        <button
          class="file-remove"
          :aria-label="'删除 ' + file.name"
          @click="removeFile(file.id)"
        >
          ×
        </button>
      </div>
    </div>

    <div class="composer-frame">
      <textarea
        v-model="input"
        :placeholder="placeholder || '请说明事情经过、涉及主体、期望解决的问题，以及已掌握的材料'"
        :rows="appearance === 'welcome' ? 4 : 2"
        :disabled="disabled"
        @keydown.enter.exact.prevent="handleSend"
      />

      <div class="composer-toolbar">
        <button
          class="composer-attach"
          type="button"
          :disabled="disabled"
          @click="triggerFilePick"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            aria-hidden="true"
          ><path d="m21.4 11.1-9.2 9.1a6 6 0 0 1-8.5-8.5l9.2-9.1a4 4 0 0 1 5.7 5.6l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5" /></svg>
          <span>上传材料</span>
        </button>

        <span class="toolbar-divider" />

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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="M3 6h18M6 6l-3 7h6L6 6Zm12 0-3 7h6l-3-7ZM12 3v18M8 21h8" /></svg>
            <span>{{ selected().label }}</span>
            <svg
              class="chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            ><path d="m7 10 5 5 5-5" /></svg>
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
              :ref="element => { if (element) optionRefs[index] = element as HTMLButtonElement }"
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

        <button
          class="composer-submit"
          :class="{ labeled: appearance === 'welcome' }"
          type="button"
          :disabled="!canSend()"
          :aria-label="appearance === 'welcome' ? '开始咨询' : '发送消息'"
          @click="handleSend"
        >
          <span v-if="appearance === 'welcome'">开始咨询</span>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><path d="m5 12 14-7-4 14-3-6-7-1Z" /><path d="m12 13 7-8" /></svg>
        </button>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      multiple
      hidden
      accept=".docx,.doc,.txt,.md"
      @change="handleFiles"
    >
  </div>
</template>

<style scoped>
.consult-composer { position: relative; width: 100%; padding: 0; background: transparent; }
.composer-frame { overflow: visible; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; transition: border-color 180ms ease, box-shadow 180ms ease; }
.composer-frame:focus-within { border-color: #8bb2f4; box-shadow: 0 0 0 3px rgba(37, 99, 235, .08); }
.composer-frame textarea { display: block; width: 100%; min-height: 84px; padding: 22px 26px 8px; resize: none; border: 0; outline: 0; background: transparent; color: #172033; font: inherit; font-size: 15px; line-height: 1.65; }
.composer-frame textarea::placeholder { color: #8290a5; }
.composer-frame textarea:disabled { opacity: .55; cursor: wait; }
.appearance-welcome .composer-frame textarea { min-height: 126px; }
.composer-toolbar { display: flex; min-height: 66px; padding: 8px 14px 14px 20px; align-items: center; gap: 14px; }
.composer-attach,
.capability-trigger,
.composer-submit { display: inline-flex; align-items: center; border: 0; background: transparent; color: #24324a; font: inherit; font-size: 14px; font-weight: 560; cursor: pointer; }
.composer-attach { gap: 9px; }
.composer-attach svg { width: 21px; height: 21px; }
.composer-attach:hover:not(:disabled),
.capability-trigger:hover:not(:disabled) { color: #2563eb; }
.composer-attach:disabled,
.capability-trigger:disabled { opacity: .5; cursor: not-allowed; }
.toolbar-divider { width: 1px; height: 24px; background: #dbe2ea; }
.capability-picker { position: relative; }
.capability-trigger { gap: 9px; }
.capability-trigger > svg { width: 20px; height: 20px; }
.capability-trigger .chevron { width: 16px; height: 16px; margin-left: 4px; }
.capability-trigger:focus-visible,
.capability-option:focus-visible,
.composer-attach:focus-visible,
.composer-submit:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.capability-menu { position: absolute; left: 0; bottom: calc(100% + 13px); z-index: 30; width: 340px; padding: 7px; border: 1px solid #dbe3ee; border-radius: 10px; background: #fff; box-shadow: 0 18px 45px rgba(15, 23, 42, .14); }
.capability-option { display: grid; width: 100%; padding: 11px 10px; grid-template-columns: 20px 1fr; gap: 7px; border: 0; border-radius: 7px; background: transparent; color: #172033; font: inherit; text-align: left; cursor: pointer; }
.capability-option:hover,
.capability-option[aria-checked="true"] { background: #f2f6fc; }
.capability-option b,
.capability-option small { display: block; }
.capability-option b { font-size: 13px; }
.capability-option small { margin-top: 3px; color: #667085; font-size: 11px; line-height: 1.4; }
.capability-check { color: #2563eb; font-weight: 700; }
.composer-submit { width: 42px; height: 42px; margin-left: auto; border-radius: 7px; justify-content: center; background: #0f5fff; color: #fff; transition: background 160ms ease, transform 160ms ease; }
.composer-submit svg { width: 19px; height: 19px; }
.composer-submit.labeled { width: auto; min-width: 126px; height: 52px; padding: 0 24px; font-size: 15px; }
.composer-submit:hover:not(:disabled) { transform: translateY(-1px); background: #004fe0; }
.composer-submit:disabled { background: #b9c4d4; cursor: not-allowed; }
.file-preview-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.file-chip { display: flex; min-width: 220px; max-width: 360px; padding: 9px 10px; align-items: center; gap: 9px; border: 1px solid #dce3ec; border-radius: 7px; background: #fff; }
.file-chip.failed { border-color: #fecaca; }
.file-type { display: grid; width: 28px; height: 28px; border-radius: 5px; place-items: center; flex: 0 0 auto; background: #edf4ff; color: #2563eb; font-size: 12px; font-weight: 700; }
.file-copy { display: grid; min-width: 0; flex: 1; gap: 2px; }
.file-copy strong,
.file-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-copy strong { color: #273449; font-size: 12px; }
.file-copy small { color: #7b8798; font-size: 10px; }
.file-remove { display: grid; width: 26px; height: 26px; border: 0; border-radius: 5px; place-items: center; background: transparent; color: #7b8798; cursor: pointer; }
.file-remove:hover { background: #fff1f2; color: #e11d48; }

@media (max-width: 680px) {
  .composer-toolbar { flex-wrap: wrap; padding-left: 14px; gap: 10px; }
  .toolbar-divider { display: none; }
  .composer-attach span { display: none; }
  .capability-trigger span { max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .capability-menu { width: min(340px, calc(100vw - 130px)); }
  .composer-submit.labeled { min-width: 104px; padding: 0 16px; }
}
</style>
