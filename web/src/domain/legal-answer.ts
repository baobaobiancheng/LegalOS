export type LegalAnswerBlock =
  | { key: string; kind: 'heading'; text: string; level: number }
  | { key: string; kind: 'paragraph'; text: string }
  | { key: string; kind: 'list'; ordered: boolean; items: string[] }

function cleanInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1')
    .replace(/(?:\*\*|__)(.+?)(?:\*\*|__)/gu, '$1')
    .replace(/(?:\*|_)(.+?)(?:\*|_)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\\([\\`*_[\]{}()#+.!>-])/gu, '$1')
    .trim()
}

/**
 * 把受控模型 Markdown 转成 Vue 可直接插值渲染的块，不使用 v-html。
 * 未识别语法按普通文本处理，因此模型内容不能注入 HTML。
 */
export function parseLegalAnswerBlocks(value: string): LegalAnswerBlock[] {
  const blocks: LegalAnswerBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let inFence = false
  let sequence = 0
  const nextKey = (kind: string) => `${kind}-${sequence++}`
  const flushParagraph = () => {
    const text = paragraph.map(cleanInlineMarkdown).filter(Boolean).join('\n').trim()
    if (text) blocks.push({ key: nextKey('paragraph'), kind: 'paragraph', text })
    paragraph = []
  }
  const flushList = () => {
    if (list?.items.length) blocks.push({ key: nextKey('list'), kind: 'list', ...list })
    list = null
  }

  for (const rawLine of value.replace(/\r/gu, '').split('\n')) {
    const line = rawLine.trimEnd()
    if (/^```/u.test(line.trim())) {
      flushParagraph()
      flushList()
      inFence = !inFence
      continue
    }
    if (inFence) {
      paragraph.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/u)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({
        key: nextKey('heading'),
        kind: 'heading',
        level: heading[1].length,
        text: cleanInlineMarkdown(heading[2]),
      })
      continue
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/u)
    const ordered = line.match(/^\s*\d+[.)、]\s+(.+)$/u)
    if (unordered || ordered) {
      flushParagraph()
      const orderedList = Boolean(ordered)
      if (list && list.ordered !== orderedList) flushList()
      if (!list) list = { ordered: orderedList, items: [] }
      list.items.push(cleanInlineMarkdown((unordered ?? ordered)![1]))
      continue
    }
    flushList()
    paragraph.push(line.replace(/^\s*>\s?/u, ''))
  }
  flushParagraph()
  flushList()
  return blocks
}
