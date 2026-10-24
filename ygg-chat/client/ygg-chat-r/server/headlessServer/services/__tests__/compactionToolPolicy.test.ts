import { describe, expect, it } from 'vitest'
import { estimateTokenCount } from 'tokenx'
import { COMPACTION_APPENDIX_MAX_CHARS, compactionToolStatus, projectCompactionTool } from '../compactionToolPolicy.js'
import { buildCompactionAppendix, finaliseCompactionContent } from '../compactionService.js'
import { compactionInstruction } from '../../../../../../shared/compaction.js'

const secret = 'FILE_OR_RESULT_BODY_MUST_NOT_SURVIVE'
const text = (value: unknown) => JSON.stringify(value)
const call = (name: string, args: Record<string, unknown>, result: unknown, id = name) => ({
  role: 'assistant', tool_calls: [{ id, name, arguments: args }],
  content_blocks: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }],
})

describe('centralized compaction policies', () => {
  it.each(['read_file', 'read_files', 'read_file_continuation', 'create_file', 'delete_file', 'edit_file'])('%s strips bodies, preserves metadata and does not mutate history', name => {
    const args = { path: '/a.ts', paths: ['/a.ts'], startLine: 3, endLine: 5, afterLine: 2,
      approxStartLine: 3, operation: 'replace', content: secret, replacement: secret, searchPattern: secret }
    const result = { success: true, content: secret, diff: secret, message: secret, lspContext: { content: secret },
      metadata: { lineEnding: '\n', encoding: 'utf8' }, ranges: [{ startLine: 3, endLine: 5 }],
      nextLine: 6, fileHash: 'hash', sizeBytes: 100, lineInfo: { oldStartLine: 3, newStartLine: 3 } }
    if (name.startsWith('read_')) {
      delete (args as Partial<typeof args>).content
      delete (args as Partial<typeof args>).replacement
      delete (args as Partial<typeof args>).searchPattern
    }
    const original = structuredClone({ args, result })
    const projection = projectCompactionTool(name, args, result)
    expect(text(projection)).not.toContain(secret)
    expect(projection).toMatchObject({ input: { path: '/a.ts', startLine: 3 }, output: { fileHash: 'hash', nextLine: 6 } })
    expect({ args, result }).toEqual(original)
    expect(text(projectCompactionTool(name, args, `malformed ${secret}`))).not.toContain(secret)
  })

  it.each(['fetch_chats', 'ripgrep', 'glob', 'browse_web', 'custom_tool_manager', 'brave_search', 'brave_web_search'])('%s retains only input and execution envelope', name => {
    const args = { query: 'keep query', action: 'invoke' }
    expect(projectCompactionTool(name, args, { content: secret })).toEqual({ input: args })
    expect(buildCompactionAppendix([call(name, args, { success: false, message: secret })])).toContain(`${name} failed`)
    expect(buildCompactionAppendix([call(name, args, { success: false, message: secret })])).not.toContain(secret)
  })

  it.each([['claude_bridge', 200], ['mcp_manager', 300], ['skill_manager', 300], ['subagent_manager', 300], ['subagent', 300]] as const)('%s bounds output including handles, retaining full inputs', (name, limit) => {
    const args = { message: 'full input '.repeat(1000) }
    const projection = projectCompactionTool(name, args, { content: 'long result '.repeat(5000), sessionId: 'session-1', handle: '123456', status: 'running' })
    expect(projection.input).toEqual(args)
    expect(estimateTokenCount(projection.output as string)).toBeLessThanOrEqual(limit)
    expect(projection.output).toContain('session-1')
    expect(projection.output).toContain('123456')
    expect(projection.output).toContain('truncated')
  })

  it.each(['bash', 'powershell'])('%s retains both ends of output with one 300-token budget', name => {
    const projection = projectCompactionTool(name, { command: 'npm test', cwd: '/workspace' }, {
      success: false, timedOut: true, stdout: 'START\n' + 'middle '.repeat(10000), stderr: 'FINAL ERROR',
    })
    expect(estimateTokenCount(projection.output as string)).toBeLessThanOrEqual(300)
    expect(projection.output).toContain('START')
    expect(projection.output).toContain('FINAL ERROR')
    expect(projection.output).toContain('timedOut')
  })

  it('projects multi_call children recursively without retaining wrapper payloads', () => {
    const args = { calls: [
      { tool: 'read_file', args: { path: '/read' } },
      { toolName: 'multi_edit', args: { edits: [{ path: '/edit', replacement: secret }, { path: '/failed', content: secret }] } },
      { tool: 'glob', args: { pattern: '*' } },
      { tool: 'bash', args: { command: 'exit 1' } },
    ] }
    const result = { results: [
      { tool: 'read_file', ok: true, data: { success: true, content: secret, nextLine: 10 } },
      { tool: 'multi_edit', ok: true, data: { success: false, applied: 1, failed: 1, stoppedEarly: true, results: [
        { success: true, message: secret }, { success: false, message: secret },
      ] } },
      { tool: 'glob', ok: false, skipped: true, error: secret },
    ] }
    const projection = projectCompactionTool('multi_call', args, result)
    expect(text(projection)).not.toContain(secret)
    expect(projection.output).toMatchObject({ calls: [
      { status: 'success', output: { nextLine: 10 } },
      { status: 'failed', output: { applied: 1, edits: [{ status: 'success' }, { status: 'failed' }] } },
      { status: 'skipped' }, { status: 'status unknown' },
    ] })
  })

  it('retains failed edits but never their error snippets or patches', () => {
    const appendix = buildCompactionAppendix([call('edit_file', { path: '/failed', replacement: secret }, { success: false, message: secret })])
    expect(appendix).toContain('edit_file failed')
    expect(appendix).toContain('/failed')
    expect(appendix).not.toContain(secret)
  })

  it('retains REPL names and capture references, not values, code or help prose', () => {
    const output = projectCompactionTool('repl', { action: 'exec', code: `var data = '${secret}'`, show: 'data' },
      { success: true, status: 'executed', variable: 'data', content: secret, revision: 2 })
    expect(output).toEqual({ input: { action: 'exec', show: 'data' }, output: { success: true, status: 'executed', variable: 'data', revision: 2 } })
    expect(text(projectCompactionTool('repl', { action: 'list' }, { variables: [{ name: 'data', value: secret, keys: [secret] }] }))).not.toContain(secret)
    const nested = projectCompactionTool('repl', { action: 'invoke', tool: 'multi_call', assign: 'batch', args: {
      calls: [{ tool: 'create_file', args: { path: '/new', content: secret } }],
    } }, { variable: 'batch', status: 'stored', toolStatus: 'success' })
    expect(text(nested)).toContain('/new')
    expect(text(nested)).not.toContain(secret)
  })

  it('keeps minimal watcher state and the internal link target', () => {
    expect(projectCompactionTool('watcher', { action: 'status', handle: 'watch-1' }, {
      success: true, handle: 'watch-1', state: 'triggered', delivery: 'submitted', message: secret,
    }).output).toEqual({ success: true, handle: 'watch-1', state: 'triggered', delivery: 'submitted' })
    const link = projectCompactionTool('internalLink', { messageId: 'm' }, { success: true,
      target: { route: '/chat/c/m', messageId: 'm', conversationTitle: secret }, warnings: [secret] })
    expect(text(link)).toContain('/chat/c/m')
    expect(text(link)).not.toContain(secret)
  })

  it('uses structured status, not arbitrary prose', () => {
    expect(compactionToolStatus({ success: true, stdout: '0 tests failed' })).toBe('success')
    expect(compactionToolStatus('all passed')).toBe('status unknown')
    expect(compactionToolStatus({ success: false, cancelled: true }, undefined, 'bash')).toBe('cancelled')
  })

  it('preserves small HTML calls and bounds unknown tools conservatively', () => {
    expect(projectCompactionTool('html_renderer', { html: '<h1>Hi</h1>' }, 'rendered').output).toBe('rendered')
    expect(estimateTokenCount(projectCompactionTool('future_tool', {}, 'result '.repeat(10000)).output as string)).toBeLessThanOrEqual(300)
  })

  it('keeps complete entries within one total budget and reports omissions', () => {
    const appendix = buildCompactionAppendix([
      call('claude_bridge', { message: 'x'.repeat(50000) }, 'done', 'oversized'),
      ...Array.from({ length: 80 }, (_, index) => call('fetch_chats', { query: String(index) + 'q'.repeat(1000) }, secret, String(index))),
    ])
    expect(appendix.length).toBeLessThanOrEqual(COMPACTION_APPENDIX_MAX_CHARS)
    expect(appendix).toContain('entries omitted by total budget:')
    expect(appendix).not.toContain('oversized')
    expect(appendix).toContain('id: 79')
  })

  it('does not duplicate calls or replay previous summaries and applies policies in canonical blocks', () => {
    const first = call('read_file', { path: '/a' }, { success: true, content: secret })
    const prior = { ...call('bash', { command: 'old call' }, 'old output'), content: 'old appendix',
      meta: { kind: 'compaction_summary', state: 'committed' } }
    const appendix = buildCompactionAppendix([prior, first, first])
    expect(appendix.match(/read_file success/g)).toHaveLength(1)
    expect(appendix).not.toContain('old')
    const final = finaliseCompactionContent({ content: 'Current state' }, [prior, first], { id: 'instruction' })
    expect(final.content).not.toContain(secret)
    expect(text(final.contentBlocks)).not.toContain(secret)
    expect(final.contentBlocks.at(-1).source).toBe('compaction_appendix')
  })

  it('always includes state-handoff guidance with custom instructions', () => {
    for (const custom of [undefined, 'Use short bullets']) {
      const prompt = compactionInstruction(custom)
      expect(prompt).toContain('filtered tool-interaction record')
      expect(prompt).toContain('Preserve consequential findings')
      expect(prompt).toContain('do not copy their tool appendices')
      expect(prompt).toContain('do not resume the original task')
      if (custom) expect(prompt).toContain(custom)
    }
  })
})


it('distinguishes wrapper execution, child failures and queried lifecycle states', () => {
  expect(compactionToolStatus({ success: true, state: 'cancelled' }, false, 'watcher')).toBe('success')
  expect(compactionToolStatus({ success: true, status: 'failed' }, false, 'claude_bridge')).toBe('success')
  expect(compactionToolStatus({ success: true, status: 'stored', toolStatus: 'error' }, false, 'repl')).toBe('stored tool error')
  expect(compactionToolStatus({ status: 'conflict', error: 'conflict' }, false, 'repl')).toBe('conflict')
  expect(compactionToolStatus({ results: [{ ok: false, error: 'failed' }] }, false, 'multi_call')).toBe('completed with child failures')
  expect(compactionToolStatus({ results: [{ ok: true, tool: 'edit_file', data: { success: false } }] }, false, 'multi_call')).toBe('completed with child failures')
  expect(compactionToolStatus({ success: true }, false, 'read_files')).toBe('completed; per-file outcomes omitted')
})

it('uses an enclosing fence longer than any backtick run in tool payloads', () => {
  const final = finaliseCompactionContent({ content: 'State handoff' }, [
    call('bash', { command: 'printf "````"' }, { success: true, stdout: '```\nuntrusted output\n```' }),
  ], { id: 'instruction' })
  const appendix = final.contentBlocks.at(-1).content.trim()
  expect(appendix.startsWith('`````\n')).toBe(true)
  expect(appendix.endsWith('\n`````')).toBe(true)
})
