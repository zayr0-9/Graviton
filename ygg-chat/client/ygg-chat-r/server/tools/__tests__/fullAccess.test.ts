import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFullToolAccess, withToolAccess } from '../../toolAccessContext.js'
import { validateAndResolvePath } from '../../toolPathPolicy.js'
import { readTextFile } from '../readFile.js'
import { createTextFile } from '../createFile.js'
import { editFile } from '../editFile.js'
import { deleteFile } from '../deleteFile.js'

describe('full access', () => {
  it('isolates concurrent invocations and restores restricted access', async () => {
    expect(hasFullToolAccess()).toBe(false)
    await Promise.all([true, false].map(enabled => withToolAccess(enabled, async () => {
      await Promise.resolve()
      expect(hasFullToolAccess()).toBe(enabled)
      const resolve = () => validateAndResolvePath('../outside', '/workspace')
      if (enabled) expect(resolve()).toBe('/outside')
      else expect(resolve).toThrow(/within workspace/)
    })))
    expect(hasFullToolAccess()).toBe(false)
  })

  it('allows external file operations while preserving cwd and plan-mode restrictions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'full-access-'))
    const cwd = path.join(root, 'workspace')
    await fs.mkdir(cwd)
    await fs.writeFile(path.join(root, 'outside.txt'), 'before')
    await fs.writeFile(path.join(cwd, 'inside.txt'), 'inside')
    await fs.symlink(path.join(root, 'outside.txt'), path.join(cwd, 'link.txt'))
    try {
      await expect(readTextFile('../outside.txt', { cwd })).rejects.toThrow(/outside/)
      await expect(readTextFile('link.txt', { cwd })).rejects.toThrow(/outside/)
      await withToolAccess(true, async () => {
        expect((await readTextFile('../outside.txt', { cwd })).content).toBe('before')
        expect((await readTextFile('link.txt', { cwd })).content).toBe('before')
        expect((await readTextFile('inside.txt', { cwd })).content).toBe('inside')
        expect((await createTextFile('../created.txt', 'new', { cwd })).success).toBe(true)
        expect((await editFile('../outside.txt', 'replace', { cwd, searchPattern: 'before', replacement: 'after' })).success).toBe(true)
        expect((await createTextFile('../blocked.txt', '', { cwd, operationMode: 'plan' })).success).toBe(false)
        await deleteFile('../created.txt', 'execute', cwd)
      })
      expect(await fs.readFile(path.join(root, 'outside.txt'), 'utf8')).toBe('after')
      await expect(readTextFile('../outside.txt', { cwd })).rejects.toThrow(/outside/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
