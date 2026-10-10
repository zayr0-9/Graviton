import { promises as fs } from 'fs'
import { describe, expect, it } from 'vitest'
import { editFile, multiEdit } from '../editFile.js'
import { readTextFile } from '../readFile.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('safe edit transactions', () => {
  it('edits complete files beyond the public 5 MiB read limit', async () => {
    const h = await createToolFsHarness()
    const original = 'x'.repeat(6 * 1024 * 1024) + '\nTARGET\nTAIL'
    await h.writeFile('large.txt', original)
    const result = await editFile('large.txt', 'replace_first', { cwd: h.workspaceDir, searchPattern: 'TARGET', replacement: 'DONE' })
    expect(result.success, result.message).toBe(true)
    expect(await h.readFile('large.txt')).toBe(original.replace('TARGET', 'DONE'))
  })

  it.each(['replace', 'replace_first', 'append'] as const)('rejects stale metadata by default for %s', async operation => {
    const h = await createToolFsHarness()
    await h.writeFile('state.txt', 'alpha')
    const read = await readTextFile('state.txt', { cwd: h.workspaceDir })
    const result = await editFile('state.txt', operation, { cwd: h.workspaceDir, searchPattern: 'alpha', replacement: 'beta', content: 'beta', expectedMetadata: { ...read.metadata, inode: -1 } })
    expect(result.success).toBe(false)
    expect(result.validation?.reason).toContain('inode')
    expect(await h.readFile('state.txt')).toBe('alpha')
  })

  it('does not recreate a deleted append target when metadata was supplied', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('gone.txt', 'alpha')
    const read = await readTextFile('gone.txt', { cwd: h.workspaceDir })
    await fs.unlink(h.absolutePath('gone.txt'))
    const result = await editFile('gone.txt', 'append', { cwd: h.workspaceDir, content: 'beta', expectedMetadata: read.metadata })
    expect(result.success).toBe(false)
    expect(await h.fileExists('gone.txt')).toBe(false)
  })

  it.each(['replace', 'append'] as const)('blocks outside symlink targets for %s', async operation => {
    const h = await createToolFsHarness()
    const outside = await createToolFsHarness()
    await outside.writeFile('victim.txt', 'alpha')
    await fs.symlink(outside.absolutePath('victim.txt'), h.absolutePath('link.txt'))
    const result = await editFile('link.txt', operation, { cwd: h.workspaceDir, searchPattern: 'alpha', replacement: 'beta', content: 'beta' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('Access denied')
    expect(await outside.readFile('victim.txt')).toBe('alpha')
  })

  it('blocks append through a symlinked parent and a dangling symlink', async () => {
    const h = await createToolFsHarness()
    const outside = await createToolFsHarness()
    await fs.symlink(outside.workspaceDir, h.absolutePath('directory'))
    await fs.symlink(outside.absolutePath('missing.txt'), h.absolutePath('dangling'))
    for (const file of ['directory/new.txt', 'dangling']) {
      expect((await editFile(file, 'append', { cwd: h.workspaceDir, content: 'no' })).success).toBe(false)
    }
    expect(await outside.fileExists('new.txt')).toBe(false)
    expect(await outside.fileExists('missing.txt')).toBe(false)
  })

  it.each(['latin1', 'utf16le'] as const)('preserves %s bytes and backups', async encoding => {
    const h = await createToolFsHarness()
    const original = Buffer.from('café marker', encoding)
    await fs.writeFile(h.absolutePath('encoded.txt'), original)
    const result = await editFile('encoded.txt', 'replace', { cwd: h.workspaceDir, encoding, searchPattern: 'marker', replacement: 'done', createBackup: true })
    expect(result.success, result.message).toBe(true)
    expect(await fs.readFile(h.absolutePath('encoded.txt'))).toEqual(Buffer.from('café done', encoding))
    expect(await fs.readFile(result.backup!)).toEqual(original)
  })

  it('rejects lossy UTF-8 decoding without touching the file', async () => {
    const h = await createToolFsHarness()
    const original = Buffer.from([0xff, 0x61])
    await fs.writeFile(h.absolutePath('invalid.txt'), original)
    const result = await editFile('invalid.txt', 'replace', { cwd: h.workspaceDir, searchPattern: 'a', replacement: 'b' })
    expect(result.success).toBe(false)
    expect(await fs.readFile(h.absolutePath('invalid.txt'))).toEqual(original)
  })

  it('serializes concurrent edits, including canonical aliases', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('shared.txt', 'alpha beta')
    await fs.symlink(h.absolutePath('shared.txt'), h.absolutePath('alias.txt'))
    const results = await Promise.all([
      editFile('shared.txt', 'replace', { cwd: h.workspaceDir, searchPattern: 'alpha', replacement: 'ALPHA' }),
      editFile('alias.txt', 'replace', { cwd: h.workspaceDir, searchPattern: 'beta', replacement: 'BETA' }),
    ])
    expect(results.every(r => r.success)).toBe(true)
    expect(await h.readFile('shared.txt')).toBe('ALPHA BETA')
  })

  it('detects external writes during the pre-write hook', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('race.txt', 'alpha')
    const result = await editFile('race.txt', 'replace', {
      cwd: h.workspaceDir, searchPattern: 'alpha', replacement: 'beta',
      beforeWrite: async () => { await h.writeFile('race.txt', 'external change') },
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('changed before writing')
    expect(await h.readFile('race.txt')).toBe('external change')
  })

  it('rejects a symlink retarget between batch items', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('a.txt', 'alpha')
    await h.writeFile('b.txt', 'beta')
    await h.writeFile('trigger.txt', 'trigger')
    await fs.symlink(h.absolutePath('a.txt'), h.absolutePath('alias.txt'))
    const result = await multiEdit([
      { path: 'alias.txt', operation: 'replace', searchPattern: 'alpha', replacement: 'ALPHA' },
      { path: 'trigger.txt', operation: 'replace', searchPattern: 'trigger', replacement: 'TRIGGER' },
      { path: 'alias.txt', operation: 'replace', searchPattern: 'beta', replacement: 'wrong' },
    ], {
      cwd: h.workspaceDir,
      beforeWrite: async (_absolute, original) => {
        if (original !== 'trigger.txt') return
        await fs.unlink(h.absolutePath('alias.txt'))
        await fs.symlink(h.absolutePath('b.txt'), h.absolutePath('alias.txt'))
      },
    })
    expect(result.results.map(r => r.success)).toEqual([true, true, false])
    expect(result.results[2].message).toContain('path changed between batch edits')
    expect(await h.readFile('b.txt')).toBe('beta')
  })

  it('validates the first batch item and continues after per-item errors', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('state.txt', 'alpha beta')
    const read = await readTextFile('state.txt', { cwd: h.workspaceDir })
    const result = await multiEdit([
      { path: '../outside.txt', operation: 'append', content: 'no' },
      { path: 'state.txt', operation: 'replace', searchPattern: 'alpha', replacement: 'ALPHA', expectedMetadata: { ...read.metadata, lastModified: new Date(0), inode: undefined } },
      { path: 'state.txt', operation: 'replace', searchPattern: 'beta', replacement: 'BETA', expectedMetadata: read.metadata },
    ], { cwd: h.workspaceDir, stopOnError: false })
    expect(result.results.map(r => r.success)).toEqual([false, false, true])
    expect(await h.readFile('state.txt')).toBe('alpha BETA')
  })
})

describe('conservative fast matching', () => {
  it('prefers an exact match outside an approximate hint over a local fuzzy match', async () => {
    const h = await createToolFsHarness()
    const original = 'const target = 2;\n' + '// padding\n'.repeat(220) + 'const target = 1;\n'
    await h.writeFile('hint.ts', original)
    const result = await editFile('hint.ts', 'replace_first', { cwd: h.workspaceDir, searchPattern: 'const target = 1;', replacement: 'DONE', approxStartLine: 1, approxEndLine: 1, enableFuzzyMatching: true })
    expect(result.matchStrategy).toBe('exact')
    expect(await h.readFile('hint.ts')).toBe(original.replace('const target = 1;', 'DONE'))
  })

  it('honors a zero line-hint window', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('zero.txt', 'same\npadding\nsame\n')
    const result = await editFile('zero.txt', 'replace_first', { cwd: h.workspaceDir, searchPattern: 'same', replacement: 'last', approxStartLine: 3, approxEndLine: 3, lineHintWindow: 0 })
    expect(result.success).toBe(true)
    expect(await h.readFile('zero.txt')).toBe('same\npadding\nlast\n')
  })

  it('does not guess fuzzy matches or normalize string contents by default', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('literal.ts', 'const text = "a  b";')
    const result = await editFile('literal.ts', 'replace', { cwd: h.workspaceDir, searchPattern: 'const text = "a b";', replacement: 'wrong' })
    expect(result.success).toBe(false)
    expect(await h.readFile('literal.ts')).toBe('const text = "a  b";')
  })

  it('preserves dedents during indentation correction', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('scope.py', '    if  x:\n        old()\nafter()')
    const result = await editFile('scope.py', 'replace', { cwd: h.workspaceDir, searchPattern: '    if x:\n        old()\nafter()', replacement: '    if x:\n        new()\nafter()' })
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await h.readFile('scope.py')).toBe('    if x:\n        new()\nafter()')
  })

  it('does not reindent line-ending-only matches', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('crlf.py', '    if x:\r\n        old()\r\nafter()')
    const replacement = '    if x:\n        new()\nafter()'
    const result = await editFile('crlf.py', 'replace', { cwd: h.workspaceDir, searchPattern: '    if x:\n        old()\nafter()', replacement })
    expect(result.matchStrategy).toBe('line_ending_normalized')
    expect(await h.readFile('crlf.py')).toBe(replacement)
  })

  it('fails closed on fuzzy work-budget exhaustion and equal candidates', async () => {
    const h = await createToolFsHarness()
    await h.writeFile('budget.txt', 'a'.repeat(3000))
    const budget = await editFile('budget.txt', 'replace', { cwd: h.workspaceDir, searchPattern: 'a'.repeat(2999) + 'b', replacement: 'no', enableFuzzyMatching: true })
    expect(budget.success).toBe(false)
    await h.writeFile('tie.txt', 'const n = 1;\nconst n = 2;')
    const tie = await editFile('tie.txt', 'replace', { cwd: h.workspaceDir, searchPattern: 'const n = 3;', replacement: 'no', enableFuzzyMatching: true })
    expect(tie.success).toBe(false)
  })
})
