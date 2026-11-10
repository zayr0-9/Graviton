import { describe, expect, it } from 'vitest'
import { resolveExplainAnchorId, resolveLiveExplainSource, updateLiveExplainSurface, type LiveExplainSource } from './liveExplainSelection'

const source: LiveExplainSource = { streamId: 'run', messageId: null, previousCompletedId: 'old' }
const messages = [
  { id: 'old', role: 'assistant', parent_id: 'user' },
  { id: 'turn-1', role: 'assistant', parent_id: 'old' },
  { id: 'context', role: 'system', parent_id: 'turn-1' },
  { id: 'turn-2', role: 'assistant', parent_id: 'context' },
]

describe('live Explain modal ownership', () => {
  it.each(['tail', 'virtual'] as const)('only lets the %s owner clear its claim', surface => {
    const other = surface === 'tail' ? 'virtual' : 'tail'
    const open = updateLiveExplainSurface(null, surface, true)
    expect(open).toBe(surface)
    expect(updateLiveExplainSurface(open, other, false)).toBe(surface)
    expect(updateLiveExplainSurface(open, surface, false)).toBeNull()
  })

  it('preserves a tail modal when the next tool turn mounts a closed virtual row', () => {
    let owner = updateLiveExplainSurface(null, 'tail', true)
    owner = updateLiveExplainSurface(owner, 'virtual', false)
    expect(owner).toBe('tail')
  })
})

describe('live Explain source identity', () => {
  it('captures the first persisted turn and never follows later turns', () => {
    expect(resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: 'old' }, messages)).toBe(source)
    const first = resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: 'turn-1' }, messages)
    expect(first.messageId).toBe('turn-1')
    expect(resolveLiveExplainSource(first, { id: 'run', lastCompletedMessageId: 'turn-2' }, messages).messageId).toBe('turn-1')
  })

  it('targets the assistant response rather than a trailing context row', () => {
    expect(resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: 'context' }, messages).messageId).toBe('turn-1')
  })

  it('does not use another stream, a previous turn, missing rows or cyclic ancestry', () => {
    expect(resolveLiveExplainSource(source, { id: 'next-run', lastCompletedMessageId: 'turn-2' }, messages)).toBe(source)
    expect(resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: null }, messages)).toBe(source)
    expect(resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: 'missing' }, messages)).toBe(source)
    expect(resolveLiveExplainSource(source, { id: 'run', lastCompletedMessageId: 'cycle' }, [
      { id: 'cycle', role: 'system', parent_id: 'cycle' },
    ])).toBe(source)
  })

  it('waits for missing intermediate ancestry instead of locking a later turn', () => {
    const stream = { id: 'run', lastCompletedMessageId: 'turn-2' }
    expect(resolveLiveExplainSource(source, stream, messages.filter(message => message.id !== 'turn-1'))).toBe(source)
    expect(resolveLiveExplainSource(source, stream, messages).messageId).toBe('turn-1')
  })

  it('retains a known live message id after abort rather than falling back to an older turn', () => {
    const known = { ...source, messageId: 'live' }
    expect(resolveLiveExplainSource(known, { id: 'run', lastCompletedMessageId: 'old' }, messages)).toBe(known)
  })
})

describe('Explain anchor', () => {
  const claude = (checkpoint: boolean) => JSON.stringify({ claude: { sessionId: 's', checkpoint } })
  const rows = [
    { id: 'u1', role: 'user', meta: JSON.stringify({ modelSelection: { provider: 'Claude Code' } }) },
    { id: 'a1', role: 'assistant', meta: claude(false) },
    { id: 'a2', role: 'assistant', meta: claude(true) },
    { id: 'u2', role: 'user', meta: JSON.stringify({ modelSelection: { provider: 'Claude Code' } }) },
    { id: 'a3', role: 'assistant', meta: claude(false) },
    { id: 'plain', role: 'assistant', meta: null },
  ]
  const path = ['u1', 'a1', 'a2', 'u2', 'a3']

  it('keeps non-Claude rows and Claude checkpoints as their own anchor', () => {
    expect(resolveExplainAnchorId('plain', rows, [])).toBe('plain')
    expect(resolveExplainAnchorId('a2', rows, path)).toBe('a2')
  })

  it('anchors an intermediate Claude row at the checkpoint ending its turn', () => {
    expect(resolveExplainAnchorId('a1', rows, path)).toBe('a2')
    expect(resolveExplainAnchorId('u1', rows, path)).toBe('a2')
  })

  it('refuses a turn without a completed checkpoint or off the selected path', () => {
    expect(resolveExplainAnchorId('a3', rows, path)).toBeNull()
    expect(resolveExplainAnchorId('a1', rows, ['u1'])).toBeNull()
    expect(resolveExplainAnchorId('missing', rows, path)).toBeNull()
  })
})
