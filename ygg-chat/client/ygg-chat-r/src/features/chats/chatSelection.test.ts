import { describe, expect, it } from 'vitest'
import { createChatRouteGate, getChatSelectionHref, parseChatSelectionHref, resolveLocalChatSelection, isPendingViewStreamOwned, initialChatSelection, type ChatSelectionTarget } from './chatSelection'
import type { Message } from './chatTypes'
import { createEmptyStreamState } from './streamHelpers'

const rows = [
  { id: 'root', parent_id: null }, { id: 'a', parent_id: 'root' }, { id: 'b', parent_id: 'root' },
].map(row => ({ ...row, conversation_id: 'c', created_at: '2026-01-01' })) as Message[]
const current = { conversationId: 'c', lineageId: 'fork-b', path: ['root', 'b'], focus: 'b' }

describe('chat selection targets', () => {
  it.each<ChatSelectionTarget>([
    { kind: 'conversation', conversationId: 'c/#%', projectId: 'p space' },
    { kind: 'message', conversationId: 'c', messageId: 'm/# %' },
    { kind: 'lineage', conversationId: 'c', lineageId: 'l/#%', messageId: 'm&x=#' },
  ])('round trips encoded $kind targets', target => {
    expect(parseChatSelectionHref(getChatSelectionHref(target))).toEqual({ ...target, projectId: target.projectId || 'unknown', storageMode: undefined })
  })
  it.each(['/settings', '#section', '/chat/p/%XX', '/chat/p/c/lineage/%XX', 'https://example.com/chat/p/c'])('does not reinterpret %s', href => {
    expect(parseChatSelectionHref(href)).toBeNull()
  })
  it('preserves storage mode and gives lineage precedence over legacy hash', () => {
    expect(parseChatSelectionHref('/chat/p/c/lineage/l?focus=m#other', 'local')).toMatchObject({ kind: 'lineage', lineageId: 'l', messageId: 'm', storageMode: 'local' })
  })
  it('preserves a valid explicit on-path hint and exact identity', () => {
    expect(resolveLocalChatSelection({ kind: 'message', conversationId: 'c', messageId: 'root', path: ['root', 'b'] }, rows, current)).toEqual({ ...current, focus: 'root' })
  })
  it('does not trust an invalid path hint or infer lineage from an ancestor', () => {
    expect(resolveLocalChatSelection({ kind: 'message', conversationId: 'c', messageId: 'a', path: ['root', 'b', 'a'] }, rows, current)).toMatchObject({ path: ['root', 'a'], lineageId: null })
  })
  it('rejects missing/cross-conversation messages', () => {
    expect(resolveLocalChatSelection({ kind: 'message', conversationId: 'other', messageId: 'a' }, rows, current)).toBeNull()
  })
  it('retains a valid bare-conversation selection and handles empty conversations', () => {
    expect(resolveLocalChatSelection({ kind: 'conversation', conversationId: 'c' }, rows, current)).toEqual(current)
    expect(resolveLocalChatSelection({ kind: 'conversation', conversationId: 'empty' }, [], current)).toMatchObject({ path: [], focus: null, lineageId: null })
  })
})

describe('view-owned startup stream', () => {
  const stream = { ...createEmptyStreamState(), active: true, conversationId: 'c' }
  const owner = { streamId: 's', conversationId: 'c', selectionRevision: 1 }
  const selection = { ...initialChatSelection(), revision: 1, fallbackRevision: 1 }
  it('survives normal path changes but not a new selection revision', () => {
    expect(isPendingViewStreamOwned(owner, 'c', selection, stream)).toBe(true)
    expect(isPendingViewStreamOwned(owner, 'c', { ...selection, revision: 2, fallbackRevision: 2 }, stream)).toBe(false)
  })
  it('cannot leak into a pending selection, another conversation, or completed run', () => {
    expect(isPendingViewStreamOwned(owner, 'c', { ...selection, status: 'pending' }, stream)).toBe(false)
    expect(isPendingViewStreamOwned(owner, 'd', selection, stream)).toBe(false)
    expect(isPendingViewStreamOwned(owner, 'c', selection, { ...stream, active: false })).toBe(false)
  })
})

describe('route visit ingestion', () => {
  it('consumes explicit navigation once and reselects the same URL on a later visit', () => {
    const gate = createChatRouteGate()
    gate.expect('one', '/chat/p/c#a')
    expect(gate.consume('key1', '/chat/p/c#a', 'one')).toBe(false)
    expect(gate.consume('key1', '/chat/p/c#a', 'one')).toBe(false)
    expect(gate.consume('key2', '/settings')).toBe(true)
    expect(gate.consume('key1', '/chat/p/c#a', 'one')).toBe(true) // POP, not a new push
  })
  it('ingests focus changes and unrelated routes instead of swallowing them as outgoing', () => {
    const gate = createChatRouteGate()
    gate.expect('one', '/chat/p/c#a')
    expect(gate.consume('key2', '/chat/p/c#b', 'two')).toBe(true)
    expect(gate.consume('key3', '/chat/p/c#b', 'three')).toBe(true)
  })
})

it('does not promote an earlier outgoing route event over a newer request', () => {
  const gate = createChatRouteGate()
  gate.expect('a', '/chat/p/a')
  gate.expect('b', '/chat/p/b')
  expect(gate.consume('ka', '/chat/p/a', 'a')).toBe(false)
  expect(gate.consume('kb', '/chat/p/b', 'b')).toBe(false)
  expect(gate.consume('ka', '/chat/p/a', 'a')).toBe(true)
})
