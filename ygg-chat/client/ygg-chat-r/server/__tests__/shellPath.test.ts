import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeShellPath } from '../../electron/shellPath.js'

describe('normalizeShellPath', () => {
  it('leaves existing plain filesystem paths unchanged', () => {
    const plainPath = path.resolve('notes with spaces.md')
    expect(normalizeShellPath(plainPath)).toBe(plainPath)
    expect(normalizeShellPath('C:\\Users\\test\\notes.md')).toBe('C:\\Users\\test\\notes.md')
  })

  it('decodes file URLs with spaces, Unicode, hashes, and percent signs', () => {
    const plainPath = path.resolve('notes ü #100%.md')
    expect(normalizeShellPath(pathToFileURL(plainPath).href)).toBe(plainPath)
    expect(normalizeShellPath(pathToFileURL(plainPath).href.replace(/^file:/, 'FILE:'))).toBe(plainPath)
  })

  it.each([undefined, null, 123, {}, '', '   ', '/tmp/test\0.md', 'file:///tmp/test%00.md', 'file:///tmp/test%ZZ.md', 'file:///tmp/test%2Fnotes.md', 'file://[invalid'])('rejects invalid input %s', value => {
    expect(() => normalizeShellPath(value)).toThrow()
  })

  it.skipIf(process.platform === 'win32')('opens the macOS/Linux example as a native path', () => {
    expect(normalizeShellPath('file:///Users/karansingh/Vega/coinvest-agent-api-gaps.md')).toBe('/Users/karansingh/Vega/coinvest-agent-api-gaps.md')
  })

  it.skipIf(process.platform === 'win32')('rejects remote-host file URLs on macOS/Linux', () => {
    expect(() => normalizeShellPath('file://server/share/notes.md')).toThrow()
  })

  it.skipIf(process.platform !== 'win32')('converts Windows drive and UNC URLs using native rules', () => {
    expect(normalizeShellPath('file:///C:/Users/test/notes%20one.md')).toBe('C:\\Users\\test\\notes one.md')
    expect(normalizeShellPath('file://server/share/notes.md')).toBe('\\\\server\\share\\notes.md')
  })
})
