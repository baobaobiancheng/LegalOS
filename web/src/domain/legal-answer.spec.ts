import { describe, expect, it } from 'vitest'
import { parseLegalAnswerBlocks } from './legal-answer'

describe('parseLegalAnswerBlocks', () => {
  it('把标题、正文和列表转换为安全展示块', () => {
    const blocks = parseLegalAnswerBlocks([
      '## 离婚财产分割规则',
      '',
      '**结论**：先协议，协议不成再由法院判决。',
      '',
      '- 核对共同财产范围',
      '- 核对债务性质',
    ].join('\n'))

    expect(blocks).toEqual([
      { key: 'heading-0', kind: 'heading', level: 2, text: '离婚财产分割规则' },
      { key: 'paragraph-1', kind: 'paragraph', text: '结论：先协议，协议不成再由法院判决。' },
      { key: 'list-2', kind: 'list', ordered: false, items: ['核对共同财产范围', '核对债务性质'] },
    ])
  })

  it('HTML 和未知语法只作为文本返回', () => {
    const blocks = parseLegalAnswerBlocks('<script>alert(1)</script>\n\n[法规链接](javascript:alert(1))')

    expect(blocks.map(block => 'text' in block ? block.text : block.items.join('')))
      .toEqual(['<script>alert(1)</script>', '法规链接'])
  })
})
