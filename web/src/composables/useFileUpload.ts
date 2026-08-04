import { ref } from 'vue'

export interface AttachedFile {
  id: string
  name: string
  size: number
  type: string
  content: string       // 文本内容或 base64
  textPreview: string   // 可读预览
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

  const handleFiles = async (e: Event) => {
    const target = e.target as HTMLInputElement
    const selected = target.files
    if (!selected) return

    for (let i = 0; i < selected.length; i++) {
      const f = selected[i]
      if (f.size > 5 * 1024 * 1024) continue
      const fid = 'f-' + Date.now() + '-' + i
      let content = '', textPreview = ''
      try {
        if (f.type.startsWith('text/') || f.name.endsWith('.txt') || f.name.endsWith('.md')) {
          content = await f.text()
          textPreview = content.slice(0, 500)
        } else {
          const buf = await f.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j])
          content = btoa(binary)
          textPreview = `[${f.type || 'binary'}] ${formatSize(f.size)}`
        }
      } catch {
        textPreview = '[读取失败]'
      }
      files.value.push({ id: fid, name: f.name, size: f.size, type: f.type, content, textPreview })
    }
    target.value = ''
  }

  /** 构建含附件内容的完整输入文本 */
  const buildFullInput = (text: string, attached: AttachedFile[]): string => {
    if (!attached.length) return text
    let result = text + '\n\n--- 附件内容 ---'
    for (const f of attached) {
      result += `\n[文件：${f.name} (${formatSize(f.size)})]`
      if (f.textPreview && !f.textPreview.startsWith('[')) {
        result += `\n${f.textPreview}${f.content.length > 500 ? '\n...(内容已截断)' : ''}`
      }
    }
    return result
  }

  /** 构建用户侧的展示文本 */
  const buildDisplayText = (text: string, attached: AttachedFile[]): string => {
    if (!attached.length) return text
    return text + '\n\n📎 附件：' + attached.map(f => f.name).join('、')
  }

  const clearFiles = () => { files.value = [] }

  return {
    files, fileInput, triggerFilePick, removeFile, formatSize,
    handleFiles, buildFullInput, buildDisplayText, clearFiles,
  }
}
