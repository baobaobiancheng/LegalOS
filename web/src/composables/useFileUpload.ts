import { computed, ref } from 'vue'
import { request, RequestError } from '../api/client'

/**
 * 附件上传（2026-08-12 review）：不再 Base64 塞进 JSON——
 * 选择文件 → multipart 上传 /consultation-attachments → 后端 mammoth 提取正文 →
 * 返回 attachmentId；发送消息只带 attachmentIds，正文由后端注入模型上下文。
 * 仅支持 .docx / .txt / .md。
 */
export interface AttachedFile {
  id: string              // 后端 attachmentId（上传成功）或本地临时 key
  name: string
  size: number
  type: string
  status: 'uploading' | 'ready' | 'warning' | 'failed'
  warning?: string
  extractedChars?: number
  _local?: boolean
}

export interface AttachmentMetadata {
  id: string
  name: string
  size: number
  mimeType: string | null
  status: string
  extractedChars: number
  warning: string | null
}

export function useFileUpload() {
  const files = ref<AttachedFile[]>([])
  const fileInput = ref<HTMLInputElement | null>(null)

  const triggerFilePick = () => fileInput.value?.click()

  const removeFile = (fid: string) => {
    files.value = files.value.filter(f => f.id !== fid)
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  /** 就绪可发送的附件 id */
  const readyIds = computed(() =>
    files.value.filter(f => f.status === 'ready' || f.status === 'warning').map(f => f.id),
  )
  const hasPending = computed(() => files.value.some(f => f.status === 'uploading'))

  const handleFiles = async (e: Event) => {
    const target = e.target as HTMLInputElement
    const selected = target.files
    if (!selected) return

    for (const f of Array.from(selected)) {
      const localKey = 'l-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      const fd = new FormData()
      fd.append('file', f)
      files.value.push({ id: localKey, name: f.name, size: f.size, type: f.type, status: 'uploading', _local: true })
      try {
        const meta = await request<AttachmentMetadata>('/consultation-attachments', {
          method: 'POST',
          body: fd,
          timeoutMs: 60_000,
        })
        const idx = files.value.findIndex(x => x.id === localKey)
        if (idx >= 0) {
          // P2-7：处理状态恒 ready；警告走独立 warning 字段（前端据此显示黄提示）
          files.value[idx] = {
            id: meta.id,
            name: meta.name,
            size: meta.size,
            type: f.type,
            status: 'ready',
            warning: meta.warning ?? undefined,
            extractedChars: meta.extractedChars,
          }
        }
      } catch (err) {
        const idx = files.value.findIndex(x => x.id === localKey)
        if (idx >= 0) {
          const msg = err instanceof RequestError ? err.payload.error : '上传失败'
          files.value[idx] = { ...files.value[idx], status: 'failed', warning: msg }
        }
      }
    }
    target.value = ''
  }

  /** 用户消息只显示提问文字；附件正文由后端注入（不再拼 Base64/文件名进提示词）。
   *  保留 files 形参以兼容既有调用点（ConsultView/RecordDetailView）。 */
  const buildFullInput = (text: string, _attached?: AttachedFile[]): string => text
  const buildDisplayText = (text: string, _attached?: AttachedFile[]): string => text

  const clearFiles = () => { files.value = [] }

  return {
    files, fileInput, triggerFilePick, removeFile, formatSize,
    readyIds, hasPending, handleFiles, buildFullInput, buildDisplayText, clearFiles,
  }
}
