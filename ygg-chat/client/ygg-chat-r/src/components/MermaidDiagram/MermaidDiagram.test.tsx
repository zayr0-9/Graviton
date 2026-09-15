import React from 'react'
import { describe, expect, it } from 'vitest'
import { getMermaidSource, isMermaidCodeBlock, prepareMermaidMarkdown } from './mermaidMarkdown'

describe('MermaidDiagram Markdown helpers', () => {
  it('recognizes Mermaid fenced-code children and extracts their source', () => {
    const node = React.createElement(
      'code',
      { className: 'hljs language-mermaid' },
      'graph TD\n  A --> B\n'
    )

    expect(isMermaidCodeBlock(node)).toBe(true)
    expect(getMermaidSource(node)).toBe('graph TD\n  A --> B')
  })

  it('leaves other fenced-code languages to the regular code renderer', () => {
    const node = React.createElement('code', { className: 'language-typescript' }, 'const value = 1')

    expect(isMermaidCodeBlock(node)).toBe(false)
  })

  it('marks an unterminated Mermaid fence as pending during streaming', () => {
    const markdown = 'Before\n\n```mermaid\nsequenceDiagram\n  A->>B: Hel'

    expect(prepareMermaidMarkdown(markdown)).toBe(
      'Before\n\n```mermaid-pending\nsequenceDiagram\n  A->>B: Hel'
    )
  })

  it('leaves a completed Mermaid fence unchanged', () => {
    const markdown = '```mermaid\ngraph TD\n  A --> B\n```\n\nAfter'

    expect(prepareMermaidMarkdown(markdown)).toBe(markdown)
  })

  it('only defers the final incomplete Mermaid block when earlier blocks are complete', () => {
    const markdown =
      '```mermaid\ngraph TD\n  A --> B\n```\n\n~~~Mermaid\nsequenceDiagram\n  A->>B: Waiting'

    expect(prepareMermaidMarkdown(markdown)).toBe(
      '```mermaid\ngraph TD\n  A --> B\n```\n\n~~~mermaid-pending\nsequenceDiagram\n  A->>B: Waiting'
    )
  })

  it('respects longer fences and does not close them with shorter fence runs', () => {
    const markdown = '````mermaid\ngraph TD\n```\n  A --> B\n'

    expect(prepareMermaidMarkdown(markdown)).toBe('````mermaid-pending\ngraph TD\n```\n  A --> B\n')
  })

  it('accepts spaces and tabs, but not other Unicode whitespace, after a closing fence', () => {
    const closed = '```mermaid\ngraph TD\n  A --> B\n``` \t'
    const stillOpen = '```mermaid\ngraph TD\n  A --> B\n```\u00a0'

    expect(prepareMermaidMarkdown(closed)).toBe(closed)
    expect(prepareMermaidMarkdown(stillOpen)).toBe('```mermaid-pending\ngraph TD\n  A --> B\n```\u00a0')
  })

  it('preserves CRLF line endings while marking a pending fence', () => {
    const markdown = 'Before\r\n```Mermaid\r\ngraph TD\r\n  A --> B'

    expect(prepareMermaidMarkdown(markdown)).toBe(
      'Before\r\n```mermaid-pending\r\ngraph TD\r\n  A --> B'
    )
  })

  it('does not rewrite an unterminated non-Mermaid fence', () => {
    const markdown = '```typescript\nconst value = 1'

    expect(prepareMermaidMarkdown(markdown)).toBe(markdown)
  })
})
