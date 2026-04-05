import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it, test } from 'vitest'
import { editFile, multiEdit } from '../editFile.js'
import { readTextFile } from '../readFile.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('editFile operation contract', () => {
  it('blocks file edits in plan mode', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('plan.txt', 'alpha')

    const result = await editFile('plan.txt', 'replace', {
      searchPattern: 'alpha',
      replacement: 'beta',
      operationMode: 'plan',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('planning mode')
    expect(await harness.readFile('plan.txt')).toBe('alpha')
  })

  it('fails replace when searchPattern is missing', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('missing-search.txt', 'replace', {
      replacement: 'value',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('searchPattern and replacement are required for replace operation')
  })

  it('fails replace when replacement is missing', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('missing-replacement.txt', 'replace', {
      searchPattern: 'value',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('searchPattern and replacement are required for replace operation')
  })

  it('fails append when content is undefined', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('append-missing.txt', 'append', {
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('content is required for append operation')
  })

  it('fails for unknown operation', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('unknown.txt', 'rename' as any, {
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Unknown operation: rename')
  })
})

describe('multiEdit behavior', () => {
  it('applies multiple edits sequentially', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('alpha.txt', 'alpha')
    await harness.writeFile('beta.txt', 'beta')

    const result = await multiEdit(
      [
        {
          path: 'alpha.txt',
          operation: 'replace',
          searchPattern: 'alpha',
          replacement: 'ALPHA',
        },
        {
          path: 'beta.txt',
          operation: 'append',
          content: '\ngamma',
        },
      ],
      { cwd: harness.workspaceDir }
    )

    expect(result.success).toBe(true)
    expect(result.applied).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.stoppedEarly).toBe(false)
    expect(result.results).toHaveLength(2)
    expect(await harness.readFile('alpha.txt')).toBe('ALPHA')
    expect(await harness.readFile('beta.txt')).toBe('beta\ngamma')
  })

  it('stops on the first failed edit by default', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('first.txt', 'one')
    await harness.writeFile('third.txt', 'three')

    const result = await multiEdit(
      [
        {
          path: 'first.txt',
          operation: 'replace',
          searchPattern: 'one',
          replacement: 'ONE',
        },
        {
          path: 'missing.txt',
          operation: 'replace',
          searchPattern: 'two',
          replacement: 'TWO',
        },
        {
          path: 'third.txt',
          operation: 'replace',
          searchPattern: 'three',
          replacement: 'THREE',
        },
      ],
      { cwd: harness.workspaceDir }
    )

    expect(result.success).toBe(false)
    expect(result.applied).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.stoppedEarly).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(await harness.readFile('first.txt')).toBe('ONE')
    expect(await harness.readFile('third.txt')).toBe('three')
  })

  it('can continue past failures when stopOnError is false', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('first.txt', 'one')
    await harness.writeFile('third.txt', 'three')

    const result = await multiEdit(
      [
        {
          path: 'first.txt',
          operation: 'replace',
          searchPattern: 'one',
          replacement: 'ONE',
        },
        {
          path: 'missing.txt',
          operation: 'replace',
          searchPattern: 'two',
          replacement: 'TWO',
        },
        {
          path: 'third.txt',
          operation: 'replace',
          searchPattern: 'three',
          replacement: 'THREE',
        },
      ],
      { cwd: harness.workspaceDir, stopOnError: false }
    )

    expect(result.success).toBe(false)
    expect(result.applied).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.stoppedEarly).toBe(false)
    expect(result.results).toHaveLength(3)
    expect(await harness.readFile('first.txt')).toBe('ONE')
    expect(await harness.readFile('third.txt')).toBe('THREE')
  })
})

describe('editFile replace and replace_first behavior', () => {
  it('replace updates all exact occurrences', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('replace-all.txt', 'foo and foo and baz')

    const result = await editFile('replace-all.txt', 'replace', {
      searchPattern: 'foo',
      replacement: 'bar',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(2)
    expect(result.matchStrategy).toBe('exact')
    expect(result.lineInfo).toMatchObject({
      oldStartLine: 1,
      oldLineCount: 1,
      newStartLine: 1,
      newLineCount: 1,
      scope: 'first_of_many',
    })
    expect(await harness.readFile('replace-all.txt')).toBe('bar and bar and baz')
  })

  it('replace_first updates only the first exact occurrence', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('replace-first.txt', 'foo and foo and baz')

    const result = await editFile('replace-first.txt', 'replace_first', {
      searchPattern: 'foo',
      replacement: 'bar',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(result.lineInfo).toMatchObject({
      oldStartLine: 1,
      oldLineCount: 1,
      newStartLine: 1,
      newLineCount: 1,
      scope: 'single',
    })
    expect(await harness.readFile('replace-first.txt')).toBe('bar and foo and baz')
  })

  it('replace_first can prioritize a hinted line window before full-file ordering', async () => {
    const harness = await createToolFsHarness()
    const lines = Array.from({ length: 260 }, (_, idx) => `line ${idx + 1}`)
    lines[9] = 'const value = TARGET'
    lines[209] = 'const value = TARGET'
    await harness.writeFile('replace-first-hint-window.txt', `${lines.join('\n')}\n`)

    const result = await editFile('replace-first-hint-window.txt', 'replace_first', {
      searchPattern: 'const value = TARGET',
      replacement: 'const value = UPDATED',
      approxStartLine: 210,
      approxEndLine: 210,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('replace-first-hint-window.txt')
    const updatedLines = updated.split('\n')

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updatedLines[9]).toBe('const value = TARGET')
    expect(updatedLines[209]).toBe('const value = UPDATED')
    expect(result.attemptedStrategies?.some(s => s.includes('line_hint_window('))).toBe(true)
  })

  it('replace_first falls back to full-file search when hinted window misses', async () => {
    const harness = await createToolFsHarness()
    const lines = Array.from({ length: 260 }, (_, idx) => `line ${idx + 1}`)
    lines[9] = 'const value = TARGET'
    await harness.writeFile('replace-first-hint-fallback.txt', `${lines.join('\n')}\n`)

    const result = await editFile('replace-first-hint-fallback.txt', 'replace_first', {
      searchPattern: 'const value = TARGET',
      replacement: 'const value = UPDATED',
      approxStartLine: 240,
      approxEndLine: 245,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('replace-first-hint-fallback.txt')
    const updatedLines = updated.split('\n')

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updatedLines[9]).toBe('const value = UPDATED')
    expect(result.attemptedStrategies?.some(s => s.includes('fallback_to_full_file'))).toBe(true)
  })

  it('replace is a no-op when processed search and replacement are equivalent', async () => {
    const harness = await createToolFsHarness()
    const original = 'section one\nsection two\n'
    await harness.writeFile('replace-noop.txt', original)

    const result = await editFile('replace-noop.txt', 'replace', {
      searchPattern: 'section one\\nsection two',
      replacement: 'section one\nsection two',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(0)
    expect(result.message).toContain('No changes needed')
    expect(await harness.readFile('replace-noop.txt')).toBe(original)
  })

  it('replace_first is a no-op when replacement equals matched text', async () => {
    const harness = await createToolFsHarness()
    const original = 'alpha\nbeta\n'
    await harness.writeFile('replace-first-noop.txt', original)

    const result = await editFile('replace-first-noop.txt', 'replace_first', {
      searchPattern: 'alpha\\nbeta',
      replacement: 'alpha\nbeta',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(0)
    expect(result.message).toContain('No changes needed')
    expect(await harness.readFile('replace-first-noop.txt')).toBe(original)
  })

  it('replace_first preserves full content for files larger than 200KB', async () => {
    const harness = await createToolFsHarness()
    const search = 'target-marker'
    const replacement = 'target-marker-updated'
    const tailSentinel = 'TAIL-SENTINEL\n'
    const fillerLine = `${'0123456789abcdef'.repeat(16)}\n`
    const original = `HEADER ${search}\n${fillerLine.repeat(900)}${tailSentinel}`
    await harness.writeFile('replace-first-large.txt', original)

    const result = await editFile('replace-first-large.txt', 'replace_first', {
      searchPattern: search,
      replacement,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('replace-first-large.txt')
    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updated.startsWith(`HEADER ${replacement}\n`)).toBe(true)
    expect(updated.endsWith(tailSentinel)).toBe(true)
    expect(updated.length).toBe(original.length + (replacement.length - search.length))
  })

  it('replace_first preserves tail when editing the localServer-sized fixture file', async () => {
    const harness = await createToolFsHarness()
    const fixturePath = path.resolve(process.cwd(), 'electron/tools/__tests__/dummyfile.ts.test')
    const original = await fs.readFile(fixturePath, 'utf8')
    const tailSnapshot = original.slice(-12000)

    expect(original.length).toBeGreaterThan(200 * 1024)

    await harness.writeFile('fixture-localServer.ts', original)

    const searchPattern =
      "// Update conversation updated_at timestamp\n      if (db) {\n        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)\n      }\n\n      console.log("
    const replacement =
      "// Update conversation updated_at timestamp\n      if (db) {\n        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)\n\n        // Update project timestamp if this conversation belongs to a project\n        const projectConversation = conversation as any\n        if (projectConversation?.project_id) {\n          db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectConversation.project_id)\n        }\n      }\n\n      console.log("

    const result = await editFile('fixture-localServer.ts', 'replace_first', {
      searchPattern,
      replacement,
      interpretEscapeSequences: true,
      validateContent: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('fixture-localServer.ts')

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updated).toContain('projectConversation?.project_id')
    expect(updated.endsWith(tailSnapshot)).toBe(true)
  })

  it('replace_first matches code that contains escaped newline sequences inside string literals', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'escaped-string-literal.ts',
      [
        'const hermesMsgId = uuidv4()',
        "const textContent = textParts.join('\\n\\n').trim()",
        '',
        'statements.upsertMessage.run(',
      ].join('\n')
    )

    const result = await editFile('escaped-string-literal.ts', 'replace_first', {
      searchPattern: [
        'const hermesMsgId = uuidv4()',
        "const textContent = textParts.join('\\n\\n').trim()",
        '',
        'statements.upsertMessage.run(',
      ].join('\n'),
      replacement: [
        'const hermesMsgId = uuidv4()',
        "const textContent = textParts.join('\\n\\n').trim()",
        "const thinkingContent = reasoningParts.join('').trim()",
        '',
        "if (thinkingContent && !contentBlocks.some(block => block?.type === 'thinking')) {",
        "  contentBlocks = [{ type: 'thinking', thinking: thinkingContent }, ...contentBlocks]",
        '}',
        '',
        'statements.upsertMessage.run(',
      ].join('\n'),
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('escaped-string-literal.ts')

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updated).toContain("textParts.join('\\n\\n').trim()")
    expect(updated).toContain("const thinkingContent = reasoningParts.join('').trim()")
    expect(updated).toContain("block?.type === 'thinking'")
  })

  it('creates backup only when replace applies a change', async () => {
    const harness = await createToolFsHarness()
    const original = 'foo\nfoo\n'
    await harness.writeFile('replace-backup.txt', original)

    const result = await editFile('replace-backup.txt', 'replace', {
      searchPattern: 'foo',
      replacement: 'bar',
      createBackup: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(2)
    expect(result.backup).toBeDefined()
    expect(await harness.readFile('replace-backup.txt')).toBe('bar\nbar\n')

    const backups = await harness.listBackups('replace-backup.txt')
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(backups[0], 'utf8')).toBe(original)
  })

  it('does not create backup when replace is a no-op', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('replace-noop-backup.txt', 'same\nsame\n')

    const result = await editFile('replace-noop-backup.txt', 'replace', {
      searchPattern: 'same',
      replacement: 'same',
      createBackup: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(0)
    expect(await harness.listBackups('replace-noop-backup.txt')).toHaveLength(0)
  })

  it('keeps $& literal in exact replace for Heimdall-style interface insertion', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'src/components/Heimdall/Heimdall.tsx',
      [
        'interface Bounds { minX: number maxX: number minY: number maxY: number }',
        '',
        'export const Heimdall = () => null',
        '',
      ].join('\n')
    )

    const searchPattern = 'interface Bounds { minX: number maxX: number minY: number maxY: number }'
    const replacement =
      "interface Bounds { minX: number maxX: number minY: number maxY: number } const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')"

    const result = await editFile('src/components/Heimdall/Heimdall.tsx', 'replace', {
      searchPattern,
      replacement,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('src/components/Heimdall/Heimdall.tsx')
    const interfaceCount = (updated.match(/interface Bounds/g) || []).length

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('exact')
    expect(result.replacements).toBe(1)
    expect(updated).toContain(replacement)
    expect(updated).not.toContain('\\interface Bounds')
    expect(interfaceCount).toBe(1)
  })
})

describe('editFile escape sequence behavior', () => {
  it('interprets escapes in search patterns but keeps replacement escapes literal by default', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('escape-default.txt', 'alpha\nbeta\ngamma\n')

    const result = await editFile('escape-default.txt', 'replace_first', {
      searchPattern: 'beta\\ngamma',
      replacement: 'B\\nG',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-default.txt')).toBe('alpha\nB\\nG\n')
  })

  it('applies replacement newlines when actual newline characters are provided', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('escape-newline-literal.txt', 'alpha\nbeta\ngamma\n')

    const result = await editFile('escape-newline-literal.txt', 'replace_first', {
      searchPattern: 'beta\\ngamma',
      replacement: 'B\nG',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-newline-literal.txt')).toBe('alpha\nB\nG\n')
  })

  it('supports legacy interpretEscapeSequences=true to interpret escapes in replacement text', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('escape-legacy-true.txt', 'alpha\nbeta\ngamma\n')

    const result = await editFile('escape-legacy-true.txt', 'replace_first', {
      searchPattern: 'beta\\ngamma',
      replacement: 'B\\nG',
      interpretEscapeSequences: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-legacy-true.txt')).toBe('alpha\nB\nG\n')
  })

  it('interprets replacement escapes when interpretReplacementEscapes is true', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('escape-replacement-override.txt', 'alpha\nbeta\ngamma\n')

    const result = await editFile('escape-replacement-override.txt', 'replace_first', {
      searchPattern: 'beta\\ngamma',
      replacement: 'B\\nG',
      interpretReplacementEscapes: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-replacement-override.txt')).toBe('alpha\nB\nG\n')
  })

  it('treats escape sequences literally when interpretEscapeSequences is false', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('escape-literal.txt', 'literal \\n marker\n')

    const result = await editFile('escape-literal.txt', 'replace_first', {
      searchPattern: '\\n',
      replacement: '[NL]',
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-literal.txt')).toBe('literal [NL] marker\n')
  })

  it('prevents join newline corruption when replacing escaped newline sequences in code', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'escape-chat-join-regression.tsx',
      [
        'const footer = contexts',
        '  .map((ctx) => {',
        '    return [',
        "      'x',",
        "    ].join('\\\\n')",
        '  })',
        "  .join('\\\\n\\\\n')",
        '',
        "const ideContextFooter = `IDE contexts:\\\\n${footer}`",
        '',
      ].join('\n')
    )

    const result = await editFile('escape-chat-join-regression.tsx', 'replace_first', {
      searchPattern: "].join('\\\\n')",
      replacement: "].join('\\n')",
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('escape-chat-join-regression.tsx')

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updated).toContain(String.raw`].join('\n')`)
    expect(updated).toContain(String.raw`.join('\\n\\n')`)
    expect(updated).not.toContain("].join('\n')")
  })

  it('preserves escaped backslashes in regex literals during replacement', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'escape-regex-replace.txt',
      "audioPageAudioEl = new Audio('file:///' + audioPageAudioPath.replace(/\\\\/g, '-'));\n"
    )

    const result = await editFile('escape-regex-replace.txt', 'replace_first', {
      searchPattern: "audioPageAudioEl = new Audio('file:///' + audioPageAudioPath.replace(/\\\\/g, '-'));",
      replacement: "audioPageAudioEl = new Audio('file:///' + audioPageAudioPath.replace(/\\\\/g, '/'));",
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-regex-replace.txt')).toBe(
      "audioPageAudioEl = new Audio('file:///' + audioPageAudioPath.replace(/\\\\/g, '/'));\n"
    )
  })

  it('matches and updates regex character classes with escaped path separators', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'escape-regex-charclass.txt',
      'const audioName = audioPageAudioPath.split(/[\\\\/]/).pop();\n'
    )

    const result = await editFile('escape-regex-charclass.txt', 'replace_first', {
      searchPattern: 'const audioName = audioPageAudioPath.split(/[\\\\/]/).pop();',
      replacement: 'const audioName = audioPageAudioPath.split(/[\\\\/]/).at(-1);',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('escape-regex-charclass.txt')).toBe(
      'const audioName = audioPageAudioPath.split(/[\\\\/]/).at(-1);\n'
    )
  })
})

describe('editFile regex literal handling', () => {
  it('replace updates all exact regex-like occurrences that normalize path slashes', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'regex-global-replace.txt',
      [
        String.raw`const one = audioPath.replace(/\\/g, '/');`,
        String.raw`const two = imagePath.replace(/\\/g, '/');`,
        '',
      ].join('\n')
    )

    const searchPattern = String.raw`.replace(/\\/g, '/')`
    const replacement = String.raw`.replace(/[\\/]+/g, '/')`

    const result = await editFile('regex-global-replace.txt', 'replace', {
      searchPattern,
      replacement,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('regex-global-replace.txt')
    expect(result.success).toBe(true)
    expect(result.replacements).toBe(2)
    expect(updated).toContain(String.raw`const one = audioPath.replace(/[\\/]+/g, '/');`)
    expect(updated).toContain(String.raw`const two = imagePath.replace(/[\\/]+/g, '/');`)
    expect(updated).not.toContain(String.raw`.replace(/\\/g, '/')`)
  })

  it('replace_first only updates the first escaped-forward-slash regex literal', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'regex-forward-slash-first.txt',
      [
        String.raw`const one = '/foo/bar'.replace(/\//g, '-');`,
        String.raw`const two = '/bar/baz'.replace(/\//g, '-');`,
        '',
      ].join('\n')
    )

    const result = await editFile('regex-forward-slash-first.txt', 'replace_first', {
      searchPattern: String.raw`.replace(/\//g, '-')`,
      replacement: String.raw`.replace(/\//g, '_')`,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('regex-forward-slash-first.txt')).toBe(
      [
        String.raw`const one = '/foo/bar'.replace(/\//g, '_');`,
        String.raw`const two = '/bar/baz'.replace(/\//g, '-');`,
        '',
      ].join('\n')
    )
  })

  it('preserves double-backslash regex literals during replacement', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'regex-double-backslash.txt',
      `${String.raw`const collapse = value.replace(/\\\\/g, '/');`}\n`
    )

    const result = await editFile('regex-double-backslash.txt', 'replace_first', {
      searchPattern: String.raw`const collapse = value.replace(/\\\\/g, '/');`,
      replacement: String.raw`const collapse = value.replace(/\\\\/g, '-');`,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('regex-double-backslash.txt')).toBe(
      `${String.raw`const collapse = value.replace(/\\\\/g, '-');`}\n`
    )
  })

  it('keeps $ capture tokens literal in regex-style exact replacement text', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'regex-dollar-literals.txt',
      `${String.raw`const normalized = value.replace(/\\/g, '/');`}\n`
    )

    const result = await editFile('regex-dollar-literals.txt', 'replace', {
      searchPattern: String.raw`const normalized = value.replace(/\\/g, '/');`,
      replacement: String.raw`const normalized = value.replace(/[\\/]/g, '$1::$&');`,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('regex-dollar-literals.txt')).toBe(
      `${String.raw`const normalized = value.replace(/[\\/]/g, '$1::$&');`}\n`
    )
  })

  it('edits regex literals containing \\n escapes when interpretEscapeSequences is disabled', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('regex-literal-newline-escape.txt', `${String.raw`const newlineRegex = /\n/g;`}\n`)

    const result = await editFile('regex-literal-newline-escape.txt', 'replace_first', {
      searchPattern: String.raw`const newlineRegex = /\n/g;`,
      replacement: String.raw`const newlineRegex = /\r?\n/g;`,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('regex-literal-newline-escape.txt')).toBe(
      `${String.raw`const newlineRegex = /\r?\n/g;`}\n`
    )
  })

  it('keeps regex newline escapes intact in replacement code when escape interpretation is enabled', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('regex-newline-replacement-default.txt', 'const marker = true;\n')

    const replacement = [
      'function buildSearchIndex(md) {',
      String.raw`  searchMap = md.split(/\n/).map((line, i) => ({ id: i, text: line }));`,
      '}',
    ].join('\n')

    const result = await editFile('regex-newline-replacement-default.txt', 'replace_first', {
      searchPattern: 'const marker = true;',
      replacement,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('regex-newline-replacement-default.txt')
    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(updated).toContain(String.raw`split(/\n/).map((line, i) => ({ id: i, text: line }));`)
    expect(updated).not.toContain('split(/\n/).map((line, i) => ({ id: i, text: line }));')
  })
})

describe('editFile layered matching strategies', () => {
  it('uses line-ending normalized strategy for CRLF content and LF pattern', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('line-ending.txt', 'a\r\nb\r\nc\r\n')

    const result = await editFile('line-ending.txt', 'replace_first', {
      searchPattern: 'b\nc',
      replacement: 'B-C',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('line_ending_normalized')
    expect(await harness.readFile('line-ending.txt')).toBe('a\r\nB-C\r\n')
  })

  it('maps CRLF multiline spans correctly without partial replacement', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('line-ending-span.txt', 'top\r\nstart\r\nmiddle\r\nend\r\nbottom\r\n')

    const result = await editFile('line-ending-span.txt', 'replace_first', {
      searchPattern: 'start\nmiddle\nend',
      replacement: 'BLOCK',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('line_ending_normalized')
    expect(await harness.readFile('line-ending-span.txt')).toBe('top\r\nBLOCK\r\nbottom\r\n')
  })

  it('uses whitespace-normalized strategy for lines that differ by spaces and tabs', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('whitespace-normalized.txt', 'sum(\r\n  item   one,\r\n\titem\t two\r\n)\r\n')

    const result = await editFile('whitespace-normalized.txt', 'replace_first', {
      searchPattern: 'sum(\nitem one,\nitem two\n)',
      replacement: 'SUM()',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await harness.readFile('whitespace-normalized.txt')).toBe('SUM()\r\n')
  })

  it('maps whitespace-normalized matches correctly in CRLF files', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('whitespace-crlf.txt', 'head\r\nitem   one\r\nitem\t two\r\ntail\r\n')

    const result = await editFile('whitespace-crlf.txt', 'replace_first', {
      searchPattern: 'item one\nitem two',
      replacement: 'items_done',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await harness.readFile('whitespace-crlf.txt')).toBe('head\r\nitems_done\r\ntail\r\n')
  })

  it('uses single-span replacement for replace when strategy is whitespace_normalized', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'whitespace-replace-scope.txt',
      'head\r\nitem   one\r\nitem\t two\r\nmid\r\nitem   one\r\nitem\t two\r\ntail\r\n'
    )

    const result = await editFile('whitespace-replace-scope.txt', 'replace', {
      searchPattern: 'item one\nitem two',
      replacement: 'items_done',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await harness.readFile('whitespace-replace-scope.txt')).toBe(
      'head\r\nitems_done\r\nmid\r\nitem   one\r\nitem\t two\r\ntail\r\n'
    )
  })

  it('uses fuzzy strategy when exact/normalized strategies fail but similarity is high', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('fuzzy-success.txt', 'const status = "ready";\nconsole.log(status);\n')

    const result = await editFile('fuzzy-success.txt', 'replace_first', {
      searchPattern: 'const status = "raedy";\nconsole.log(status);',
      replacement: 'const status = "done";\nconsole.log(status);',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(result.matchStrategy).toBe('fuzzy')
    expect(await harness.readFile('fuzzy-success.txt')).toBe('const status = "done";\nconsole.log(status);\n')
  })

  it('uses single-span replacement for replace when strategy is fuzzy', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile(
      'fuzzy-replace-scope.txt',
      'const status = "ready";\nconsole.log(status);\n\nconst status = "running";\nconsole.log(status);\n'
    )

    const result = await editFile('fuzzy-replace-scope.txt', 'replace', {
      searchPattern: 'const status = "raedy";\nconsole.log(status);',
      replacement: 'const status = "done";\nconsole.log(status);',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(result.matchStrategy).toBe('fuzzy')
    expect(await harness.readFile('fuzzy-replace-scope.txt')).toBe(
      'const status = "done";\nconsole.log(status);\n\nconst status = "running";\nconsole.log(status);\n'
    )
  })

  it('fails when fuzzy matching is disabled and only fuzzy matching would succeed', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('fuzzy-disabled.txt', 'const status = "ready";\nconsole.log(status);\n')

    const result = await editFile('fuzzy-disabled.txt', 'replace_first', {
      searchPattern: 'const status = "raedy";\nconsole.log(status);',
      replacement: 'const status = "done";\nconsole.log(status);',
      enableFuzzyMatching: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.attemptedStrategies).toEqual(['exact', 'line_ending_normalized', 'whitespace_normalized'])
    expect(result.message).toContain('Search pattern not found in file')
  })

  it('reports attempted strategies when no match is found', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('no-match.txt', 'alpha\nbeta\n')

    const result = await editFile('no-match.txt', 'replace', {
      searchPattern: 'does not exist',
      replacement: 'value',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.attemptedStrategies).toContain('exact')
    expect(result.attemptedStrategies).toContain('fuzzy')
    expect(result.message).toContain('Attempted strategies:')
  })
})

describe('editFile indentation preservation', () => {
  it('preserves base indentation and relative tabs for non-exact matches when enabled', async () => {
    const harness = await createToolFsHarness()
    const original =
      'function main() {\n\tif (flag) {\n\t\tfirst();\n\t\t\tsecond();\n\t}\n}\n'
    const expected =
      'function main() {\n\tif (flag) {\n\trunA();\n\t\trunB();\n\t}\n}\n'
    await harness.writeFile('indent-preserve.txt', original)

    const result = await editFile('indent-preserve.txt', 'replace_first', {
      searchPattern: 'if (flag) {\nfirst();\n\tsecond();\n}',
      replacement: 'if (flag) {\nrunA();\n\trunB();\n}',
      preserveIndentation: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await harness.readFile('indent-preserve.txt')).toBe(expected)
  })

  it('keeps replacement indentation unchanged when preserveIndentation is false', async () => {
    const harness = await createToolFsHarness()
    const original =
      'function main() {\n\tif (flag) {\n\t\tfirst();\n\t\t\tsecond();\n\t}\n}\n'
    const expected =
      'function main() {\nif (flag) {\nrunA();\n\trunB();\n}\n}\n'
    await harness.writeFile('indent-no-preserve.txt', original)

    const result = await editFile('indent-no-preserve.txt', 'replace_first', {
      searchPattern: 'if (flag) {\nfirst();\n\tsecond();\n}',
      replacement: 'if (flag) {\nrunA();\n\trunB();\n}',
      preserveIndentation: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(await harness.readFile('indent-no-preserve.txt')).toBe(expected)
  })
})

describe('editFile replace regressions on localServer-sized fixture', () => {
  const fixturePath = path.resolve(process.cwd(), 'electron/tools/__tests__/dummyfile.ts.test')

  it('keeps exact strategy global for repeated tokens in large fixture', async () => {
    const harness = await createToolFsHarness()
    const original = await fs.readFile(fixturePath, 'utf8')
    await harness.writeFile('fixture-exact-global.ts', original)

    const originalCount = (original.match(/run\(now, conversationId\)/g) || []).length
    expect(originalCount).toBeGreaterThan(1)

    const result = await editFile('fixture-exact-global.ts', 'replace', {
      searchPattern: 'run(now, conversationId)',
      replacement: 'run(now, updatedConversationId)',
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('fixture-exact-global.ts')
    const updatedCount = (updated.match(/run\(now, updatedConversationId\)/g) || []).length

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('exact')
    expect(result.replacements).toBe(originalCount)
    expect(updatedCount).toBe(originalCount)
    expect(updated).not.toContain('run(now, conversationId)')
  })

  it('uses single-span replacement for line-ending normalized matches in large fixture', async () => {
    const harness = await createToolFsHarness()
    const original = await fs.readFile(fixturePath, 'utf8')
    const crlfFixture = original.replace(/\n/g, '\r\n')
    const tailSnapshot = crlfFixture.slice(-12000)
    await harness.writeFile('fixture-line-ending-scope.ts', crlfFixture)

    const result = await editFile('fixture-line-ending-scope.ts', 'replace', {
      searchPattern:
        "// Update conversation updated_at timestamp\n      if (db) {\n        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)\n      }\n\n      console.log(",
      replacement: '/*line-ending-marker*/',
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('fixture-line-ending-scope.ts')

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('line_ending_normalized')
    expect(result.replacements).toBe(1)
    expect((updated.match(/\/\*line-ending-marker\*\//g) || []).length).toBe(1)
    expect(updated).toContain("db!.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)")
    expect(updated.endsWith(tailSnapshot)).toBe(true)
  })

  it('uses single-span replacement for whitespace-normalized matches in large fixture', async () => {
    const harness = await createToolFsHarness()
    const original = await fs.readFile(fixturePath, 'utf8')
    await harness.writeFile('fixture-whitespace-scope.ts', original)

    const result = await editFile('fixture-whitespace-scope.ts', 'replace', {
      searchPattern:
        "// Update conversation updated_at timestamp\nif (db) {\ndb.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)\n}\n\nconsole.log(",
      replacement: '/*whitespace-marker*/',
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('fixture-whitespace-scope.ts')

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(result.replacements).toBe(1)
    expect((updated.match(/\/\*whitespace-marker\*\//g) || []).length).toBe(1)
    expect(updated).toContain("db!.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)")
  })

  it('is a no-op for whitespace-normalized replace when replacement resolves to matched text', async () => {
    const harness = await createToolFsHarness()
    const original = await fs.readFile(fixturePath, 'utf8')
    await harness.writeFile('fixture-whitespace-noop.ts', original)

    const unindentedBlock =
      "// Update conversation updated_at timestamp\nif (db) {\n  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)\n}\n\nconsole.log("

    const result = await editFile('fixture-whitespace-noop.ts', 'replace', {
      searchPattern: unindentedBlock,
      replacement: unindentedBlock,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(result.replacements).toBe(0)
    expect(await harness.readFile('fixture-whitespace-noop.ts')).toBe(original)
  })

  it('uses single-span replacement for fuzzy matches in large fixture', async () => {
    const harness = await createToolFsHarness()
    const original = await fs.readFile(fixturePath, 'utf8')
    await harness.writeFile('fixture-fuzzy-scope.ts', original)

    const result = await editFile('fixture-fuzzy-scope.ts', 'replace', {
      searchPattern:
        "console.log(\n        '[LocalServer] ✅ Bulk insreted',\n        createdMessages.length,\n        'messages into conversation:',\n        conversationId\n      )",
      replacement:
        "console.log(\n        '[LocalServer] ✅ Bulk inserted [patched]',\n        createdMessages.length,\n        'messages into conversation:',\n        conversationId\n      )",
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile('fixture-fuzzy-scope.ts')

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('fuzzy')
    expect(result.replacements).toBe(1)
    expect((updated.match(/Bulk inserted \[patched\]/g) || []).length).toBe(1)
    expect(updated).toContain('[LocalServer] ✅ Bulk inserted')
  })
})

describe('editFile append behavior', () => {
  it('appends content to an existing file in order', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('append-existing.txt', 'alpha')

    const result = await editFile('append-existing.txt', 'append', {
      content: '\nbeta',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('append-existing.txt')).toBe('alpha\nbeta')
  })

  it('creates a file when appending to a non-existent path', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('append-new.txt', 'append', {
      content: 'hello',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.lineInfo).toMatchObject({
      oldStartLine: 1,
      oldLineCount: 0,
      newStartLine: 1,
      newLineCount: 1,
      scope: 'append',
    })
    expect(await harness.fileExists('append-new.txt')).toBe(true)
    expect(await harness.readFile('append-new.txt')).toBe('hello')
  })

  it('creates a backup with original content when appending with createBackup', async () => {
    const harness = await createToolFsHarness()
    const original = 'before'
    await harness.writeFile('append-backup.txt', original)

    const result = await editFile('append-backup.txt', 'append', {
      content: ' after',
      createBackup: true,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.backup).toBeDefined()
    expect(await harness.readFile('append-backup.txt')).toBe('before after')

    const backups = await harness.listBackups('append-backup.txt')
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(backups[0], 'utf8')).toBe(original)
  })

  it('accepts empty-string append content and leaves file content unchanged', async () => {
    const harness = await createToolFsHarness()
    const original = 'unchanged'
    await harness.writeFile('append-empty.txt', original)

    const result = await editFile('append-empty.txt', 'append', {
      content: '',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)
    expect(await harness.readFile('append-empty.txt')).toBe(original)
  })
})

describe('editFile read/edit validation coordination', () => {
  it('succeeds when expected hash and metadata match current file state', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('validation-pass.txt', 'version=1\n')

    const readResult = await readTextFile('validation-pass.txt', {
      cwd: harness.workspaceDir,
      includeHash: true,
    })

    const result = await editFile('validation-pass.txt', 'replace', {
      searchPattern: '1',
      replacement: '2',
      validateContent: true,
      expectedHash: readResult.contentHash,
      expectedMetadata: readResult.metadata,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.validation?.valid).toBe(true)
    expect(await harness.readFile('validation-pass.txt')).toBe('version=2\n')
  })

  it('allows edits when only the expected hash is stale', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('validation-hash-pass.txt', 'alpha=old\n')
    const absolutePath = harness.absolutePath('validation-hash-pass.txt')
    const readResult = await readTextFile('validation-hash-pass.txt', {
      cwd: harness.workspaceDir,
      includeHash: true,
    })

    await fs.writeFile(absolutePath, 'alpha=changed\n', 'utf8')

    const result = await editFile('validation-hash-pass.txt', 'replace', {
      searchPattern: 'changed',
      replacement: 'updated',
      validateContent: true,
      expectedHash: readResult.contentHash,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.validation).toBeUndefined()
    expect(await harness.readFile('validation-hash-pass.txt')).toBe('alpha=updated\n')
  })

  it('bypasses stale hash when validateContent is false', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('validation-bypass.txt', 'alpha=old\n')
    const absolutePath = harness.absolutePath('validation-bypass.txt')
    const readResult = await readTextFile('validation-bypass.txt', {
      cwd: harness.workspaceDir,
      includeHash: true,
    })

    await fs.writeFile(absolutePath, 'alpha=changed\n', 'utf8')

    const result = await editFile('validation-bypass.txt', 'replace', {
      searchPattern: 'changed',
      replacement: 'updated',
      expectedHash: readResult.contentHash,
      validateContent: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.validation).toBeUndefined()
    expect(await harness.readFile('validation-bypass.txt')).toBe('alpha=updated\n')
  })

  it('fails metadata validation when mtime is newer than expected', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('validation-metadata-fail.txt', 'meta=true\n')
    const absolutePath = harness.absolutePath('validation-metadata-fail.txt')
    const readResult = await readTextFile('validation-metadata-fail.txt', { cwd: harness.workspaceDir })
    const newerTime = new Date(readResult.metadata.lastModified.getTime() + 5000)

    await fs.utimes(absolutePath, newerTime, newerTime)

    const result = await editFile('validation-metadata-fail.txt', 'replace', {
      searchPattern: 'meta=true',
      replacement: 'meta=false',
      validateContent: true,
      expectedMetadata: readResult.metadata,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Validation failed')
    expect(result.validation?.reason).toContain('modified since it was read')
    expect(await harness.readFile('validation-metadata-fail.txt')).toBe('meta=true\n')
  })

  it('passes metadata validation when mtime has not advanced', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('validation-metadata-pass.txt', 'flag=0\n')
    const readResult = await readTextFile('validation-metadata-pass.txt', { cwd: harness.workspaceDir })

    const result = await editFile('validation-metadata-pass.txt', 'replace', {
      searchPattern: '0',
      replacement: '1',
      validateContent: true,
      expectedMetadata: readResult.metadata,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(result.validation?.valid).toBe(true)
    expect(await harness.readFile('validation-metadata-pass.txt')).toBe('flag=1\n')
  })
})

describe('editFile workspace restrictions (POSIX)', () => {
  it('allows relative paths inside the configured cwd', async () => {
    const harness = await createToolFsHarness()
    await harness.writeFile('nested/in-scope.txt', '')

    const result = await editFile('nested/in-scope.txt', 'append', {
      content: 'ok',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(true)
    expect(await harness.readFile('nested/in-scope.txt')).toBe('ok')
  })

  it('blocks replace for paths outside configured cwd', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('../outside-replace.txt', 'replace', {
      searchPattern: 'x',
      replacement: 'y',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Access denied')
  })

  it('blocks append for paths outside configured cwd', async () => {
    const harness = await createToolFsHarness()

    const result = await editFile('../outside-append.txt', 'append', {
      content: 'x',
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Access denied')
  })
})


describe('editFile non-fuzzy replacements on chatActions fixture via read_file workflow', () => {
  const fixturePath = path.resolve(process.cwd(), 'electron/tools/__tests__/dummyFilechatAction.ts.test')

  const seedFixture = async (harness: Awaited<ReturnType<typeof createToolFsHarness>>, targetPath: string) => {
    const original = await fs.readFile(fixturePath, 'utf8')
    await harness.writeFile(targetPath, original)
    return original
  }

  const readExecutionModeBlock = async (
    harness: Awaited<ReturnType<typeof createToolFsHarness>>,
    targetPath: string
  ) => {
    const read = await readTextFile(targetPath, {
      cwd: harness.workspaceDir,
      maxBytes: 400_000,
    })

    const source = read.content
    const startToken = '      // Get selected files for chat from IDE context'
    const endToken = "      const executionMode = 'client'"

    const start = source.indexOf(startToken)
    if (start === -1) {
      throw new Error('Could not locate selectedFilesForChat block start from read_file output')
    }

    const endTokenStart = source.indexOf(endToken, start)
    if (endTokenStart === -1) {
      throw new Error('Could not locate executionMode line from read_file output')
    }

    const endOfLine = source.indexOf('\n', endTokenStart)
    const end = endOfLine === -1 ? source.length : endOfLine + 1
    return source.slice(start, end)
  }

  it('uses exact strategy when search pattern comes directly from read_file output', async () => {
    const harness = await createToolFsHarness()
    const targetPath = 'fixture-chatActions-readflow-exact.ts'
    await seedFixture(harness, targetPath)

    const searchPattern = await readExecutionModeBlock(harness, targetPath)
    const replacement = searchPattern.replace(
      "      const executionMode = 'client'",
      "      const executionMode = 'client' // from-read-file exact"
    )

    const result = await editFile(targetPath, 'replace_first', {
      searchPattern,
      replacement,
      enableFuzzyMatching: false,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile(targetPath)
    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('exact')
    expect(result.replacements).toBe(1)
    expect(updated).toContain("const executionMode = 'client' // from-read-file exact")
  })

  it('uses line_ending_normalized when read_file output is converted to LF only', async () => {
    const harness = await createToolFsHarness()
    const targetPath = 'fixture-chatActions-readflow-line-ending.ts'
    await seedFixture(harness, targetPath)

    const rawFromReadFile = await readExecutionModeBlock(harness, targetPath)
    const searchPattern = rawFromReadFile.replace(/\r\n/g, '\n')

    const result = await editFile(targetPath, 'replace_first', {
      searchPattern,
      replacement: '      /*from-read-file-line-ending*/',
      enableFuzzyMatching: false,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile(targetPath)
    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('line_ending_normalized')
    expect(result.replacements).toBe(1)
    expect(updated).toContain('      /*from-read-file-line-ending*/')
  })

  it('uses whitespace_normalized when read_file output is de-indented', async () => {
    const harness = await createToolFsHarness()
    const targetPath = 'fixture-chatActions-readflow-whitespace.ts'
    await seedFixture(harness, targetPath)

    const rawFromReadFile = await readExecutionModeBlock(harness, targetPath)
    const searchPattern = rawFromReadFile
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trimStart())
      .join('\n')

    const result = await editFile(targetPath, 'replace_first', {
      searchPattern,
      replacement: "const executionMode = 'client' // from-read-file whitespace",
      preserveIndentation: true,
      enableFuzzyMatching: false,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile(targetPath)
    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(result.replacements).toBe(1)
    expect(updated).toContain("      const executionMode = 'client' // from-read-file whitespace")
  })

  it('replace remains single-span for non-exact read_file-derived patterns', async () => {
    const harness = await createToolFsHarness()
    const targetPath = 'fixture-chatActions-readflow-single-span.ts'
    const original = await seedFixture(harness, targetPath)
    const originalPayloadCwdCount =
      (original.match(/const payloadCwd = typeof cwd === 'string' \? cwd.trim\(\) : \(cwd \?\? null\)/g) || []).length

    const rawFromReadFile = await readExecutionModeBlock(harness, targetPath)

    const searchPattern = rawFromReadFile
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trimStart())
      .join('\n')

    const result = await editFile(targetPath, 'replace', {
      searchPattern,
      replacement: '/*from-read-file-single-span*/',
      enableFuzzyMatching: false,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    const updated = await harness.readFile(targetPath)
    const updatedPayloadCwdCount =
      (updated.match(/const payloadCwd = typeof cwd === 'string' \? cwd.trim\(\) : \(cwd \?\? null\)/g) || []).length

    expect(result.success).toBe(true)
    expect(result.matchStrategy).toBe('whitespace_normalized')
    expect(result.replacements).toBe(1)
    expect((updated.match(/\/\*from-read-file-single-span\*\//g) || []).length).toBe(1)
    expect(updatedPayloadCwdCount).toBe(originalPayloadCwdCount - 1)
  })

  it('fails with non-fuzzy strategies when read_file pattern is typo-mutated', async () => {
    const harness = await createToolFsHarness()
    const targetPath = 'fixture-chatActions-readflow-no-fuzzy-fail.ts'
    await seedFixture(harness, targetPath)

    const rawFromReadFile = await readExecutionModeBlock(harness, targetPath)
    const searchPattern = rawFromReadFile.replace('selectedFilesForChat', 'selectedFilesForChta')

    const result = await editFile(targetPath, 'replace_first', {
      searchPattern,
      replacement: rawFromReadFile,
      enableFuzzyMatching: false,
      interpretEscapeSequences: false,
      cwd: harness.workspaceDir,
    })

    expect(result.success).toBe(false)
    expect(result.attemptedStrategies).toEqual(['exact', 'line_ending_normalized', 'whitespace_normalized'])
    expect(result.message).toContain('Search pattern not found in file')
  })
})
