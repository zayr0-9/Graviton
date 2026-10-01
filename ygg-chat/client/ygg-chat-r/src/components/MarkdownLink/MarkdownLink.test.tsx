import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownLink, markdownUrlTransform } from './MarkdownLink'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))

const fileUrl = 'file:///Users/karansingh/Vega/coinvest-agent-api-gaps.md'

async function clickLink(href?: string, props = {}) {
  const anchor = MarkdownLink({ href, ...props }) as React.ReactElement<{
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => Promise<void>
  }>
  const preventDefault = vi.fn()
  await anchor.props.onClick({ preventDefault } as unknown as React.MouseEvent<HTMLAnchorElement>)
  return preventDefault
}

describe('Markdown file links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preserves file URLs in rendered Markdown anchors', () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown components={{ a: MarkdownLink }} urlTransform={markdownUrlTransform}>
        {`**[coinvest-agent-api-gaps.md](${fileUrl})**`}
      </ReactMarkdown>
    )
    expect(html).toContain(`href="${fileUrl}"`)
    expect(html).toContain('coinvest-agent-api-gaps.md')
  })

  it('allows file URLs only for anchor hrefs', () => {
    expect(markdownUrlTransform('FILE:///tmp/test.md', 'href', { type: 'element', tagName: 'a', properties: {}, children: [] })).toBe('FILE:///tmp/test.md')
    expect(markdownUrlTransform(fileUrl, 'src', { type: 'element', tagName: 'img', properties: {}, children: [] })).toBe('')
  })

  it.each(['https://example.com', 'http://example.com', '//example.com', '/chat/123', '#section', 'notes.md', 'mailto:test@example.com'])('preserves existing safe URL %s', url => {
    expect(markdownUrlTransform(url, 'href', { type: 'element', tagName: 'a', properties: {}, children: [] })).toBe(url)
  })

  it.each(['javascript:alert(1)', 'data:text/html,test', 'vbscript:test'])('still strips unsafe URL %s', url => {
    expect(markdownUrlTransform(url, 'href', { type: 'element', tagName: 'a', properties: {}, children: [] })).toBe('')
  })

  it('prevents navigation and sends the intact file URL through the existing bridge', async () => {
    const openPath = vi.fn().mockResolvedValue({ success: true })
    const open = vi.fn()
    vi.stubGlobal('window', { electronAPI: { shell: { openPath } }, open })
    const suppliedClick = vi.fn()
    expect(await clickLink(fileUrl, { onClick: suppliedClick })).toHaveBeenCalledOnce()
    expect(openPath).toHaveBeenCalledOnce()
    expect(openPath).toHaveBeenCalledWith(fileUrl)
    expect(navigate).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(suppliedClick).not.toHaveBeenCalled()
  })

  it.each(['returned error', 'thrown error', 'missing capability'])('never navigates when opening fails: %s', async failure => {
    const openPath = failure === 'thrown error'
      ? vi.fn().mockRejectedValue(new Error('Unavailable'))
      : vi.fn().mockResolvedValue({ success: false, error: 'Missing file' })
    const open = vi.fn()
    vi.stubGlobal('window', { electronAPI: failure === 'missing capability' ? {} : { shell: { openPath } }, open })
    expect(await clickLink(fileUrl)).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it.each(['', undefined])('prevents current-document navigation for an empty href (%s)', async href => {
    expect(await clickLink(href)).toHaveBeenCalledOnce()
  })

  it('keeps web links on the external-browser bridge', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { electronAPI: { auth: { openExternal } } })
    expect(await clickLink('https://example.com')).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('keeps internal routes on React Router', async () => {
    expect(await clickLink('/chat/123')).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/chat/123')
  })

  it('leaves hash navigation unchanged', async () => {
    expect(await clickLink('#section')).not.toHaveBeenCalled()
  })
})
