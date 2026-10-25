import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { run } from '../htmlRenderer.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'

const html = '<!doctype html><html><head><style>body { color: red; }</style></head><body>café 😀</body></html>'

beforeEach(async () => {
  const storage = await createToolFsHarness('html-documents-')
  vi.stubEnv('YGG_APP_USER_DATA', storage.workspaceDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('html_renderer', () => {
  it('preserves inline HTML and the existing result shape', async () => {
    expect(await run({ html })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
    expect(await run({ html, allowUnsafe: true })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('reads absolute paths outside the cwd without changing the file', async () => {
    const workspace = await createToolFsHarness()
    const outside = await createToolFsHarness()
    const filePath = await outside.writeFile('page with spaces.html', html)

    expect(await run({ path: filePath, cwd: workspace.workspaceDir })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
    expect(await outside.readFile('page with spaces.html')).toBe(html)
  })

  it('resolves relative paths, including traversal outside cwd', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('page.html', html)
    await harness.writeFile('nested/other.html', html)

    expect(await run({ path: 'nested/other.html', cwd: harness.workspaceDir })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
    expect(await run({ path: '../page.html', cwd: harness.absolutePath('nested') })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('defaults relative paths to the process working directory', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('page.html', html)
    expect(await run({ path: path.relative(process.cwd(), filePath) })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('expands home paths and home-relative cwd', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('page.html', html)
    vi.spyOn(os, 'homedir').mockReturnValue(harness.workspaceDir)

    expect(await run({ path: '~/page.html' })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
    expect(await run({ path: 'page.html', cwd: '~' })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('follows symlinks to files outside cwd', async () => {
    const workspace = await createToolFsHarness()
    const outside = await createToolFsHarness()
    const target = await outside.writeFile('target.html', html)
    await fs.symlink(target, workspace.absolutePath('linked.html'), 'file')

    expect(await run({ path: 'linked.html', cwd: workspace.workspaceDir })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('does not gate by filename extension or path provenance', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('page.txt', html)
    expect(await run({ path: filePath })).toMatchObject({ success: true, html, documentId: expect.stringMatching(/^html_/) })
  })

  it('returns structured errors for missing files and directories', async () => {
    const harness = await createToolFsHarness()
    expect(await run({ path: harness.absolutePath('missing.html') })).toMatchObject({
      success: false, error: expect.stringContaining('Unable to read HTML file'),
    })
    expect(await run({ path: harness.workspaceDir })).toEqual({
      success: false, error: 'path must point to a regular file',
    })
  })

  it('reports OS read errors rather than hiding them', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('page.html', html)
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('EACCES: permission denied'))
    expect(await run({ path: filePath })).toMatchObject({
      success: false, error: expect.stringContaining('EACCES: permission denied'),
    })
  })

  it('rejects empty files, invalid inputs, and conflicting sources', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('empty.html', ' \n')
    for (const params of [{}, { html: '' }, { html: ' \n' }, { path: '' }, { path: ' ' }, { path: filePath }, { path: filePath, cwd: '' }]) {
      expect(await run(params)).toMatchObject({ success: false, error: expect.any(String) })
    }
    expect(await run({ html, path: filePath })).toEqual({
      success: false, error: 'Provide either html or path, not both',
    })
  })

  it('exports persisted source after module reload without resending HTML', async () => {
    const context = { conversationId: 'chat-a', rootPath: '/workspace-a' }
    const rendered = await run({ html }, context)
    expect(rendered.success).toBe(true)
    const documentId = rendered.documentId!
    vi.resetModules()
    const restarted = await import('../htmlRenderer.js')
    const exported = await restarted.run({ action: 'export', documentId }, context)
    expect(exported).toMatchObject({ success: true, documentId, sizeBytes: Buffer.byteLength(html) })
    expect(exported).not.toHaveProperty('html')
    expect(exported.path).toContain(`${path.sep}.ygg${path.sep}html-documents${path.sep}`)
    expect(await fs.readFile(exported.path!, 'utf8')).toBe(html)
    expect(await restarted.run({ action: 'export', documentId }, context)).toEqual(exported)
    expect(await restarted.run({ documentId }, context)).toEqual({ success: true, documentId, html })
  })

  it('publishes concurrent exports atomically and cleans up staging files', async () => {
    const rendered = await run({ html: html.repeat(10000) })
    const exports = await Promise.all(Array.from({ length: 8 }, () => run({ action: 'export', documentId: rendered.documentId })))
    expect(exports.every(result => result.success)).toBe(true)
    expect(new Set(exports.map(result => result.path)).size).toBe(1)
    expect(await fs.readdir(path.dirname(exports[0].path!))).toEqual([`${rendered.documentId}.html`])
  })

  it('snapshots file input instead of rereading a changed source during export', async () => {
    const source = await createToolFsHarness()
    const filePath = await source.writeFile('page.html', html)
    const rendered = await run({ path: filePath })
    await fs.writeFile(filePath, '<p>changed</p>')
    const exported = await run({ action: 'export', documentId: rendered.documentId })
    expect(exported.success).toBe(true)
    expect(await fs.readFile(exported.path!, 'utf8')).toBe(html)
  })

  it('scopes IDs to trusted conversation or workspace context', async () => {
    const context = { conversationId: 'chat-a' }
    const rendered = await run({ html }, context)
    for (const foreign of [{ conversationId: 'chat-b' }, { rootPath: '/workspace-a' }, {}]) {
      expect(await run({ action: 'export', documentId: rendered.documentId }, foreign)).toMatchObject({ success: false })
    }
    const workspace = await run({ html }, { rootPath: '/workspace-a' })
    expect(await run({ documentId: workspace.documentId }, { rootPath: '/workspace-b' })).toMatchObject({ success: false })
  })

  it('rejects invalid IDs, conflicting inputs, and unsupported actions', async () => {
    for (const documentId of ['../../escape', '', 'html_missing']) {
      expect(await run({ action: 'export', documentId })).toMatchObject({ success: false })
    }
    const rendered = await run({ html })
    expect(await run({ documentId: rendered.documentId, html })).toMatchObject({ success: false })
    expect(await run({ action: 'export', documentId: rendered.documentId, html })).toMatchObject({ success: false })
    expect(await run({ action: 'export', documentId: rendered.documentId, path: '/elsewhere' })).toMatchObject({ success: false })
    expect(await run({ action: 'invalid' as 'render', html })).toMatchObject({ success: false })
    expect(await run({ action: 'export' })).toMatchObject({ success: false })
  })

  it('never overwrites an edited export or follows an existing export symlink', async () => {
    const rendered = await run({ html })
    const exported = await run({ action: 'export', documentId: rendered.documentId })
    await fs.writeFile(exported.path!, 'user edit')
    expect(await run({ action: 'export', documentId: rendered.documentId })).toMatchObject({ success: false })
    expect(await fs.readFile(exported.path!, 'utf8')).toBe('user edit')
    const outside = await createToolFsHarness()
    const target = await outside.writeFile('target.html', html)
    await fs.unlink(exported.path!)
    await fs.symlink(target, exported.path!, 'file')
    expect(await run({ action: 'export', documentId: rendered.documentId })).toMatchObject({ success: false })
    expect(await fs.readFile(target, 'utf8')).toBe(html)
  })

  it('reports storage errors without claiming a successful saved render', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'))
    expect(await run({ html })).toMatchObject({ success: false, error: expect.stringContaining('ENOSPC') })
  })

  it('advertises path/cwd and does not require inline html', () => {
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'html_renderer')!
    expect(definition.inputSchema.properties.path.type).toBe('string')
    expect(definition.inputSchema.properties.cwd.type).toBe('string')
    expect(definition.inputSchema.required).not.toContain('html')
  })
})
