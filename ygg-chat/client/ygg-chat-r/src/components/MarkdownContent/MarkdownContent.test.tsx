import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultCustomChatTheme, getMarkdownThemeVars } from '../ThemeManager/themeConfig'
import { MarkdownContent } from './MarkdownContent'
import { MarkdownTable } from './MarkdownTable'

const themeState = vi.hoisted(() => ({ enabled: false, dark: false }))

vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return {
    ...actual,
    useCustomChatTheme: () => ({ theme: actual.createDefaultCustomChatTheme(), enabled: themeState.enabled }),
    useHtmlDarkMode: () => themeState.dark,
  }
})

vi.mock('../MermaidDiagram', () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => <div data-mermaid={chart} />,
  getMermaidSource: (child: React.ReactElement<{ children: string }>) => child.props.children.trim(),
  isMermaidCodeBlock: (child: React.ReactNode) => React.isValidElement<{ className?: string }>(child)
    && child.props.className?.includes('language-mermaid'),
  prepareMermaidMarkdown: (content: string) => content,
}))

const render = (content: string, style?: React.CSSProperties) => renderToStaticMarkup(
  <MarkdownContent content={content} style={style} />
)

beforeEach(() => {
  themeState.enabled = false
  themeState.dark = false
})

describe('shared Markdown tables', () => {
  it('preserves semantic tables, rich cells, and GFM alignment in a focusable scroll region', () => {
    const html = render('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **Bold** | `code` | [Link](https://example.com) |')
    expect(html).toContain('class="chat-markdown-table-scroll thin-scrollbar" tabindex="0" role="region" aria-label="Markdown table"')
    expect(html).toContain('<table><thead><tr><th style="text-align:left">Left</th>')
    expect(html).toContain('<th style="text-align:center">Center</th>')
    expect(html).toContain('<th style="text-align:right">Right</th>')
    expect(html).toContain('<tbody><tr><td style="text-align:left"><strong>Bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('node=')
  })

  it('wraps single-column and multiple tables independently', () => {
    const table = '| Header |\n| --- |\n| Value |'
    const html = render(`${table}\n\nBetween\n\n${table}`)
    expect(html.match(/chat-markdown-table-scroll/g)).toHaveLength(2)
    expect(html.match(/<th>Header<\/th>/g)).toHaveLength(2)
    expect(html).toContain('<p>Between</p>')
  })

  it('renders an incomplete streaming table without losing its wrapper', () => {
    const html = render('| Header |\n| --- |\n| Partial')
    expect(html).toContain('chat-markdown-table-scroll')
    expect(html).toContain('<td>Partial</td>')
  })

  it('preserves native table props but never forwards the parser node', () => {
    const html = renderToStaticMarkup(
      <MarkdownTable id='sample' className='sample-table' node={{ type: 'element', tagName: 'table', properties: {}, children: [] }}>
        <tbody><tr><td>Cell</td></tr></tbody>
      </MarkdownTable>
    )
    expect(html).toContain('<table id="sample" class="sample-table">')
    expect(html).not.toContain('node=')
  })
})

describe('Markdown rendering compatibility', () => {
  it('keeps ordinary and unknown-language fenced code selectable as pre/code markup', () => {
    const html = render('```javascript\nconst value = 1\n```\n\n```unregistered-language\nraw code\n```')
    expect(html.match(/<pre>/g)).toHaveLength(2)
    expect(html).toContain('language-javascript')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('raw code')
    expect(html).not.toContain('node=')
  })

  it('preserves nested quotes, inline code, lists, and authored capitalisation', () => {
    const html = render('> Sentence case\n>\n> > Nested `code`\n>\n> - List item\n\n## API overview')
    expect(html.match(/<blockquote>/g)).toHaveLength(2)
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>List item</li>')
    expect(html).toContain('<h2>API overview</h2>')
  })

  it('continues routing completed Mermaid fences to the diagram renderer', () => {
    const html = render('```mermaid\ngraph TD\nA --> B\n```')
    expect(html).toContain('data-mermaid="graph TD')
    expect(html).not.toContain('<pre>')
  })

  it('does not enable raw HTML', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('<script>')
  })
})

describe('Markdown theme propagation', () => {
  it.each([false, true])('applies existing custom Markdown colors in dark=%s', dark => {
    themeState.enabled = true
    themeState.dark = dark
    const expected = getMarkdownThemeVars(createDefaultCustomChatTheme(), dark)
    const html = render('Preview')
    expect(html).toContain(`--chat-md-table-header-bg:${expected['--chat-md-table-header-bg']}`)
    expect(html).toContain(`--chat-md-code-block-bg:${expected['--chat-md-code-block-bg']}`)
  })

  it('uses CSS fallbacks when custom themes are disabled', () => {
    expect(render('Preview')).not.toContain('--chat-md-table-header-bg:')
  })

  it('preserves caller style precedence and zoom', () => {
    themeState.enabled = true
    const style = { ...getMarkdownThemeVars(createDefaultCustomChatTheme(), false), '--chat-md-table-header-bg': '#123456', zoom: 1.25 }
    const html = render('Preview', style)
    expect(html).toContain('--chat-md-table-header-bg:#123456')
    expect(html).toContain('zoom:1.25')
  })
})
