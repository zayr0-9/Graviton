import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createExternalLinkOpener, installNavigationGuards, isAppDocumentUrl } from '../../electron/externalLinks.js'

function opener(platform = 'darwin', dialogResponse = { response: 0, checkboxChecked: false }) {
  const deps = {
    platform,
    openExternal: vi.fn(async (_url: string) => {}),
    openPath: vi.fn(async (_path: string) => ''),
    showDialog: vi.fn(async (_parent: unknown, _options: unknown) => dialogResponse),
  }
  return { deps, ...createExternalLinkOpener(deps) }
}

describe('openExternalLink policy', () => {
  it.each(['https://example.com', 'http://example.com/a?b=1', 'mailto:a@b.co', 'tel:+15551234',
    'vscode://file/Users/x/a.ts:3', 'cursor://file/tmp/a.md', 'idea://open?file=/tmp/A.kt'])('opens %s without a prompt', async url => {
    const { deps, openExternalLink } = opener()
    expect(await openExternalLink(url)).toEqual({ success: true })
    expect(deps.openExternal).toHaveBeenCalledWith(url)
    expect(deps.showDialog).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'blob:https://x/y', 'chrome://settings', 'devtools://x', 'not a url', '', 42, null])('refuses %s', async url => {
    const { deps, openExternalLink } = opener()
    expect((await openExternalLink(url)).success).toBe(false)
    expect(deps.openExternal).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it.each(['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'search:query=x', 'smb://host/share', 'ms-settings:privacy'])('refuses Windows handler %s on win32', async url => {
    const { deps, openExternalLink } = opener('win32')
    expect((await openExternalLink(url)).success).toBe(false)
    expect(deps.openExternal).not.toHaveBeenCalled()
    expect(deps.showDialog).not.toHaveBeenCalled()
  })

  it('sends file links to openPath, never openExternal', async () => {
    const { deps, openExternalLink } = opener()
    expect(await openExternalLink('file:///tmp/a.md')).toEqual({ success: true })
    expect(deps.openPath).toHaveBeenCalledWith('file:///tmp/a.md')
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('asks before opening other app schemes and honours Cancel', async () => {
    const { deps, openExternalLink } = opener('darwin', { response: 1, checkboxChecked: false })
    expect(await openExternalLink('slack://channel?id=1')).toEqual({ success: false, cancelled: true })
    expect(deps.showDialog).toHaveBeenCalledOnce()
    expect(deps.showDialog.mock.calls[0][1]).toMatchObject({ defaultId: 1, cancelId: 1, buttons: ['Open', 'Cancel'] })
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('remembers a "don\'t ask again" approval for that scheme only, this session', async () => {
    const { deps, openExternalLink } = opener('darwin', { response: 0, checkboxChecked: true })
    await openExternalLink('slack://channel?id=1')
    await openExternalLink('slack://channel?id=2')
    await openExternalLink('notion://page/1')
    expect(deps.showDialog).toHaveBeenCalledTimes(2)
    expect(deps.openExternal).toHaveBeenCalledTimes(3)
  })

  it('falls back to the OS default app when no editor is registered for an editor link', async () => {
    const { deps, openExternalLink } = opener()
    deps.openExternal.mockRejectedValueOnce(new Error('No application knows how to open URL'))
    expect(await openExternalLink('vscode://file/Users/x/a.ts:3:1')).toEqual({ success: true })
    expect(deps.openPath).toHaveBeenCalledWith('/Users/x/a.ts')
  })

  it('reports non-editor failures without a file fallback', async () => {
    const { deps, openExternalLink } = opener()
    deps.openExternal.mockRejectedValueOnce(new Error('boom'))
    expect(await openExternalLink('https://example.com')).toMatchObject({ success: false })
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('turns openPath errors and throws into failures', async () => {
    const { deps, openExternalLink } = opener()
    deps.openPath.mockResolvedValueOnce('Missing file')
    expect(await openExternalLink('file:///tmp/missing.md')).toEqual({ success: false, error: 'Missing file' })
    deps.openPath.mockRejectedValueOnce(new Error('bad path'))
    expect((await openExternalLink('file:///tmp/x')).success).toBe(false)
  })
})

describe('isAppDocumentUrl', () => {
  const entry = 'file:///app/dist-electron/index.html'
  it.each([
    [entry, true],
    [`${entry}#/chat/p/c`, true],
    ['file:///app/dist-electron/src/foo.ts', false],
    ['file:///Users/x/notes.md', false],
    ['https://example.com/', false],
    ['vscode://file/x', false],
    [`${entry}?x=1`, false],
  ])('%s → %s', (url, expected) => {
    expect(isAppDocumentUrl(entry, url, 'darwin')).toBe(expected)
  })

  it('matches the dev server origin root only', () => {
    expect(isAppDocumentUrl('http://localhost:5173/', 'http://localhost:5173/#/settings', 'darwin')).toBe(true)
    expect(isAppDocumentUrl('http://localhost:5173/', 'http://localhost:5173/src/app.ts', 'darwin')).toBe(false)
  })
})

describe('installNavigationGuards', () => {
  function guardedWindow() {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    const window = { isDestroyed: () => false, webContents: contents }
    const openLink = vi.fn(async (_url: string) => ({ success: true }))
    installNavigationGuards(window as never, 'file:///app/dist-electron/index.html', 'darwin', openLink)
    return { contents, openLink }
  }

  it('blocks in-window navigation away from the app and routes the link to the OS', () => {
    const { contents, openLink } = guardedWindow()
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, 'file:///app/dist-electron/src/foo.ts')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openLink).toHaveBeenCalledWith('file:///app/dist-electron/src/foo.ts')
  })

  it('lets the app document itself load', () => {
    const { contents, openLink } = guardedWindow()
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, 'file:///app/dist-electron/index.html#/homepage')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(openLink).not.toHaveBeenCalled()
  })

  it('denies every new Electron window and routes its URL to the OS', () => {
    const { contents, openLink } = guardedWindow()
    const handler = contents.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => unknown
    expect(handler({ url: 'vscode://file/tmp/a.ts' })).toEqual({ action: 'deny' })
    expect(openLink).toHaveBeenCalledWith('vscode://file/tmp/a.ts')
  })
})
