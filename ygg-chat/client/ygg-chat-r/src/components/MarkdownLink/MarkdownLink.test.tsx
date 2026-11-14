import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownLink, markdownUrlTransform } from './MarkdownLink'

const { navigate, linkRoot, client } = vi.hoisted(() => ({ navigate: vi.fn(), linkRoot: { current: null as string | null }, client: { browser: false } }))
vi.mock('../ChatSelection/ChatSelectionProvider', () => ({ useOptionalChatNavigate: () => navigate }))
vi.mock('./markdownLinkRoot', () => ({ useMarkdownLinkRoot: () => linkRoot.current }))
vi.mock('../../platform/clientCapabilities', () => ({ get isBrowserClient() { return client.browser } }))

const fileUrl = 'file:///Users/karansingh/Vega/coinvest-agent-api-gaps.md'
const chatRoute = '/chat/a7dd257e-52ab-4963-a56f-2843cc82cf7d/b441a3dd-b8d9-4bda-91e9-dd610e09b720#bef47fca-59fb-4097-b9b9-8ebe0a0383db'
const gravitonUrl = `graviton://${chatRoute}`

async function clickLink(href?: string, props = {}) {
  const anchor = MarkdownLink({ href, ...props }) as React.ReactElement<{
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => Promise<void>
  }>
  const preventDefault = vi.fn()
  await anchor.props.onClick({ preventDefault } as unknown as React.MouseEvent<HTMLAnchorElement>)
  return preventDefault
}

describe('Markdown links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linkRoot.current = null
    client.browser = false
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
    vi.stubGlobal('window', { electronAPI: { shell: { openExternal } } })
    expect(await clickLink('https://example.com')).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it.each(['/chat/project/conversation', '/chat/p/c/lineage/l', '/settings', '/conversationPage?projectId=p'])('keeps app route %s on React Router', async route => {
    expect(await clickLink(route)).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(route)
  })

  it('renders the reported graviton chat link as an internal route with its message anchor', () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown components={{ a: MarkdownLink }} urlTransform={markdownUrlTransform}>
        {`[Open that chat](${gravitonUrl})`}
      </ReactMarkdown>
    )
    expect(html).toContain(`href="${chatRoute}"`)
    expect(html).toContain('Open that chat')
  })

  it.each([
    [gravitonUrl, chatRoute],
    [gravitonUrl.replace('graviton:', 'GRAVITON:'), chatRoute],
    ['graviton:///chat/project/conversation?view=tree#message%20id', '/chat/project/conversation?view=tree#message%20id'],
    ['graviton:///conversationPage?projectId=project', '/conversationPage?projectId=project'],
  ])('routes %s internally without opening a browser or OS protocol handler', async (url, route) => {
    const openExternal = vi.fn()
    const open = vi.fn()
    vi.stubGlobal('window', { electronAPI: { shell: { openExternal } }, open })
    expect(await clickLink(url)).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(route)
    expect(openExternal).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(markdownUrlTransform(url, 'href', { type: 'element', tagName: 'a', properties: {}, children: [] })).toBe(route)
  })

  it('does not allow graviton URLs as image sources', () => {
    expect(markdownUrlTransform(gravitonUrl, 'src', { type: 'element', tagName: 'img', properties: {}, children: [] })).toBe('')
  })

  it.each([
    'graviton://example.com/chat/project/conversation',
    'graviton:////example.com/chat/project/conversation',
    'graviton:///settings',
    'graviton:///chat/project',
    'graviton:///chat/project/conversation/extra',
    'graviton:///conversationPage',
    'graviton:///conversationPage?projectId=',
    'graviton:///chat/project/../../../example.com',
    'graviton:///%',
  ])('blocks malformed or unsupported graviton navigation: %s', async url => {
    expect(markdownUrlTransform(url, 'href', { type: 'element', tagName: 'a', properties: {}, children: [] })).toBe('')
    expect(await clickLink(url)).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('leaves hash navigation unchanged', async () => {
    expect(await clickLink('#section')).not.toHaveBeenCalled()
  })

  describe('editor, app and path links', () => {
    const anchor = { type: 'element' as const, tagName: 'a', properties: {}, children: [] }

    it.each(['vscode://file/Users/x/app.ts:10:2', 'cursor://file/tmp/a.md', 'idea://open?file=/tmp/a.kt&line=3', 'slack://channel?id=1'])('keeps %s clickable through the sanitizer', url => {
      expect(markdownUrlTransform(url, 'href', anchor)).toBe(url)
      expect(markdownUrlTransform(url, 'src', { ...anchor, tagName: 'img' })).toBe('')
    })

    it.each(['ms-msdt:/id', 'search-ms:query=x', 'blob:https://x/y', 'chrome://settings'])('strips dangerous scheme %s', url => {
      expect(markdownUrlTransform(url, 'href', anchor)).toBe('')
    })

    it('renders vscode links instead of stripping them to an empty href', () => {
      const html = renderToStaticMarkup(
        <ReactMarkdown components={{ a: MarkdownLink }} urlTransform={markdownUrlTransform}>
          {'[app.ts](vscode://file/Users/x/app.ts:10)'}
        </ReactMarkdown>
      )
      expect(html).toContain('href="vscode://file/Users/x/app.ts:10"')
    })

    it('hands editor links to the OS through openExternal, never the window', async () => {
      const openExternal = vi.fn().mockResolvedValue({ success: true })
      const open = vi.fn()
      vi.stubGlobal('window', { electronAPI: { shell: { openExternal } }, open })
      expect(await clickLink('vscode://file/Users/x/app.ts:10')).toHaveBeenCalledOnce()
      expect(openExternal).toHaveBeenCalledWith('vscode://file/Users/x/app.ts:10')
      expect(open).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
    })

    it('does not log when the user cancels an app-link confirmation', async () => {
      const openExternal = vi.fn().mockResolvedValue({ success: false, cancelled: true })
      vi.stubGlobal('window', { electronAPI: { shell: { openExternal } } })
      await clickLink('slack://channel?id=1')
      expect(console.error).not.toHaveBeenCalled()
    })

    it('resolves relative paths against the conversation cwd and drops line suffixes', async () => {
      linkRoot.current = '/Users/x/repo'
      const openPath = vi.fn().mockResolvedValue({ success: true })
      vi.stubGlobal('window', { electronAPI: { shell: { openPath } } })
      expect(await clickLink('src/app.ts:12')).toHaveBeenCalledOnce()
      expect(openPath).toHaveBeenCalledWith('/Users/x/repo/src/app.ts')
    })

    it('opens bare absolute paths as files instead of routing to them', async () => {
      const openPath = vi.fn().mockResolvedValue({ success: true })
      vi.stubGlobal('window', { electronAPI: { shell: { openPath } } })
      expect(await clickLink('/Users/x/notes.md')).toHaveBeenCalledOnce()
      expect(openPath).toHaveBeenCalledWith('/Users/x/notes.md')
      expect(navigate).not.toHaveBeenCalled()
    })

    it('prevents navigation and opens nothing for a relative path without a cwd', async () => {
      const openPath = vi.fn()
      vi.stubGlobal('window', { electronAPI: { shell: { openPath } } })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await clickLink('src/app.ts')).toHaveBeenCalledOnce()
      expect(openPath).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
    })

    it('opens editor links in the host editor on browser clients', async () => {
      client.browser = true
      const dispatchEvent = vi.fn()
      const openExternal = vi.fn()
      vi.stubGlobal('window', { dispatchEvent, electronAPI: { shell: { openExternal } } })
      expect(await clickLink('vscode://file/Users/x/app.ts:10')).toHaveBeenCalledOnce()
      expect(openExternal).not.toHaveBeenCalled()
      expect(dispatchEvent).toHaveBeenCalledOnce()
      expect((dispatchEvent.mock.calls[0][0] as CustomEvent).detail).toEqual({ path: '/Users/x/app.ts' })
    })

    it('routes middle-clicks through the same handler instead of opening a window', async () => {
      const openPath = vi.fn().mockResolvedValue({ success: true })
      vi.stubGlobal('window', { electronAPI: { shell: { openPath } } })
      const element = MarkdownLink({ href: '/Users/x/notes.md' }) as React.ReactElement<{ onAuxClick: (event: unknown) => void }>
      const preventDefault = vi.fn()
      element.props.onAuxClick({ button: 1, preventDefault })
      await Promise.resolve()
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(openPath).toHaveBeenCalledWith('/Users/x/notes.md')
    })
  })
})
