import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFullToolAccess, hasToolAccessTo, parseAdditionalCwds, withToolAccess } from '../../toolAccessContext.js'
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

  it('allows only the listed additional roots, by lexical and canonical path', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extra-roots-')))
    const cwd = path.join(root, 'workspace')
    const extra = path.join(root, 'extra')
    const other = path.join(root, 'other')
    const extraLink = path.join(root, 'extra-link')
    await Promise.all([cwd, extra, other].map(dir => fs.mkdir(dir)))
    await fs.symlink(extra, extraLink)
    await fs.writeFile(path.join(extra, 'shared.txt'), 'shared')
    await fs.writeFile(path.join(other, 'secret.txt'), 'secret')
    try {
      await withToolAccess(false, async () => {
        expect(hasFullToolAccess()).toBe(false)
        expect(validateAndResolvePath(path.join(extra, 'a.txt'), cwd)).toBe(path.join(extra, 'a.txt'))
        expect(() => validateAndResolvePath('../other/a.txt', cwd)).toThrow(/within workspace/)
        // A root given through a symlink still matches realpath'd targets.
        expect(hasToolAccessTo(path.join(extra, 'shared.txt'))).toBe(true)
        expect((await readTextFile(path.join(extraLink, 'shared.txt'), { cwd })).content).toBe('shared')
        expect((await createTextFile(path.join(extraLink, 'new.txt'), 'new', { cwd })).success).toBe(true)
        expect((await editFile(path.join(extra, 'new.txt'), 'replace', { cwd, searchPattern: 'new', replacement: 'edited' })).success).toBe(true)
        await deleteFile(path.join(extra, 'new.txt'), 'execute', cwd)
        await expect(readTextFile(path.join(other, 'secret.txt'), { cwd })).rejects.toThrow(/outside/)
        // A sibling whose name merely starts with the root is not inside it.
        expect(hasToolAccessTo(`${extra}-sibling/x`)).toBe(false)
      }, [extraLink])
      expect(hasToolAccessTo(path.join(extra, 'shared.txt'))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('parses the persisted column defensively', () => {
    expect(parseAdditionalCwds(null)).toEqual([])
    expect(parseAdditionalCwds('not json')).toEqual([])
    expect(parseAdditionalCwds(JSON.stringify(['/a', 'relative', '/a', 7, ' /b ']))).toEqual(['/a', '/b'])
  })
})
