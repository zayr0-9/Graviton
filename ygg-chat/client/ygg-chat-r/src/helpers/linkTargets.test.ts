import { describe, expect, it } from 'vitest'
import { classifyLinkHref, joinLinkPath } from './linkTargets'
import { editorFilePath, stripLineSuffix } from '../../shared/linkPolicy'

describe('classifyLinkHref', () => {
  it.each([
    ['https://example.com/a', { kind: 'web', url: 'https://example.com/a' }],
    ['//example.com/a', { kind: 'web', url: 'https://example.com/a' }],
    ['mailto:a@b.co', { kind: 'mail', url: 'mailto:a@b.co' }],
    ['#heading', { kind: 'hash' }],
    ['/chat/p/c', { kind: 'route', route: '/chat/p/c' }],
    ['/chat/p/c#message', { kind: 'route', route: '/chat/p/c#message' }],
    ['/settings', { kind: 'route', route: '/settings' }],
    ['graviton:///chat/p/c', { kind: 'route', route: '/chat/p/c' }],
    ['graviton:///settings', { kind: 'blocked' }],
    ['/Users/x/notes.md', { kind: 'file', path: '/Users/x/notes.md' }],
    ['/Users/x/app.ts:12:4', { kind: 'file', path: '/Users/x/app.ts' }],
    ['/Users/x/app.ts#L12-L20', { kind: 'file', path: '/Users/x/app.ts' }],
    ['/Users/x/my%20notes.md', { kind: 'file', path: '/Users/x/my notes.md' }],
    ['/chat', { kind: 'file', path: '/chat' }],
    ['C:/repo/app.ts:3', { kind: 'file', path: 'C:\\repo\\app.ts' }],
    ['C:\\repo\\app.ts', { kind: 'file', path: 'C:\\repo\\app.ts' }],
    ['\\\\server\\share\\a.md', { kind: 'file', path: '\\\\server\\share\\a.md' }],
    ['~/notes.md', { kind: 'file', path: '~/notes.md' }],
    ['file:///Users/x/notes.md', { kind: 'file', path: '/Users/x/notes.md', fileUrl: 'file:///Users/x/notes.md' }],
    ['file:///Users/x/app.ts:9', { kind: 'file', path: '/Users/x/app.ts' }],
    ['vscode://file/Users/x/app.ts:10:2', { kind: 'app', url: 'vscode://file/Users/x/app.ts:10:2', editorPath: '/Users/x/app.ts' }],
    ['cursor://file/C:/repo/a.ts:1', { kind: 'app', url: 'cursor://file/C:/repo/a.ts:1', editorPath: 'C:/repo/a.ts' }],
    ['slack://channel?id=1', { kind: 'app', url: 'slack://channel?id=1', editorPath: null }],
    ['javascript:alert(1)', { kind: 'blocked' }],
    ['data:text/html,x', { kind: 'blocked' }],
    ['ms-msdt:/id', { kind: 'blocked' }],
    ['search-ms:query=x', { kind: 'blocked' }],
    ['', { kind: 'blocked' }],
    [undefined, { kind: 'blocked' }],
  ])('classifies %s', (href, expected) => {
    expect(classifyLinkHref(href as string | undefined)).toEqual(expected)
  })

  it('resolves relative paths against a posix cwd', () => {
    expect(classifyLinkHref('src/app.ts:12', { cwd: '/Users/x/repo/' })).toEqual({ kind: 'file', path: '/Users/x/repo/src/app.ts' })
    expect(classifyLinkHref('./docs/../README.md', { cwd: '/Users/x/repo' })).toEqual({ kind: 'file', path: '/Users/x/repo/README.md' })
  })

  it('resolves relative paths against a Windows cwd with native separators', () => {
    expect(classifyLinkHref('src/app.ts', { cwd: 'c:\\repo' })).toEqual({ kind: 'file', path: 'C:\\repo\\src\\app.ts' })
    expect(classifyLinkHref('a.md', { cwd: '\\\\server\\share\\repo' })).toEqual({ kind: 'file', path: '\\\\server\\share\\repo\\a.md' })
  })

  it('leaves relative paths unresolved without an absolute cwd', () => {
    expect(classifyLinkHref('src/app.ts')).toEqual({ kind: 'unresolved', path: 'src/app.ts' })
    expect(classifyLinkHref('src/app.ts', { cwd: 'relative/dir' })).toEqual({ kind: 'unresolved', path: 'src/app.ts' })
  })
})

describe('link policy helpers', () => {
  it('keeps the filesystem root when joining past it', () => {
    expect(joinLinkPath('/repo', '../../../etc/hosts')).toBe('/etc/hosts')
  })

  it.each([
    ['app.ts:12', 'app.ts'],
    ['app.ts:12:3', 'app.ts'],
    ['app.ts#L4', 'app.ts'],
    ['app.ts#L4C2-L9', 'app.ts'],
    ['C:\\repo', 'C:\\repo'],
    ['notes.md', 'notes.md'],
  ])('strips line suffix from %s', (input, expected) => {
    expect(stripLineSuffix(input)).toBe(expected)
  })

  it.each([
    ['vscode-insiders://file/tmp/a.ts:3', '/tmp/a.ts'],
    ['zed://file/tmp/a.ts', '/tmp/a.ts'],
    ['idea://open?file=/tmp/A.kt&line=3', '/tmp/A.kt'],
    ['subl://open?url=file:///tmp/a.py&line=2', '/tmp/a.py'],
    ['vscode://settings/editor', null],
    ['slack://file/tmp/a', null],
  ])('extracts the file path from %s', (url, expected) => {
    expect(editorFilePath(url)).toBe(expected)
  })
})
