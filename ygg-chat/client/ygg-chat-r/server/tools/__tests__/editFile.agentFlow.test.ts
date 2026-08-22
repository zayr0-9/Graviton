import { describe, expect, it } from 'vitest'
import { editFile } from '../editFile.js'
import { readTextFile } from '../readFile.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

const BLOCK_START_MARKER = '// Prepend cwd to system prompt if provided or stored on the conversation'
const BLOCK_END_MARKER = '// Append custom tools explanation to system prompt'

function lineNumberAtIndex(content: string, index: number): number {
  if (index <= 0) return 1
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

describe('editFile agent-like read-then-edit workflow', () => {
  it('shows stale hardcoded blocks can fail, then succeeds by reusing block read from readFile', async () => {
    const harness = await createToolFsHarness()

    const fixture = [
      'export async function buildPrompt(conversationMeta: any, state: any, cwd?: string | null) {',
      '  let systemPrompt = "base"',
      '',
      '      // Prepend cwd to system prompt if provided or stored on the conversation',
      "      const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)",
      '      const effectiveCwd = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null',
      '      const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null',
      '      if (effectiveCwd) {',
      '        const cwdPrefix = `Current working directory: ${effectiveCwd}\\n\\n`',
      '        systemPrompt = cwdPrefix + systemPrompt',
      '      }',
      '      // Append custom tools explanation to system prompt',
      "      systemPrompt = systemPrompt + '\\n\\n' + sysPromptConfig.customToolsPrompt",
      '',
      '  return { systemPrompt, effectiveToolRootPath }',
      '}',
      '',
    ].join('\n')

    await harness.writeFile('chatActions.fixture.ts', fixture)

    const staleSearchPattern =
      "      // Prepend cwd to system prompt if provided or stored on the conversation\n" +
      "      const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)\n" +
      '      const effectiveCwd = payloadCwd || conversationMeta?.cwd || null\n' +
      '      const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null\n' +
      '      if (effectiveCwd) {\n' +
      '        const cwdPrefix = `Current working directory: ${effectiveCwd}\\n\\n`\n' +
      '        systemPrompt = cwdPrefix + systemPrompt\n' +
      '      }\n'

    const replacementBlock =
      '      // Resolve cwd for local tool execution only (do not inject into system prompt)\n' +
      "      const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)\n" +
      '      const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null\n'

    // 1) Demonstrate stale payload failing against current file text
    const staleAttempt = await editFile('chatActions.fixture.ts', 'replace', {
      searchPattern: staleSearchPattern,
      replacement: replacementBlock,
      cwd: harness.workspaceDir,
    })

    expect(staleAttempt.success).toBe(false)
    expect(staleAttempt.message).toContain('Search pattern not found')

    // 2) Mimic runtime agent flow: read current content first, then use exact returned block for edit
    const fullRead = await readTextFile('chatActions.fixture.ts', {
      cwd: harness.workspaceDir,
      includeHash: true,
    })

    const startIndex = fullRead.content.indexOf(BLOCK_START_MARKER)
    const endIndex = fullRead.content.indexOf(BLOCK_END_MARKER)

    expect(startIndex).toBeGreaterThan(-1)
    expect(endIndex).toBeGreaterThan(startIndex)

    const startLine = lineNumberAtIndex(fullRead.content, startIndex)
    const endMarkerLine = lineNumberAtIndex(fullRead.content, endIndex)
    const endLine = endMarkerLine - 1

    const focusedRead = await readTextFile('chatActions.fixture.ts', {
      cwd: harness.workspaceDir,
      startLine,
      endLine,
      includeHash: false,
    })

    const liveSearchPattern = focusedRead.content

    const readThenEdit = await editFile('chatActions.fixture.ts', 'replace_first', {
      searchPattern: liveSearchPattern,
      replacement: replacementBlock,
      cwd: harness.workspaceDir,
      validateContent: true,
      expectedHash: fullRead.contentHash,
      expectedMetadata: fullRead.metadata,
    })

    expect(readThenEdit.success).toBe(true)
    expect(readThenEdit.replacements).toBe(1)

    const updated = await harness.readFile('chatActions.fixture.ts')
    expect(updated).toContain('Resolve cwd for local tool execution only')
    expect(updated).not.toContain('Current working directory: ${effectiveCwd}')
  })
})
