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