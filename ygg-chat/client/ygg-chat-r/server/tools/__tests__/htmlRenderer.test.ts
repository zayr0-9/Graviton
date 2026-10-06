import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { run } from '../htmlRenderer.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'

const html = '<!doctype html><html><head><style>body { color: red; }</style></head><body>café 😀</body></html>'

afterEach(() => vi.restoreAllMocks())

describe('html_renderer', () => {
  it('preserves inline HTML and the existing result shape', async () => {
    expect(await run({ html })).toEqual({ success: true, html })
    expect(await run({ html, allowUnsafe: true })).toEqual({ success: true, html })
  })

  it('reads absolute paths outside the cwd without changing the file', async () => {
    const workspace = await createToolFsHarness()
    const outside = await createToolFsHarness()
    const filePath = await outside.writeFile('page with spaces.html', html)

    expect(await run({ path: filePath, cwd: workspace.workspaceDir })).toEqual({ success: true, html })
    expect(await outside.readFile('page with spaces.html')).toBe(html)
  })

  it('resolves relative paths, including traversal outside cwd', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('page.html', html)
    await harness.writeFile('nested/other.html', html)

    expect(await run({ path: 'nested/other.html', cwd: harness.workspaceDir })).toEqual({ success: true, html })
    expect(await run({ path: '../page.html', cwd: harness.absolutePath('nested') })).toEqual({ success: true, html })
  })

  it('defaults relative paths to the process working directory', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('page.html', html)
    expect(await run({ path: path.relative(process.cwd(), filePath) })).toEqual({ success: true, html })
  })

  it('expands home paths and home-relative cwd', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('page.html', html)
    vi.spyOn(os, 'homedir').mockReturnValue(harness.workspaceDir)

    expect(await run({ path: '~/page.html' })).toEqual({ success: true, html })
    expect(await run({ path: 'page.html', cwd: '~' })).toEqual({ success: true, html })
  })

  it('follows symlinks to files outside cwd', async () => {
    const workspace = await createToolFsHarness()
    const outside = await createToolFsHarness()
    const target = await outside.writeFile('target.html', html)
    await fs.symlink(target, workspace.absolutePath('linked.html'), 'file')

    expect(await run({ path: 'linked.html', cwd: workspace.workspaceDir })).toEqual({ success: true, html })
  })

  it('does not gate by filename extension or path provenance', async () => {
    const harness = await createToolFsHarness()
    const filePath = await harness.writeFile('page.txt', html)
    expect(await run({ path: filePath })).toEqual({ success: true, html })
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

  it('advertises path/cwd and does not require inline html', () => {
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'html_renderer')!
    expect(definition.inputSchema.properties.path.type).toBe('string')
    expect(definition.inputSchema.properties.cwd.type).toBe('string')
    expect(definition.inputSchema.required).not.toContain('html')
  })
})
