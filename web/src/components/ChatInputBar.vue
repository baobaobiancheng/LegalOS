<script setup lang="ts">
import { ref } from 'vue'
import { useFileUpload } from '../composables/useFileUpload'
import type { AttachedFile } from '../composables/useFileUpload'

const props = defineProps<{
  disabled?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  send: [text: string, files: AttachedFile[]]
}>()

const input = ref('')
const { files, fileInput, triggerFilePick, removeFile, formatSize, handleFiles, hasPending, clearFiles } = useFileUpload()

// review 2026-08-12：发送门槛对齐后端 DTO @MinLength(5)——前端门槛必须 ≥ 后端，
// 否则短句(如"你好")前端能发、后端拒 → 报 title/input <5 字符。
// 纯文本需 ≥5 字；仅附件(空文本)时 handleSend 自动补"请分析所附文件"(>5 字)绕过。
const canSend = () =>
  (input.value.trim().length >= 5 || files.value.some(f => f.status === 'ready' || f.status === 'warning')) &&
  !props.disabled &&
  !hasPending.value

const handleSend = () => {
  if (!canSend()) return
  // P1-1：仅附件发送（空文本）时自动生成非空问题，后端 DTO 禁止空文本
  const text = input.value.trim() || '请分析所附文件'
  emit('send', text, [...files.value])
  input.value = ''
  clearFiles()
}
</script>

<template>
  <div class="doubao-input-area">
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
