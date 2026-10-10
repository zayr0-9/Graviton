import * as path from 'path'
import { promises as fs } from 'fs'
import { describe, expect, it } from 'vitest'
import { createTextFile } from '../createFile.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('createTextFile workspace enforcement', () => {
  it('blocks file creation outside workspace', async () => {
    const harness = await createToolFsHarness()
    const outsidePath = path.resolve(harness.workspaceDir, '..', 'outside-create.txt')

    const result = await createTextFile(outsidePath, 'outside', {
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.created).toBe(false)
    expect(result.message).toMatch(/outside the workspace/)
  })

  it('allows file creation inside workspace', async () => {
    const harness = await createToolFsHarness()

    const result = await createTextFile('nested/inside.txt', 'hello', {
      cwd: harness.workspaceDir,
      createParentDirs: true,
    })

    expect(result.success).toBe(true)
    expect(result.created).toBe(true)
    expect(await harness.fileExists('nested/inside.txt')).toBe(true)
    expect(await harness.readFile('nested/inside.txt')).toBe('hello')
  })

  it('resolves relative paths from cwd like read_file/edit_file', async () => {
    const harness = await createToolFsHarness()

    const result = await createTextFile('deep/path/from-cwd.txt', 'cwd-relative', {
      cwd: harness.workspaceDir,
      createParentDirs: true,
    })

    expect(result.success).toBe(true)
    expect(result.created).toBe(true)
    expect(await harness.fileExists('deep/path/from-cwd.txt')).toBe(true)
    expect(await harness.readFile('deep/path/from-cwd.txt')).toBe('cwd-relative')
  })

  it('does not overwrite when concurrent writers both see an absent file', async () => {
    const harness = await createToolFsHarness()
    const results = await Promise.all(['first', 'second'].map(content =>
      createTextFile('race.txt', content, { cwd: harness.workspaceDir })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    const winner = results[0].success ? 'first' : 'second'
    expect(await harness.readFile('race.txt')).toBe(winner)
    expect((await createTextFile('race.txt', 'replacement', { cwd: harness.workspaceDir, overwrite: true })).success).toBe(true)
    expect(await harness.readFile('race.txt')).toBe('replacement')
  })

  it.skipIf(process.platform === 'win32')('rejects file, parent and dangling symlink escapes before creating directories', async () => {
    const harness = await createToolFsHarness()
    const outside = await createToolFsHarness()
    await outside.writeFile('existing.txt', 'original')
    await fs.symlink(outside.absolutePath('existing.txt'), harness.absolutePath('file-link'))
    await fs.symlink(outside.workspaceDir, harness.absolutePath('dir-link'))
    await fs.symlink(outside.absolutePath('missing.txt'), harness.absolutePath('dangling'))
    for (const target of ['file-link', 'dir-link/new/nested.txt', 'dangling']) {
      const result = await createTextFile(target, 'replacement', { cwd: harness.workspaceDir, overwrite: true })
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/denied/)
    }
    expect(await outside.readFile('existing.txt')).toBe('original')
    expect(await outside.fileExists('new')).toBe(false)
    expect(await outside.fileExists('missing.txt')).toBe(false)
  })

  if (process.platform === 'win32') {
    it('allows creation under drive-root workspace (regression)', async () => {
      const harness = await createToolFsHarness()
      const targetPath = harness.absolutePath('drive-root-regression.txt')
      const driveRoot = path.parse(targetPath).root

      await fs.rm(targetPath, { force: true })

      const result = await createTextFile(targetPath, 'ok', {
        cwd: driveRoot,
        createParentDirs: true,
        overwrite: true,
      })

      expect(result.success).toBe(true)
      expect(result.created).toBe(true)
      expect(await fs.readFile(targetPath, 'utf8')).toBe('ok')
    })
  }
})