import { describe, expect, it } from 'vitest'
import { branchModelKey, isCleanStartBranchEdit, resolveBranchModelSelection, resolveComposerModelSelection, resolveComposerClaudeLock, resolveComposerSummaryHandoff, resolveSummaryContinuation } from './branchModelSelection'
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

it('Claude persisted identity overrides tip/lineage drafts and is inherited by forks', () => {
  const chat = state()
  chat.providerState.providers.push({ name: 'Claude Code' } as any)
  chat.conversation.messages[0].meta = { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } }
  chat.branchModelDrafts = { [branchModelKey('c', 'lineage:a')]: pairB }
  expect(resolveBranchModelSelection(chat)).toEqual({ provider: 'Claude Code', model: 'claude-opus-5-5' })
  expect(resolveBranchModelSelection(chat, ['root', 'fork'], 'c', 'fork')).toEqual({ provider: 'Claude Code', model: 'claude-opus-5-5' })
})

it('Claude branches lock only the provider: Claude model drafts and the nearest recorded model apply', () => {
  const chat = state()
  chat.providerState.providers.push({ name: 'Claude Code' } as any)
  chat.conversation.messages[0].meta = { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } }
  chat.conversation.messages[1].meta = { modelSelection: { provider: 'claudecode', model: 'claude-haiku-5-5' } }
  expect(resolveComposerClaudeLock(chat)).toEqual({ provider: 'Claude Code', model: 'claude-haiku-5-5' })
  expect(resolveBranchModelSelection(chat)).toEqual({ provider: 'Claude Code', model: 'claude-haiku-5-5' })
  const sonnet = { provider: 'Claude Code', model: 'claude-sonnet-5-5' }
  chat.branchModelDrafts = { [branchModelKey('c', 'lineage:a')]: sonnet }
  expect(resolveBranchModelSelection(chat)).toEqual(sonnet)
  expect(resolveComposerClaudeLock(chat)).not.toBeNull()
  // A non-handoff editor may change the Claude model but not the provider.
  chat.conversation.messages[1] = { ...chat.conversation.messages[1], conversation_id: 'c', parent_id: 'root', role: 'user' } as any
  chat.composition = { editingBranch: true, branchEditMessageId: 'a', branchEditModelSelection: sonnet } as any
  expect(resolveComposerModelSelection(chat)).toEqual(sonnet)
  chat.composition.branchEditModelSelection = pairB
  expect(resolveComposerModelSelection(chat)?.provider).toBe('Claude Code')
})

describe('fresh first-prompt branch selection', () => {
  function editing(prefix: any[] = []) {
    const chat = state()
    chat.providerState.providers.push({ name: 'Claude Code' } as any)
    chat.conversation.messages = [...prefix, {
      id: 'prompt', conversation_id: 'c', parent_id: prefix.at(-1)?.id ?? null, role: 'user',
      meta: { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } },
    }, { id: 'answer', conversation_id: 'c', parent_id: 'prompt', role: 'assistant' }] as any
    chat.conversation.currentPath = chat.conversation.messages.map(row => row.id)
    chat.composition = { editingBranch: true, branchEditMessageId: 'prompt', branchEditModelSelection: pairB } as any
    return chat
  }
  it('unlocks only the editor and leaves the source and explicit pane selections locked', () => {
    const chat = editing([{ id: 'context', conversation_id: 'c', parent_id: null, role: 'user', meta: { kind: 'context_injection' } }])
    expect(isCleanStartBranchEdit(chat)).toBe(true)
    expect(resolveComposerClaudeLock(chat)).toBeNull()
    expect(resolveComposerModelSelection(chat)).toEqual(pairB)
    expect(resolveBranchModelSelection(chat)).toEqual({ provider: 'Claude Code', model: 'claude-opus-5-5' })
    chat.composition.editingBranch = false
    expect(resolveComposerModelSelection(chat)?.provider).toBe('Claude Code')
    expect(resolveComposerClaudeLock(chat)).not.toBeNull()
  })
  it.each([
    [{ id: 'earlier', parent_id: null, role: 'user' }],
    [{ id: 'tools', parent_id: null, role: 'assistant', content: '' }],
    [{ id: 'summary', parent_id: null, role: 'system', meta: { kind: 'compaction_summary', state: 'committed' } }],
    [{ id: 'context', parent_id: 'missing', role: 'user', meta: { kind: 'context_injection' } }],
    [{ id: 'context', parent_id: 'context', role: 'user', meta: { kind: 'context_injection' } }],
  ])('does not confuse hidden/history/incomplete ancestry with a clean root: %j', prefix => {
    const chat = editing([{ ...prefix, conversation_id: 'c' }])
    expect(isCleanStartBranchEdit(chat)).toBe(false)
    expect(resolveComposerClaudeLock(chat)).not.toBeNull()
    expect(resolveComposerModelSelection(chat)?.provider).toBe('Claude Code')
  })
  it('accepts known launch mode/access notices, but refuses foreign source rows', () => {
    const chat = editing([
      { id: 'context', parent_id: null, role: 'user', meta: { kind: 'context_injection' }, conversation_id: 'c' },
      { id: 'mode', parent_id: 'context', role: 'user', meta: { kind: 'operation_mode_change' }, conversation_id: 'c' },
      { id: 'access', parent_id: 'mode', role: 'user', meta: { kind: 'full_access_change' }, conversation_id: 'c' },
    ])
    expect(isCleanStartBranchEdit(chat)).toBe(true)
    chat.conversation.messages[0].conversation_id = 'other'
    expect(isCleanStartBranchEdit(chat)).toBe(false)
  })
})

it.each(['context_injection', 'operation_mode_change', 'full_access_change', 'compaction_instruction', 'compaction_resume', 'watcher_completion'])('does not unlock an automated %s user row as a first prompt', kind => {
  const chat = state()
  chat.conversation.messages = [{ id: 'automated', conversation_id: 'c', parent_id: null, role: 'user', meta: { kind } }] as any
  expect(isCleanStartBranchEdit(chat, 'automated')).toBe(false)
})

describe('summary handoff selection', () => {
  it('unlocks only a committed summary branch editor, then uses the new execution identity', () => {
    const chat = state()
    chat.providerState.providers.push({ name: 'Claude Code' } as any)
    chat.conversation.messages = [
      { id: 'root', conversation_id: 'c', parent_id: null, role: 'user', meta: { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } } },
      { id: 'summary', conversation_id: 'c', parent_id: 'root', role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed' } },
    ] as any
    chat.conversation.currentPath = ['root', 'summary']
    chat.composition = { editingBranch: true, branchEditMessageId: 'summary', branchEditModelSelection: pairB } as any
    expect(resolveComposerClaudeLock(chat)).toBeNull()
    expect(resolveComposerModelSelection(chat)).toEqual(pairB)
    expect(resolveBranchModelSelection(chat)?.provider).toBe('Claude Code')
    ;(chat.conversation.messages[1].meta as any).state = 'pending'
    expect(resolveComposerClaudeLock(chat)?.provider).toBe('Claude Code')
    ;(chat.conversation.messages[1].meta as any).state = 'committed'
    chat.composition.editingBranch = false
    chat.conversation.messages.push({ id: 'handoff', conversation_id: 'c', parent_id: 'summary', role: 'user',
      meta: { executionHandoff: { summaryMessageId: 'summary' }, modelSelection: pairB } } as any)
    chat.conversation.currentPath.push('handoff')
    expect(resolveComposerClaudeLock(chat)).toBeNull()
    expect(resolveBranchModelSelection(chat)).toEqual(pairB)
    // Back at the summary tip, the idle composer may hand off away from Claude again.
    chat.conversation.currentPath = ['root', 'summary']
    expect(resolveComposerClaudeLock(chat)).toBeNull()
  })

  it('lets the idle composer leave Claude at a summary tip, and locks again after real work', () => {
    const chat = state()
    chat.providerState.providers.push({ name: 'Claude Code' } as any)
    chat.conversation.messages = [
      { id: 'root', conversation_id: 'c', parent_id: null, role: 'user', meta: { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } } },
      { id: 'summary', conversation_id: 'c', parent_id: 'root', role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed' } },
      { id: 'context', conversation_id: 'c', parent_id: 'summary', role: 'user', meta: { kind: 'context_injection' } },
    ] as any
    chat.conversation.currentPath = ['root', 'summary', 'context']
    expect(resolveComposerClaudeLock(chat)).toBeNull()
    expect(resolveBranchModelSelection(chat)?.provider).toBe('Claude Code')
    expect(resolveComposerSummaryHandoff(chat, 'Claude Code')).toBeNull()
    expect(resolveComposerSummaryHandoff(chat, pairB.provider)?.id).toBe('summary')
    chat.branchModelDrafts = { [branchModelKey('c', 'lineage:a')]: pairB }
    expect(resolveBranchModelSelection(chat)).toEqual(pairB)
    chat.conversation.messages.push({ id: 'work', conversation_id: 'c', parent_id: 'context', role: 'user', content: 'work',
      meta: { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } } } as any)
    chat.conversation.currentPath.push('work')
    expect(resolveComposerClaudeLock(chat)?.provider).toBe('Claude Code')
    expect(resolveBranchModelSelection(chat)?.provider).toBe('Claude Code')
    expect(resolveComposerSummaryHandoff(chat, pairB.provider)).toBeNull()
  })

  it('keeps same-family continuation ordinary and still hands off non-Claude summaries to Claude', () => {
    const chat = state()
    chat.providerState.providers.push({ name: 'Claude Code' } as any)
    chat.conversation.messages = [
      { id: 'root', conversation_id: 'c', parent_id: null, role: 'user', meta: { modelSelection: pairB } },
      { id: 'summary', conversation_id: 'c', parent_id: 'root', role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed' } },
    ] as any
    chat.conversation.currentPath = ['root', 'summary']
    expect(resolveComposerSummaryHandoff(chat, pairB.provider)).toBeNull()
    expect(resolveComposerSummaryHandoff(chat, 'Claude Code')?.id).toBe('summary')
  })

  it('hands off from a copied summary for every provider, since the copy has no native session', () => {
    const chat = state()
    chat.providerState.providers.push({ name: 'Claude Code' } as any)
    const claude = { provider: 'claudecode', model: 'claude-opus-5-5' }
    chat.conversation.messages = [
      { id: 'root', conversation_id: 'c', parent_id: null, role: 'user', meta: { modelSelection: claude, transfer: { sourceMessageId: 'r' } } },
      { id: 'summary', conversation_id: 'c', parent_id: 'root', role: 'assistant', content: 'Portable state',
        meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 's' }, transfer: { sourceMessageId: 's1' } } },
    ] as any
    chat.conversation.currentPath = ['root', 'summary']
    expect(resolveComposerSummaryHandoff(chat, 'Claude Code')?.id).toBe('summary')
    expect(resolveComposerSummaryHandoff(chat, pairB.provider)?.id).toBe('summary')
    expect(resolveComposerClaudeLock(chat)).toBeNull()
  })
})

describe('composer summary handoff boundary', () => {
  function compacted() {
    const chat = state()
    chat.conversation.messages = [
      { id: 'root', conversation_id: 'c', parent_id: null, role: 'user' },
      { id: 'summary', conversation_id: 'c', parent_id: 'root', role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed' } },
      { id: 'context', conversation_id: 'c', parent_id: 'summary', role: 'user', meta: { kind: 'context_injection' } },
      { id: 'mode', conversation_id: 'c', parent_id: 'context', role: 'user', meta: { kind: 'operation_mode_change' } },
    ] as any
    chat.conversation.currentPath = ['root', 'summary', 'context', 'mode']
    return chat
  }
  it('recognizes the summary through restored context and settings notices', () => {
    const chat = compacted()
    expect(resolveSummaryContinuation(chat)?.id).toBe('summary')
    expect(resolveSummaryContinuation(chat, ['root', 'summary'])?.id).toBe('summary')
  })
  it.each(['user', 'assistant'])('does not unlock after real %s activity', role => {
    const chat = compacted()
    chat.conversation.messages.push({ id: 'work', conversation_id: 'c', parent_id: 'mode', role, content: 'work' } as any)
    chat.conversation.currentPath.push('work')
    expect(resolveSummaryContinuation(chat)).toBeNull()
  })
  it.each(['pending', 'empty', 'missing', 'foreign', 'sibling'])('fails closed for a %s boundary', kind => {
    const chat = compacted()
    if (kind === 'pending') (chat.conversation.messages[1].meta as any).state = 'pending'
    if (kind === 'empty') chat.conversation.messages[1].content = ' '
    if (kind === 'missing') chat.conversation.messages.splice(2, 1)
    if (kind === 'foreign') chat.conversation.messages[2].conversation_id = 'other'
    if (kind === 'sibling') chat.conversation.messages[2].parent_id = 'root'
    expect(resolveSummaryContinuation(chat)).toBeNull()
  })
})
