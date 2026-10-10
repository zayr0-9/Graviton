import { describe, expect, it, vi } from 'vitest'
import * as wslBridge from '../../utils/wslBridge.js'
import { formatReadFilesContent, formatReadFilesResult, readMultipleTextFiles } from '../readFiles.js'
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

describe('read_files aggregate UTF-8 budget', () => {
  it('includes headers/separators and stops before later files', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('a.txt', 'a'.repeat(100))
    await harness.writeFile('b.txt', 'b'.repeat(100))
    const files = await readMultipleTextFiles(['a.txt', 'b.txt', 'missing.txt'], { cwd: harness.workspaceDir, maxBytes: 150 })
    const content = formatReadFilesContent(files)
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(150)
    expect(files).toHaveLength(2)
    expect(files[1].truncated).toBe(true)
    expect(content).not.toContain('missing.txt')
    expect(formatReadFilesResult(files, 3)).toEqual({ success: true, content, truncated: true,
      returnedCount: 2, omittedCount: 1, nextFileIndex: 1 })
  })

  it('caps line/range reads and does not split UTF-8 characters', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('unicode.txt', '😀'.repeat(100) + '\nsecond')
    for (const range of [{}, { startLine: 1, endLine: 1 }, { ranges: [{ startLine: 1, endLine: 2 }] }]) {
      const files = await readMultipleTextFiles(['unicode.txt'], { cwd: harness.workspaceDir, maxBytes: 50, ...range })
      expect(Buffer.byteLength(formatReadFilesContent(files))).toBeLessThanOrEqual(50)
      expect(files[0].content).not.toContain('�')
      expect(files[0].truncated).toBe(true)
    }
  })

  it('bounds error placeholders and tiny budgets', async () => {
    const harness = await createToolFsHarness()
    const errors = await readMultipleTextFiles(['missing.txt'], { cwd: harness.workspaceDir, maxBytes: 40 })
    expect(Buffer.byteLength(formatReadFilesContent(errors))).toBeLessThanOrEqual(40)
    expect(errors[0].success).toBe(false)
    const tiny = await readMultipleTextFiles(['missing.txt'], { cwd: harness.workspaceDir, maxBytes: 1 })
    expect(formatReadFilesContent(tiny)).toBe('')
  })
})


it('forwards cancellation/deadlines to WSL header resolution and stops before path work when cancelled', async () => {
  const controller = new AbortController()
  const deadlineMs = Date.now() + 10000
  const isWsl = vi.spyOn(wslBridge, 'isWSLPath').mockReturnValue(true)
  const resolve = vi.spyOn(wslBridge, 'resolveToWindowsPath').mockImplementation(async value => value)
  try {
    // Header does not fit, so no actual file access is necessary.
    await readMultipleTextFiles(['/fake/file'], { maxBytes: 1, signal: controller.signal, deadlineMs })
    expect(resolve).toHaveBeenCalledWith('/fake/file', expect.objectContaining({ signal: controller.signal, deadlineMs }))
    resolve.mockClear()
    controller.abort()
    await expect(readMultipleTextFiles(['/fake/file'], { signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(resolve).not.toHaveBeenCalled()
  } finally { resolve.mockRestore(); isWsl.mockRestore() }
})
