import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContextInjectionCard } from './ContextInjectionCard'
import { HookActivityCard } from './HookActivityCard'
import { OperationModeNotice } from './OperationModeNotice'
import { SummarisedMessage } from './SummarisedMessage'
import { MESSAGE_NOTICE_ROW_CLASS, MESSAGE_NOTICE_WRAPPER_CLASS } from './chatMessageShared'
import type { HookRunRecord } from '../../features/chats/chatTypes'

const entries = [{ path: '/project/AGENTS.md', label: 'Instructions', text: 'Hidden instructions', reason: 'compact' }]
const runs = [{ id: 'hook', event: 'Stop', status: 'succeeded', createdAt: '2026-10-14', updatedAt: '2026-10-14' }] as HookRunRecord[]

describe('transcript notice alignment', () => {
  it.each([
    ['summary', <SummarisedMessage customThemeEnabled={false} />],
    ['mode', <OperationModeNotice mode='execute' initial />],
    ['instructions', <ContextInjectionCard variant='launch' entries={entries} customThemeEnabled={false} />],
  ])('uses the same outer gutter and icon/label row for %s', (_name, node) => {
    const html = renderToStaticMarkup(node)
    expect(html).toContain(MESSAGE_NOTICE_WRAPPER_CLASS)
    expect(html).toContain(MESSAGE_NOTICE_ROW_CLASS)
    expect(html).toContain(_name === 'summary' ? 'width="14" height="14"' : 'width="16" height="16"')
  })

  it('aligns inline instruction and hook cards without adding a second outer gutter', () => {
    for (const node of [
      <ContextInjectionCard entries={entries} customThemeEnabled={false} />,
      <HookActivityCard initialRuns={runs} messageId='reply' />,
    ]) {
      const html = renderToStaticMarkup(node)
      expect(html).toContain(MESSAGE_NOTICE_ROW_CLASS)
      expect(html).not.toContain(MESSAGE_NOTICE_WRAPPER_CLASS)
      expect(html).not.toContain('uppercase')
      expect(html).not.toContain('tracking-')
      expect(html).toContain('shrink-0')
      expect(html).not.toContain('Hidden instructions')
    }
  })
})
