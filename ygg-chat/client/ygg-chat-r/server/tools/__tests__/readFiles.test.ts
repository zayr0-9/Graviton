import { describe, expect, it } from 'vitest'
import { formatReadFilesContent, readMultipleTextFiles } from '../readFiles.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('readMultipleTextFiles', () => {
  it('returns ordered structured results and formatted concatenated content', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('src/a.ts', 'export const a = 1\n')
    await harness.writeFile('src/b.ts', 'export const b = 2\n')

    const files = await readMultipleTextFiles(['src/a.ts', 'src/b.ts'], {
      cwd: harness.workspaceDir,
      baseDir: harness.workspaceDir,
    })

    expect(files.map(file => file.filename)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files.map(file => file.success)).toEqual([true, true])
    expect(files[0].content).toBe('export const a = 1\n')
    expect(files[1].content).toBe('export const b = 2\n')

    expect(formatReadFilesContent(files)).toBe(
      '--- src/a.ts ---\nexport const a = 1\n\n\n--- src/b.ts ---\nexport const b = 2\n'
    )
  })

  it('keeps per-file errors structured while rendering them clearly in concatenated content', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('exists.txt', 'present')

    const files = await readMultipleTextFiles(['exists.txt', 'missing.txt'], {
      cwd: harness.workspaceDir,
      baseDir: harness.workspaceDir,
    })

    expect(files[0].success).toBe(true)
    expect(files[1].success).toBe(false)
    expect(files[1].error).toMatch(/does not exist|not accessible/)
    expect(files[1].content).toMatch(/^\[Error reading file:/)
    expect(formatReadFilesContent(files)).toContain('--- missing.txt ---\n[Error reading file:')
  })

  it('passes ranges through to each file', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('one.txt', '1\n2\n3\n4\n5')
    await harness.writeFile('two.txt', 'a\nb\nc\nd\ne')

    const files = await readMultipleTextFiles(['one.txt', 'two.txt'], {
      cwd: harness.workspaceDir,
      baseDir: harness.workspaceDir,
      ranges: [
        { startLine: 2, endLine: 3 },
        { startLine: 5, endLine: 5 },
      ],
    })

    expect(files[0].content).toBe('2\n3\n\n5')
    expect(files[1].content).toBe('b\nc\n\ne')
    expect(files[0].ranges).toEqual([
      { startLine: 2, endLine: 3, lineCount: 2 },
      { startLine: 5, endLine: 5, lineCount: 1 },
    ])
  })
})
