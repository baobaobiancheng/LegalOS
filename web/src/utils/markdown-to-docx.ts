import { marked } from 'marked'
import type { Tokens } from 'marked'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, BorderStyle,
  WidthType, ShadingType, convertInchesToTwip,
  Header, ImageRun, AlignmentType,
} from 'docx'
// 模板页眉 logo（从公司法务模板 docx 提取，3 个模板共用同一图片）
import headerLogoBase64 from '../assets/logo-header.jpeg?inline'

/** 页眉 logo 数据（base64 data URI → Uint8Array） */
const headerLogoData: Uint8Array = (() => {
  const b64 = headerLogoBase64.includes(',') ? headerLogoBase64.split(',')[1] : headerLogoBase64
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
})()

/** 水印淡化：原图不透明 jpg → canvas 降透明度（15% 不透明）成半透明水印 */
let fadedLogoPromise: Promise<Uint8Array> | null = null
function getFadedLogo(): Promise<Uint8Array> {
  fadedLogoPromise ??= (async () => {
    const img = new Image()
    img.src = headerLogoBase64
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.globalAlpha = 0.15 // 淡化到 15%（水印效果，不遮挡正文）
    ctx.drawImage(img, 0, 0)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  })()
  return fadedLogoPromise
}

/**
 * 合同导出样式（与后端 ContractTemplate.style JSON 对齐）。
 * 每模板独立：字体（中文 eastAsia + 西文 ascii）/字号/行距/页边距/标题加粗。
 * 缺省（不传）时用通用默认样式（微软雅黑 10.5pt 1.5 行距），向后兼容。
 */
export type ContractDocStyle = {
  pageMargin?: { top: number; right: number; bottom: number; left: number }
  body?: { fontEastAsia: string; fontAscii: string; sizePt: number; lineSpacing?: number }
  partyInfo?: { fontEastAsia: string; fontAscii: string; sizePt: number; bold?: boolean }
  heading?: { fontEastAsia: string; fontAscii: string; sizePt: number; bold?: boolean }
}

/** 渲染上下文：从 style 计算出的具体参数（半磅字号 / 1/240 行距） */
interface StyleCtx {
  font: { ascii: string; eastAsia: string }
  size: number            // 正文字号（半磅）
  headingSize: number     // 章节标题字号（半磅）
  headingBold: boolean
  lineSpacing: number     // 行距（1/240 单位）
  margins: { top: number; right: number; bottom: number; left: number }
}

const DEFAULT_STYLE: StyleCtx = {
  font: { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' },
  size: 21,                                    // 10.5pt
  headingSize: 24,                             // 12pt
  headingBold: true,
  lineSpacing: 360,                            // 1.5x
  margins: {
    top: convertInchesToTwip(1.2),
    right: convertInchesToTwip(1.2),
    bottom: convertInchesToTwip(1.2),
    left: convertInchesToTwip(1.2),
  },
}

function buildCtx(style?: ContractDocStyle): StyleCtx {
  if (!style) return DEFAULT_STYLE
  const body = style.body || { fontEastAsia: 'Microsoft YaHei', fontAscii: 'Microsoft YaHei', sizePt: 10.5 }
  const heading = style.heading || { fontEastAsia: body.fontEastAsia, fontAscii: body.fontAscii, sizePt: body.sizePt, bold: true }
  return {
    font: { ascii: body.fontAscii, eastAsia: body.fontEastAsia },
    size: Math.round(body.sizePt * 2),
    headingSize: Math.round((heading.sizePt || body.sizePt) * 2),
    headingBold: heading.bold !== false,
    lineSpacing: Math.round((body.lineSpacing || 1.5) * 240),
    margins: style.pageMargin || DEFAULT_STYLE.margins,
  }
}

export async function markdownToDocxBlob(
  markdown: string,
  filename: string,
  style?: ContractDocStyle,
): Promise<Blob> {
  const ctx = buildCtx(style)
  const tokens = marked.lexer(markdown)
  const children: (Paragraph | Table)[] = []

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        children.push(renderHeading(token as Tokens.Heading, ctx))
        break
      case 'paragraph':
        children.push(renderParagraph(token as Tokens.Paragraph, ctx))
        break
      case 'list':
        for (const item of token.items) {
          children.push(renderListItem(item as Tokens.ListItem, token.ordered, ctx))
        }
        break
      case 'code':
        children.push(renderCodeBlock(token as Tokens.Code))
        break
      case 'blockquote':
        children.push(renderBlockquote(token as Tokens.Blockquote, ctx))
        break
      case 'table':
        children.push(renderTable(token as Tokens.Table, ctx))
        break
      case 'hr':
        children.push(new Paragraph({ spacing: { before: 200, after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } } }))
        break
      case 'space':
        children.push(new Paragraph({ spacing: { before: 100 } }))
        break
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: ctx.font, size: ctx.size },
          paragraph: { spacing: { line: ctx.lineSpacing } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: ctx.margins,
          size: { width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) }, // A4
        },
      },
      // 复用模板页眉（工程决策 2026-08-04）：中央水印（浮动 146mm）+ 右上角小 logo（13mm 正方形）
      // 模板 logo 实际 886×886px：水印显示 554px(146mm)、小 logo 显示 49px(13mm)，严格保持正方形比例
      headers: {
        default: new Header({
          children: [
            // 中央水印：浮动大图（淡化 15%），衬于文字后（复用模板 header3 anchor 大图布局）
            new Paragraph({
              children: [new ImageRun({
                type: 'png',
                data: await getFadedLogo(),
                transformation: { width: 554, height: 554 },
                floating: {
                  horizontalPosition: { relative: 'page', align: 'center' },
                  verticalPosition: { relative: 'page', align: 'center' },
                  behindDocument: true,
                  allowOverlap: true,
                },
              })],
            }),
            // 右上角小 logo（右对齐，13mm 正方形）
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new ImageRun({
                type: 'jpg',
                data: headerLogoData,
                transformation: { width: 49, height: 49 },
              })],
            }),
          ],
        }),
      },
      children,
    }],
  })

  return await Packer.toBlob(doc)
}

// ── Token Renderers ──

function renderHeading(token: Tokens.Heading, ctx: StyleCtx): Paragraph {
  const sizes: Record<number, number> = { 1: ctx.headingSize + 12, 2: ctx.headingSize, 3: ctx.headingSize - 4 }
  return new Paragraph({
    heading: token.depth === 1 ? HeadingLevel.HEADING_1 : token.depth === 2 ? HeadingLevel.HEADING_2 : token.depth === 3 ? HeadingLevel.HEADING_3 : undefined,
    // 大标题（文档名）居中——与模板一致（工程决策 2026-08-04）
    alignment: token.depth === 1 ? AlignmentType.CENTER : undefined,
    spacing: { before: token.depth <= 3 ? 360 : 240, after: 120 },
    children: [
      new TextRun({
        text: token.text,
        font: ctx.font,
        size: sizes[token.depth] || ctx.size,
        bold: ctx.headingBold,
        // 合同导出标题用黑色：docx 库 HeadingLevel 内置样式自带蓝色，必须显式覆盖为黑色
        color: '000000',
      }),
    ],
  })
}

function renderParagraph(token: Tokens.Paragraph, ctx: StyleCtx): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    // 正文首行缩进 2 字符（与模板 firstLineChars=200 一致；1pt=20twips，2字符=2×字号）
    indent: { firstLine: ctx.size * 20 },
    children: token.tokens
      ? token.tokens.map(t => inlineToRun(t, ctx))
      : [new TextRun({ text: token.text, font: ctx.font, size: ctx.size })],
  })
}

function renderListItem(item: Tokens.ListItem, ordered: boolean, ctx: StyleCtx): Paragraph {
  const prefix = ordered ? `${(item as any).index || '1'}. ` : '· '
  return new Paragraph({
    spacing: { after: 60 },
    indent: { left: convertInchesToTwip(0.4) },
    children: [
      new TextRun({ text: prefix, font: ctx.font, size: ctx.size, color: '888888' }),
      ...(item.tokens ? item.tokens.flatMap(t =>
        t.type === 'text' ? [inlineToRun(t as Tokens.Text, ctx)]
        : t.type === 'paragraph' ? (t as Tokens.Paragraph).tokens?.map(x => inlineToRun(x, ctx)) || []
        : []
      ) : [new TextRun({ text: item.text, font: ctx.font, size: ctx.size })]),
    ],
  })
}

function renderCodeBlock(token: Tokens.Code): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    indent: { left: convertInchesToTwip(0.2) },
    shading: { type: ShadingType.SOLID, color: '1D1D1F', fill: '1D1D1F' },
    children: [
      new TextRun({ text: token.text, font: 'Consolas', size: 18, color: 'F5F5F7' }),
    ],
  })
}

function renderBlockquote(token: Tokens.Blockquote, ctx: StyleCtx): Paragraph {
  const text = token.tokens.map(t => t.type === 'paragraph' ? (t as any).text || '' : '').join('\n')
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    indent: { left: convertInchesToTwip(0.3) },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: '0071E3' } },
    shading: { type: ShadingType.SOLID, color: 'F5F5F7', fill: 'F5F5F7' },
    children: [new TextRun({ text, font: ctx.font, size: ctx.size, color: '666666', italics: true })],
  })
}

function renderTable(token: Tokens.Table, ctx: StyleCtx): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: token.header.map(cell =>
      new TableCell({
        shading: { type: ShadingType.SOLID, color: 'F5F5F7', fill: 'F5F5F7' },
        children: [new Paragraph({ children: [new TextRun({ text: cell.text, font: ctx.font, size: ctx.size, bold: true })] })],
      })
    ),
  })

  const dataRows = token.rows.map(row =>
    new TableRow({
      children: row.map(cell =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: cell.text, font: ctx.font, size: ctx.size })] })],
        })
      ),
    })
  )

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  })
}

// ── Inline ──

function inlineToRun(token: any, ctx: StyleCtx): TextRun {
  if (!token) return new TextRun({ text: '', font: ctx.font, size: ctx.size })

  if (token.type === 'strong') {
    return new TextRun({ text: token.text || token.raw, font: ctx.font, size: ctx.size, bold: true })
  }
  if (token.type === 'em') {
    return new TextRun({ text: token.text || token.raw, font: ctx.font, size: ctx.size, italics: true })
  }
  if (token.type === 'del') {
    return new TextRun({ text: token.text || token.raw, font: ctx.font, size: ctx.size, strike: true })
  }
  if (token.type === 'codespan') {
    return new TextRun({ text: token.text || token.raw, font: 'Consolas', size: 18, color: 'CC0000' })
  }
  if (token.type === 'link') {
    return new TextRun({ text: token.text || token.href, font: ctx.font, size: ctx.size, color: '0071E3', underline: {} })
  }
  if (token.type === 'br') {
    return new TextRun({ break: 1 })
  }
  return new TextRun({ text: token.text || token.raw || '', font: ctx.font, size: ctx.size })
}
