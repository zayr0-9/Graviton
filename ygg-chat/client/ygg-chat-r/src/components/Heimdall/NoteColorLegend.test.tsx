import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: true, theme: { colors: {
    settingsPaneBodyBg: { light: '#ffffff' },
    toolJobsPrimaryText: { light: '#222222' },
    toolJobsMutedText: { light: '#666666' },
  } } }),
  useHtmlDarkMode: () => false,
  getThemeModeColor: (pair: { light: string }) => pair.light,
}))

import { countTopLevelBranchNoteColors, NOTE_COLOR_LEGEND, NoteColorLegend } from './NoteColorLegend'
import type { BaseMessage } from '../../../../../shared/types'

let nextMessageId = 0
const branch = (overrides: Partial<BaseMessage> = {}) => ({
  id: `message-${nextMessageId++}` as BaseMessage['id'],
  role: 'user' as const,
  conversation_id: 'current' as BaseMessage['conversation_id'],
  parent_id: null,
  note: 'Branch summary',
  note_color: '#8b5cf6',
  ...overrides,
})

describe('NoteColorLegend', () => {
  it('counts only current-conversation top-level notes, including normalized colors', () => {
    const counts = countTopLevelBranchNoteColors([
      branch(), branch(), branch({ note_color: ' #22C55E ' }),
      branch({ parent_id: 'nested' as BaseMessage['id'] }),
      branch({ conversation_id: 'other' as BaseMessage['conversation_id'] }),
      branch({ note: '   ' }), branch({ note_color: null }), branch({ note_color: '#123456' }),
    ], 'current' as BaseMessage['conversation_id'])
    expect(counts).toEqual({ '#22c55e': 1, '#ef4444': 0, '#8b5cf6': 2, '#3b82f6': 0, '#f59e0b': 0 })
    expect(Object.values(countTopLevelBranchNoteColors([branch()], null))).toEqual([0, 0, 0, 0, 0])
  })

  it('counts prompt branches under consecutive generated launch-context roots like the sidebar', () => {
    const id = (value: string) => value as BaseMessage['id']
    const messages = [
      branch({ id: id('context'), meta: JSON.stringify({ kind: 'context_injection' }), note_color: '#ef4444' }),
      branch({ id: id('context-2'), parent_id: id('context'), meta: { kind: 'context_injection' } }),
      branch({ id: id('prompt-a'), parent_id: id('context-2') }),
      branch({ id: id('prompt-b'), parent_id: id('context'), note_color: '#22c55e' }),
      branch({ id: id('prompt-c'), parent_id: id('context-2') }),
      branch({ id: id('reply'), parent_id: id('prompt-a'), role: 'assistant' }),
      branch({ parent_id: id('reply'), note_color: '#ef4444' }),
      branch({ id: id('mid-context'), parent_id: id('reply'), meta: { kind: 'context_injection' } }),
      branch({ parent_id: id('mid-context'), note_color: '#ef4444' }),
      branch({ role: 'assistant', meta: { kind: 'context_injection' }, id: id('assistant-root') }),
      branch({ parent_id: id('assistant-root'), note_color: '#ef4444' }),
      branch({ parent_id: id('missing'), note_color: '#ef4444' }),
    ]
    expect(countTopLevelBranchNoteColors(messages, 'current' as BaseMessage['conversation_id']))
      .toEqual({ '#22c55e': 1, '#ef4444': 0, '#8b5cf6': 2, '#3b82f6': 0, '#f59e0b': 0 })
  })

  it('does not treat malformed or unrelated metadata as a transparent root', () => {
    for (const meta of ['{broken', '{}', '{"kind":"operation_mode_change"}', null]) {
      const root = branch({ meta })
      expect(countTopLevelBranchNoteColors([root, branch({ parent_id: root.id, note_color: '#ef4444' })],
        'current' as BaseMessage['conversation_id']))
        .toEqual({ '#22c55e': 0, '#ef4444': 0, '#8b5cf6': 1, '#3b82f6': 0, '#f59e0b': 0 })
    }
  })

  it('renders the branch count before each color and label, including zero counts', () => {
    const html = renderToStaticMarkup(<NoteColorLegend buttonClassName='control' messages={[branch(), branch()]}
      conversationId={'current' as BaseMessage['conversation_id']} />)
    expect(html).toContain('aria-label="2 top-level branches">2</span>')
    expect(html).toContain('aria-label="0 top-level branches">0</span>')
    expect(html.indexOf('aria-label="2 top-level branches"')).toBeLessThan(html.indexOf('background-color:#8b5cf6'))
  })

  it('matches the hook palette and its semantic category order', () => {
    const hook = readFileSync(new URL('../../../.ygg/hooks/root_note_stop.py', import.meta.url), 'utf8')
    const presets = hook.split('NOTE_COLOR_PRESETS = [')[1].split(']')[0]
    expect(NOTE_COLOR_LEGEND.map(entry => entry.color)).toEqual(presets.match(/#[0-9a-f]{6}/g))
    expect(NOTE_COLOR_LEGEND.map(entry => entry.label)).toEqual([
      'Questions / clarifications / help',
      'Bugs / errors / fixes',
      'New features / enhancements',
      'Refactors / improvements / performance',
      'General / documentation / other',
    ])
  })

  it('renders an accessible, initially closed, theme-aware legend', () => {
    const html = renderToStaticMarkup(<NoteColorLegend buttonClassName='control' />)
    expect(html).toContain('aria-label="Note color legend"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-origin="bottom-right"')
    expect(html).toContain('background-color:#ffffff;color:#222222')
    expect(html).toContain('color:#666666')
    for (const { color, label } of NOTE_COLOR_LEGEND) {
      expect(html).toContain(`background-color:${color}`)
      expect(html).toContain(label)
    }
  })
})
