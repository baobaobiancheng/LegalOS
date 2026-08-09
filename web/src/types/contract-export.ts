/**
 * 合同导出样式（P2-04：纯类型,与重型 DOCX 转换实现解耦,调用方用 `import type` 引用,不触发 docx/marked 依赖加载）。
 * 与后端 ContractTemplate.style JSON 对齐。
 */
export type ContractDocStyle = {
  pageMargin?: { top: number; right: number; bottom: number; left: number }
  body?: { fontEastAsia: string; fontAscii: string; sizePt: number; lineSpacing?: number }
  partyInfo?: { fontEastAsia: string; fontAscii: string; sizePt: number; bold?: boolean }
  heading?: { fontEastAsia: string; fontAscii: string; sizePt: number; bold?: boolean }
}
