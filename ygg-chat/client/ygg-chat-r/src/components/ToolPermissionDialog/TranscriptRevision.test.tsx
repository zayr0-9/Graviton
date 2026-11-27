import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseTranscriptRevisionRequest, projectTranscriptRevision } from '../../../../../shared/transcriptRevision'
import { ToolPermissionDialog } from './ToolPermissionDialog'

const themeMode = vi.hoisted(() => ({ dark: false }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => ({
  ...await importOriginal<typeof import('../ThemeManager/themeConfig')>(),
  useHtmlDarkMode: () => themeMode.dark,
}))

const preview = {
  messageId: 'answer', messageDate: '2026-11-25', excerpt: 'Run old-test.',
  edits: [{ block: 0, before: 'old-test', after: '<new-test>' }],
}

describe('transcript revision presentation', () => {
  it.each([false, true])('previews exact text and only single-use controls (dark=%s)', dark => {
    themeMode.dark = dark
    const html = renderToStaticMarkup(<ToolPermissionDialog transcriptRevision={preview}
      toolCall={{ id: 'test', name: 'revise_transcript', arguments: {}, status: 'pending' }}
      onGrant={() => {}} onDeny={() => {}} onAllowAuto={() => {}} onAllowAll={() => {}} />)
    expect(html).toContain('Apply revision')
    expect(html).toContain('Decline')
    expect(html).toContain('old-test')
    expect(html).toContain('&lt;new-test&gt;')
    expect(html).toContain(dark ? 'background-color:#000000' : 'background-color:#f5f5f5')
    expect(html).toContain(dark ? 'color:#d4d4d8' : 'color:#1d4ed8')
    expect(html).not.toContain('Always Allow')
    expect(html).not.toContain('>Auto<')
  })

  it('projects both copy content and visible text without modifying tool blocks', () => {
    const tool = { type: 'tool_use', name: 'read_file' }
    const original = [{ type: 'text', content: 'Intro' }, tool, { type: 'text', content: 'Use A' }]
    const revision = { id: 1, messageId: 'old-answer', changes: [{ index: 1, original: 'Use A', revised: 'Use B' }] }
    expect(projectTranscriptRevision('Use A', original, revision)).toEqual({
      content: 'Intro\n\nUse B', blocks: [original[0], tool, { type: 'text', content: 'Use B' }],
    })
    expect(projectTranscriptRevision('Use A', original, revision)?.blocks[1]).toBe(tool)
    expect(original[2]).toEqual({ type: 'text', content: 'Use A' })
    expect(projectTranscriptRevision('different', [], revision)).toBeNull()
  })

  it('revises legacy provider-only display text without replacing reasoning or tool items', () => {
    const reasoning = { type: 'reasoning', content: [{ text: 'Thinking' }] }
    const reply = { type: 'message', role: 'assistant', content: [{ text: 'A ' }, { text: 'legacy reply' }] }
    const blocks = [{ type: 'responses_output_items', items: [reasoning, reply] }]
    const revision = { id: 2, messageId: 'legacy', changes: [{ index: 0, original: 'A legacy reply', revised: 'A revised reply' }] }
    const projected = projectTranscriptRevision('A legacy reply', blocks, revision)
    expect(projected?.content).toBe('A revised reply')
    expect(projected?.blocks).toEqual([{ type: 'responses_output_items', items: [reasoning,
      { ...reply, content: [{ type: 'output_text', text: 'A revised reply' }] }] }])
    expect(blocks[0].items[1]).toBe(reply)
  })

  it('recognizes only an explicit leading command with a request', () => {
    expect(parseTranscriptRevisionRequest(' /revise fix the first answer\nnot the second')).toBe('fix the first answer\nnot the second')
    for (const value of ['/revise', '/revise  ', '/revised test', 'example: /revise test']) expect(parseTranscriptRevisionRequest(value)).toBeNull()
  })
})
