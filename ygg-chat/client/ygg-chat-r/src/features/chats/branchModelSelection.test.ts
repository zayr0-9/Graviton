import { describe, expect, it } from 'vitest'
import { branchModelKey, resolveBranchModelSelection } from './branchModelSelection'
import type { ChatState } from './chatTypes'

const pairA = { provider: 'OpenAI (ChatGPT)', model: 'gpt-a' }
const pairB = { provider: 'OpenRouter', model: 'model-b' }
function state(): ChatState {
  return {
    providerState: { currentProvider: 'OpenRouter', providers: [{ name: 'OpenAI (ChatGPT)' }, { name: 'OpenRouter' }] },
    conversation: { currentConversationId: 'c', currentLineageId: 'a', currentPath: ['root', 'a'], messages: [
      { id: 'root', meta: { modelSelection: { provider: 'openaichatgpt', model: 'gpt-a' } } },
      { id: 'a' },
      { id: 'b', meta: JSON.stringify({ modelSelection: pairB }) },
    ] },
  } as unknown as ChatState
}

describe('branch model selection', () => {
  it('restores each selected path independently and normalizes server provider names', () => {
    const chat = state()
    expect(resolveBranchModelSelection(chat)).toEqual(pairA)
    expect(resolveBranchModelSelection(chat, ['root', 'b'], 'c', 'b')).toEqual(pairB)
    expect(resolveBranchModelSelection(chat)).toEqual(pairA)
  })
  it('inherits recorded selections on new child branches', () => {
    expect(resolveBranchModelSelection(state(), ['root', 'a', 'new'], 'c', 'new-lineage')).toEqual(pairA)
  })
  it('keeps an unsent choice while the same lineage grows in the background', () => {
    const chat = state()
    chat.branchModelDrafts = { [branchModelKey('c', 'lineage:a')]: pairB }
    expect(resolveBranchModelSelection(chat, ['root', 'a', 'later'])).toEqual(pairB)
    expect(resolveBranchModelSelection(chat, ['root', 'a'], 'c', 'fork')).toEqual(pairA)
  })
  it('scopes drafts to conversation and lineage', () => {
    const chat = state()
    chat.branchModelDrafts = { [branchModelKey('other', 'lineage:a')]: pairB }
    expect(resolveBranchModelSelection(chat)).toEqual(pairA)
  })
  it('allows a provider change without carrying the old provider model', () => {
    const chat = state()
    chat.branchModelDrafts = { [branchModelKey('c', 'lineage:a')]: { provider: 'OpenRouter', model: null } }
    expect(resolveBranchModelSelection(chat)).toEqual({ provider: 'OpenRouter', model: null })
  })
  it('falls back safely for historical paths with no metadata and malformed metadata', () => {
    const chat = state()
    chat.conversation.messages = [{ id: 'a', meta: '{broken' }] as any
    expect(resolveBranchModelSelection(chat)).toBeNull()
  })
})
