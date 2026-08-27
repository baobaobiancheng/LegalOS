<script setup lang="ts">
import { ref } from 'vue'
import type { ContractDocStyle } from '../types/contract-export'
import { request } from '../api/client'

const props = defineProps<{
  content: string
  filename?: string
  /** 每模板独立的导出样式（字体/字号/页边距），缺省用默认样式 */
  docxStyle?: ContractDocStyle
  auditProjectId?: string
  auditResourceType?: 'contract' | 'consultation_record'
  auditResourceId?: string
  auditEndpoint?: string
  auditPayload?: Record<string, unknown>
}>()

const open = ref(false)
const converting = ref(false)
const docxError = ref('')

const toggle = () => { open.value = !open.value }

// ── .md 下载（轻量同步,不触发 DOCX 依赖） ──
const downloadMD = async () => {
  docxError.value = ''
  try {
    await recordDownload('md')
    const blob = new Blob([props.content], { type: 'text/markdown;charset=utf-8' })
    triggerDownload(blob, `${props.filename || '法律咨询答复'}.md`)
    open.value = false
  } catch (error) {
    docxError.value = '审计记录写入失败，未执行下载'
    console.error('Download audit failed:', error)
  }
}

// ── .docx 下载（P2-04：点击后才动态加载 docx/marked,首屏不下载该 chunk） ──
const downloadDOCX = async () => {
  if (converting.value) return // 双击保护
  converting.value = true
  docxError.value = ''
  let documentReady = false
  try {
    const { markdownToDocxBlob } = await import('../utils/markdown-to-docx')
    const blob = await markdownToDocxBlob(props.content, props.filename || '法律咨询答复', props.docxStyle)
    documentReady = true
    await recordDownload('docx')
    triggerDownload(blob, `${props.filename || '法律咨询答复'}.docx`)
  } catch (e) {
    docxError.value = documentReady ? '审计记录写入失败，未执行下载' : 'Word 文档生成失败，请重试'
    console.error(documentReady ? 'Download audit failed:' : 'DOCX generation failed:', e)
    open.value = true // P2-04 失败保留下拉菜单,用户可看到错误并重试
    return
  } finally {
    converting.value = false
  }
  open.value = false
}

// ── 辅助 ──
const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const recordDownload = async (format: 'md' | 'docx') => {
  if (props.auditEndpoint) {
    await request<void>(props.auditEndpoint, {
      method: 'POST',
      body: { ...(props.auditPayload ?? {}), format },
    })
    return
  }
  if (!props.auditProjectId || !props.auditResourceType) return
  await request<void>(`/projects/${props.auditProjectId}/downloads`, {
    method: 'POST',
    body: {
      resourceType: props.auditResourceType,
      resourceId: props.auditResourceId,
      format,
    },
  })
}
</script>

<template>
  <div class="download-wrap">
    <button
      class="dl-trigger"
      title="下载答复"
      @click.stop="toggle"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line
        x1="12"
        y1="15"
        x2="12"
        y2="3"
      /></svg>
      下载
    </button>
    <div
      v-if="open"
      class="dl-dropdown"
    >
      <button @click.stop="downloadMD">
        📝 Markdown (.md)
      </button>
      <button
        :disabled="converting"
        @click.stop="downloadDOCX"
      >
        {{ converting ? '转换中…' : '📄 Word (.docx)' }}
      </button>
      <p
        v-if="docxError"
        class="dl-error"
      >
        {{ docxError }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.download-wrap { position: relative; display: inline-block; margin-top: 8px; }
.dl-error { color: #c62828; font-size: 12px; margin: 4px 0 0; }
.dl-trigger {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 14px; border: 1px solid rgba(0,0,0,0.08); border-radius: 14px;
  background: rgba(255,255,255,0.7); color: var(--text-secondary);
  font-family: inherit; font-size: 12px; cursor: pointer;
  transition: all 0.2s;
}
.dl-trigger:hover { background: rgba(0,113,227,0.06); color: var(--blue); border-color: rgba(0,113,227,0.2); }

.dl-dropdown {
  position: absolute; bottom: 100%; left: 0; margin-bottom: 6px;
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px; border-radius: 12px;
  background: rgba(255,255,255,0.95); backdrop-filter: blur(16px);
  border: 1px solid rgba(0,0,0,0.08);
  box-shadow: 0 8px 30px rgba(0,0,0,0.10);
  min-width: 180px; z-index: 20;
}
.dl-dropdown button {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border: none; border-radius: 8px;
  background: transparent; font-family: inherit; font-size: 13px;
  color: var(--text); cursor: pointer; text-align: left;
  transition: all 0.15s;
}
.dl-dropdown button:hover { background: rgba(0,0,0,0.04); }
</style>
