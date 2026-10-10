import * as os from 'os'
import * as path from 'path'
import { promises as fs } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'
import { readTextFile, readFileContinuation } from '../readFile.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('readTextFile workspace enforcement', () => {
  it('blocks traversal outside workspace for relative paths', async () => {
    const harness = await createToolFsHarness()

    const outsidePath = path.resolve(harness.workspaceDir, '..', 'outside-read.txt')
    await fs.writeFile(outsidePath, 'outside', 'utf8')

    await expect(
      readTextFile('../outside-read.txt', {
        cwd: harness.workspaceDir,
      })
    ).rejects.toThrow(/outside the workspace/)
  })

  it('allows reading files inside workspace', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('inside.txt', 'hello\\nworld\\n')

    const result = await readTextFile('inside.txt', { cwd: harness.workspaceDir })
    expect(result.content).toBe('hello\\nworld\\n')
    expect(result.truncated).toBe(false)
  })

  it('allows reading managed custom-tools paths outside workspace', async () => {
    const harness = await createToolFsHarness()
    const originalUserData = process.env.YGG_APP_USER_DATA

    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-user-data-'))
    try {
      process.env.YGG_APP_USER_DATA = userDataDir
      const managedFile = path.join(userDataDir, 'custom-tools', 'demo-tool', 'index.ts')
      await fs.mkdir(path.dirname(managedFile), { recursive: true })
      await fs.writeFile(managedFile, 'export const ok = true\n', 'utf8')

      const result = await readTextFile(managedFile, { cwd: harness.workspaceDir })
      expect(result.content).toContain('export const ok = true')
      expect(result.truncated).toBe(false)
    } finally {
      if (originalUserData === undefined) {
        delete process.env.YGG_APP_USER_DATA
      } else {
        process.env.YGG_APP_USER_DATA = originalUserData
      }
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })
})

describe('readTextFile option behavior', () => {
  it('defaults to includeHash=false when omitted', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('hash-default-off.txt', 'a\nb\n')

    const result = await readTextFile('hash-default-off.txt', {
      cwd: harness.workspaceDir,
    })

    expect(result.contentHash).toBeUndefined()
    expect(result.fileHash).toBeUndefined()
  })

  it('respects includeHash=false', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('hashless.txt', 'a\nb\n')

    const result = await readTextFile('hashless.txt', {
      cwd: harness.workspaceDir,
      includeHash: false,
    })

    expect(result.contentHash).toBeUndefined()
    expect(result.fileHash).toBeUndefined()
  })

  it('returns content hash without full-file hash for bounded line reads', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('bounded-lines.txt', Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join('\n'))

    const result = await readTextFile('bounded-lines.txt', {
      cwd: harness.workspaceDir,
      startLine: 5,
      endLine: 8,
      includeHash: true,
    })

    expect(result.content).toBe('line-5\nline-6\nline-7\nline-8')
    expect(result.contentHash).toBeTruthy()
    expect(result.fileHash).toBeUndefined()
    expect(result.totalLines).toBeUndefined()
  })

  it('validates line numbers before reading', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('lines.txt', 'one\ntwo\nthree\n')

    await expect(
      readTextFile('lines.txt', {
        cwd: harness.workspaceDir,
        startLine: 0,
      })
    ).rejects.toThrow(/startLine must be an integer >= 1/)

    await expect(
      readTextFile('lines.txt', {
        cwd: harness.workspaceDir,
        endLine: 1.5,
      })
    ).rejects.toThrow(/endLine must be an integer >= 1/)

    await expect(
      readTextFile('lines.txt', {
        cwd: harness.workspaceDir,
        ranges: [{ startLine: 1, endLine: 0 }],
      })
    ).rejects.toThrow(/ranges\[0\]\.endLine must be an integer >= 1/)
  })

  it('continuation reads expected next chunk', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('continuation.txt', '1\n2\n3\n4\n5\n')

    const result = await readFileContinuation('continuation.txt', 2, 2, {
      cwd: harness.workspaceDir,
      includeHash: false,
    })

    expect(result.content).toBe('3\n4')
    expect(result.startLine).toBe(3)
    expect(result.endLine).toBe(4)
  })
})


describe('readTextFile safety and fidelity', () => {
  it('bounds long lines and continuation reads with an explicit resume line', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('long.txt', 'x'.repeat(200000) + '\nlast')
    const result = await readFileContinuation('long.txt', 0, 2, { cwd: h.workspaceDir, maxBytes: 8 })
    expect(result).toMatchObject({ content: 'xxxxxxxx', truncated: true, nextLine: 1, partialLastLine: true, endLine: 1 })
  })

  it('preserves mixed endings and CRLF across a chunk boundary', async () => {
    const h = await createToolFsHarness()
    const text = 'x'.repeat(65535) + '\r\nb\nc\r'
    await h.writeFile('mixed.txt', text)
    const result = await readTextFile('mixed.txt', { cwd: h.workspaceDir, startLine: 1 })
    expect(result.content).toBe(text)
    expect(result.metadata.lineEnding).toBe('mixed')
    expect(result.totalLines).toBe(3)
  })

  it('does not split UTF-8 at the budget boundary and omits partial file hashes', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('utf8.txt', 'a😀b')
    for (const extra of [{}, { startLine: 1 }]) {
      const result = await readTextFile('utf8.txt', { cwd: h.workspaceDir, maxBytes: 3, includeHash: true, ...extra })
      expect(result.content).toBe('a')
      expect(result.truncated).toBe(true)
      expect(result.fileHash).toBeUndefined()
      expect(result.contentHash).toBeTruthy()
    }
  })

  it('shares the budget across ordered ranges and reports the unfinished range', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('ranges.txt', 'aa\r\nbb\ncc\ndd')
    const ranges = [{ startLine: 3, endLine: 4 }, { startLine: 1, endLine: 2 }]
    const full = await readTextFile('ranges.txt', { cwd: h.workspaceDir, ranges })
    expect(full.content).toBe('cc\ndd\n\naa\r\nbb')
    const limited = await readTextFile('ranges.txt', { cwd: h.workspaceDir, ranges, maxBytes: 8 })
    expect(limited.content).toBe('cc\ndd\n\na')
    expect(limited).toMatchObject({ truncated: true, nextRangeIndex: 1, nextLine: 1, partialLastLine: true })
    const boundary = await readTextFile('ranges.txt', { cwd: h.workspaceDir, ranges, maxBytes: 5 })
    expect(boundary).toMatchObject({ content: 'cc\ndd', nextRangeIndex: 1, nextLine: 1, partialLastLine: false })
  })

  it('reports a safe next line when the budget ends at a line boundary', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('lines.txt', 'aa\r\nbb\ncc')
    const result = await readTextFile('lines.txt', { cwd: h.workspaceDir, startLine: 1, maxBytes: 2 })
    expect(result).toMatchObject({ content: 'aa', nextLine: 2, endLine: 1, truncated: true, partialLastLine: false })
    const next = await readFileContinuation('lines.txt', result.nextLine! - 1, 2, { cwd: h.workspaceDir })
    expect(next.content).toBe('bb\ncc')
  })

  it('allows sibling workspace files from a nested cwd and dotdot-prefixed names', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('src/index.txt', 'index')
    await h.writeFile('..notes', 'notes')
    const result = await readTextFile('../..notes', { cwd: h.absolutePath('src'), workspaceRoot: h.workspaceDir })
    expect(result.content).toBe('notes')
  })

  it('rejects symlinks escaping the workspace but allows internal symlinks', async () => {
    const h = await createToolFsHarness()
    const outside = await createToolFsHarness()
    await outside.writeFile('external.txt', 'outside')
    await h.writeFile('inside.txt', 'inside')
    await fs.symlink(outside.workspaceDir, h.absolutePath('escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.symlink(h.workspaceDir, h.absolutePath('internal'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readTextFile('escape/external.txt', { cwd: h.workspaceDir })).rejects.toThrow(/outside the workspace/)
    expect((await readTextFile('internal/inside.txt', { cwd: h.workspaceDir })).content).toBe('inside')
  })

  it('rejects invalid budgets, ranges and continuation numbers before I/O', async () => {
    for (const maxBytes of [0, -1, 1.5, Infinity, NaN, 5242881]) {
      await expect(readTextFile('missing', { maxBytes })).rejects.toThrow(/maxBytes/)
    }
    for (const ranges of [[], Array.from({ length: 33 }, () => ({ startLine: 1, endLine: 1 }))]) {
      await expect(readTextFile('missing', { ranges })).rejects.toThrow(/ranges/)
    }
    for (const [after, count] of [[NaN, 1], [0.5, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER, 1]]) {
      await expect(readFileContinuation('missing', after, count)).rejects.toThrow()
    }
  })

  it('gives ranges precedence over unused single-line arguments', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('lines.txt', 'one\ntwo')
    expect((await readTextFile('lines.txt', {
      cwd: h.workspaceDir, startLine: 0, endLine: -1, ranges: [{ startLine: 2, endLine: 2 }],
    })).content).toBe('two')
  })

  it('rejects cancelled and expired reads before I/O', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readTextFile('missing', { signal: controller.signal })).rejects.toThrow(/cancelled/)
    await expect(readTextFile('missing', { deadlineMs: Date.now() - 1 })).rejects.toThrow(/deadline/)
  })

  it('keeps exact-budget files complete and preserves empty/trailing lines', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('exact.txt', 'abc')
    await h.writeFile('empty.txt', '')
    await h.writeFile('trailing.txt', 'a\n')
    expect(await readTextFile('exact.txt', { cwd: h.workspaceDir, maxBytes: 3, includeHash: true }))
      .toMatchObject({ content: 'abc', truncated: false, fileHash: expect.any(String) })
    expect(await readTextFile('empty.txt', { cwd: h.workspaceDir, startLine: 1 }))
      .toMatchObject({ content: '', totalLines: 1, nextLine: 2, truncated: false })
    expect(await readTextFile('trailing.txt', { cwd: h.workspaceDir, startLine: 1 }))
      .toMatchObject({ content: 'a\n', totalLines: 2, nextLine: 3, truncated: false })
  })
})


describe('read file I/O regressions', () => {
  it('handles short reads without decoding uninitialized bytes', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('short.txt', 'abcdef')
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 2), position)) as typeof handle.read)
      return handle
    })
    try {
      expect(await readTextFile('short.txt', { cwd: h.workspaceDir, maxBytes: 3 }))
        .toMatchObject({ content: 'abc', truncated: true })
    } finally { spy.mockRestore() }
  })

  it('does not trust a stale size when the file shrinks after probing', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('shrink.txt', 'abcdef')
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      let calls = 0
      vi.spyOn(handle, 'read').mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        calls++
        if (calls > 2) return { bytesRead: 0, buffer }
        return read(buffer, offset, length, position)
      }) as typeof handle.read)
      return handle
    })
    try {
      expect(await readTextFile('shrink.txt', { cwd: h.workspaceDir, maxBytes: 3 }))
        .toMatchObject({ content: '', truncated: false })
    } finally { spy.mockRestore() }
  })

  it('stops an in-progress line scan when cancelled', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('cancel.txt', 'a'.repeat(200000) + '\nend')
    const controller = new AbortController()
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position)
        if (length === 65536) controller.abort()
        return result
      }) as typeof handle.read)
      return handle
    })
    try {
      await expect(readTextFile('cancel.txt', { cwd: h.workspaceDir, startLine: 2, signal: controller.signal }))
        .rejects.toThrow(/cancelled/)
    } finally { spy.mockRestore() }
  })
})

describe('agent read-tool definitions', () => {
  const ajv = new Ajv({ strict: false })
  it.each(['read_file', 'read_file_continuation', 'read_files'])('%s advertises bounded parameters without internal runtime controls', name => {
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === name)!
    const properties = definition.inputSchema.properties
    expect(properties.maxBytes).toMatchObject({ type: 'integer', minimum: 1, maximum: 5242880 })
    expect(properties.workspaceRoot).toBeUndefined()
    expect(properties.signal).toBeUndefined()
    expect(properties.deadlineMs).toBeUndefined()
    const validate = ajv.compile(definition.inputSchema)
    const args = name === 'read_files' ? { paths: ['file'] } : name === 'read_file' ? { path: 'file' } :
      { path: 'file', afterLine: 0, numLines: 1 }
    expect(validate(args)).toBe(true)
    expect(validate({ ...args, maxBytes: 5242881 })).toBe(false)
    if (properties.ranges) {
      expect(properties.ranges).toMatchObject({ minItems: 1, maxItems: 32 })
      expect(validate({ ...args, ranges: [] })).toBe(false)
      expect(validate({ ...args, ranges: Array(33).fill({ startLine: 1, endLine: 1 }) })).toBe(false)
    }
  })
})


it('does not emit half of a CRLF when the separator exceeds the range budget', async () => {
  const h = await createToolFsHarness()
  await h.writeFile('crlf.txt', 'a\r\nb')
  expect(await readTextFile('crlf.txt', { cwd: h.workspaceDir, startLine: 1, endLine: 2, maxBytes: 2 }))
    .toMatchObject({ content: 'a', truncated: true, endLine: 1, nextLine: 2, partialLastLine: false })
})
