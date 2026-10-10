import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

const bridge = vi.hoisted(() => ({ root: '' }))
vi.mock('../../utils/wslBridge.js', () => ({
  isWSLPath: (value: string) => value.startsWith('/home/test/'),
  toWslPath: (value: string) => value,
  resolveToWindowsPath: async (value: string) => value.replace('/home/test/project', bridge.root),
}))
import { editFile } from '../editFile.js'

describe('edit WSL resolution', () => {
  it('uses the WSL cwd for relative reads and writes', async () => {
    const h = await createToolFsHarness()
    bridge.root = h.workspaceDir
    await h.writeFile('src/file.txt', 'alpha')
    const first = await editFile('src/file.txt', 'replace', { cwd: '/home/test/project', searchPattern: 'alpha', replacement: 'beta' })
    const second = await editFile('src/new.txt', 'append', { cwd: '/home/test/project', content: 'created' })
    expect(first.success, first.message).toBe(true)
    expect(second.success, second.message).toBe(true)
    expect(await h.readFile('src/file.txt')).toBe('beta')
    expect(await h.readFile(path.join('src', 'new.txt'))).toBe('created')
    const denied = await editFile('../escape.txt', 'append', { cwd: '/home/test/project', content: 'no' })
    expect(denied.success).toBe(false)
  })
})
