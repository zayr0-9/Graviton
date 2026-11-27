import { afterEach, describe, expect, it, vi } from 'vitest'
import { branchModelKey } from './branchModelSelection'
import { loadBranchReasoningDrafts, resolveBranchReasoning, saveBranchReasoningDrafts } from './branchReasoning'
import type { ChatState } from './chatTypes'

const defaults = { defaultThinkingEnabled: true, defaultReasoningEffort: 'medium' as const }

function state(): ChatState {
  return {
    conversation: { currentConversationId: 'c', currentLineageId: 'a', currentPath: ['root', 'a'], messages: [
      { id: 'root', meta: { reasoningLevel: 'xhigh' } },
      { id: 'a' },
      { id: 'b', meta: JSON.stringify({ reasoningLevel: 'off' }) },
    ] },
  } as unknown as ChatState
}

afterEach(() => vi.unstubAllGlobals())

describe('branch reasoning level', () => {
  it('restores sibling branches independently, including an explicit off choice', () => {
    const chat = state()
    expect(resolveBranchReasoning(chat, defaults)).toBe('xhigh')
    expect(resolveBranchReasoning(chat, defaults, ['root', 'b'], 'c', 'b')).toBe('off')
    expect(resolveBranchReasoning(chat, defaults)).toBe('xhigh')
  })

  it('inherits the nearest recorded level on a new child branch', () => {
    expect(resolveBranchReasoning(state(), defaults, ['root', 'a', 'new'], 'c', 'new-lineage')).toBe('xhigh')
    expect(resolveBranchReasoning(state(), defaults, ['root', 'b', 'new'], 'c', null)).toBe('off')
  })

  it('keeps an unsent choice while a lineage grows without leaking to siblings', () => {
    const chat = state()
    chat.branchReasoningDrafts = { [branchModelKey('c', 'lineage:a')]: 'low' }
    expect(resolveBranchReasoning(chat, defaults, ['root', 'a', 'later'])).toBe('low')
    expect(resolveBranchReasoning(chat, defaults, ['root', 'a'], 'c', 'fork')).toBe('xhigh')
  })

  it('scopes drafts to conversation and lineage', () => {
    const chat = state()
    chat.branchReasoningDrafts = {
      [branchModelKey('other', 'lineage:a')]: 'low',
      [branchModelKey('c', 'lineage:b')]: 'low',
    }
    expect(resolveBranchReasoning(chat, defaults)).toBe('xhigh')
  })

  it('resolves tip-anchored drafts before metadata and handles an empty conversation', () => {
    const chat = state()
    chat.branchReasoningDrafts = { [branchModelKey('c', 'a')]: 'high', [branchModelKey('empty', null)]: 'low' }
    expect(resolveBranchReasoning(chat, defaults)).toBe('high')
    expect(resolveBranchReasoning(chat, defaults, [], 'empty', null)).toBe('low')
  })

  it('falls back to the Settings default when nothing valid is recorded', () => {
    const chat = state()
    chat.conversation.messages = [{ id: 'root', meta: '{broken' }, { id: 'a', meta: { reasoningLevel: 'maximum' } }] as any
    expect(resolveBranchReasoning(chat, defaults)).toBe('medium')
    expect(resolveBranchReasoning(chat, { ...defaults, defaultThinkingEnabled: false })).toBe('off')
    expect(resolveBranchReasoning(chat, { defaultThinkingEnabled: true, defaultReasoningEffort: 'xhigh' }, [], 'new', null)).toBe('xhigh')
  })

  it('round-trips drafts and filters malformed storage', () => {
    let stored = ''
    vi.stubGlobal('localStorage', {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value },
    })
    const drafts = { [branchModelKey('c', 'lineage:a')]: 'off' as const, [branchModelKey('c', 'lineage:b')]: 'xhigh' as const }
    saveBranchReasoningDrafts(drafts)
    expect(loadBranchReasoningDrafts()).toEqual(drafts)
    stored = '{"a":"low","b":"off","bad":"maximum","n":null,"t":true}'
    expect(loadBranchReasoningDrafts()).toEqual({ a: 'low', b: 'off' })
    for (const invalid of ['{broken', 'null', '[]']) {
      stored = invalid
      expect(loadBranchReasoningDrafts()).toEqual({})
    }
  })
})
