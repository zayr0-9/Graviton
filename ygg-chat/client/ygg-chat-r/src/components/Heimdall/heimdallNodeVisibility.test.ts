import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../../features/chats/chatTypes'
import { buildHeimdallVisibleRoot, shouldPromoteHeimdallNode } from './heimdallNodeVisibility'

describe('shouldPromoteHeimdallNode', () => {
  it('always promotes persisted context-injection rows, including roots with siblings', () => {
    expect(shouldPromoteHeimdallNode({
      isContextInjection: true,
      isOperationModeChange: false,
      isEmpty: false,
      hasSiblings: true,
      filterEmptyMessages: false,
    })).toBe(true)
  })

  it('keeps the sibling exception for ordinary empty branch nodes', () => {
    expect(shouldPromoteHeimdallNode({
      isContextInjection: false,
      isOperationModeChange: false,
      isEmpty: true,
      hasSiblings: true,
      filterEmptyMessages: true,
    })).toBe(false)
    expect(shouldPromoteHeimdallNode({
      isContextInjection: false,
      isOperationModeChange: false,
      isEmpty: true,
      hasSiblings: false,
      filterEmptyMessages: true,
    })).toBe(true)
  })

  it('keeps real user turns, including turns that carry hook context blocks', () => {
    expect(shouldPromoteHeimdallNode({
      isContextInjection: false,
      isOperationModeChange: false,
      isEmpty: false,
      hasSiblings: false,
      filterEmptyMessages: true,
    })).toBe(false)
  })
})


describe('mode-change node visibility', () => {
  it('promotes mode-change rows only when the filter is enabled', () => {
    expect(shouldPromoteHeimdallNode({
      isContextInjection: false,
      isOperationModeChange: true,
      isEmpty: false,
      hasSiblings: true,
      filterEmptyMessages: true,
    })).toBe(true)
    expect(shouldPromoteHeimdallNode({
      isContextInjection: false,
      isOperationModeChange: true,
      isEmpty: false,
      hasSiblings: false,
      filterEmptyMessages: false,
    })).toBe(false)
  })
})

describe('buildHeimdallVisibleRoot', () => {
  const promptA: ChatNode = { id: 'prompt-a', message: 'Original prompt', sender: 'user', children: [] }
  const promptB: ChatNode = { id: 'prompt-b', message: 'Edited prompt', sender: 'user', children: [] }

  it('returns null when filtering leaves no visible nodes', () => {
    expect(buildHeimdallVisibleRoot([])).toBeNull()
  })

  it('keeps a single promoted prompt as the root', () => {
    expect(buildHeimdallVisibleRoot([promptA])).toBe(promptA)
  })

  it('wraps multiple promoted prompts in a synthetic Conversation root', () => {
    const nodes = [promptA, promptB]
    const root = buildHeimdallVisibleRoot(nodes)
    expect(root).toEqual({ id: 'root', message: 'Conversation', sender: 'assistant', children: nodes })
    expect(root?.children[0]).toBe(promptA)
    expect(root?.children[1]).toBe(promptB)
    expect(promptA.id).toBe('prompt-a')
    expect(promptB.id).toBe('prompt-b')
  })

  it('preserves an existing synthetic root without nesting another wrapper', () => {
    const root: ChatNode = { id: 'root', message: 'Conversation', sender: 'assistant', children: [promptA, promptB] }
    expect(buildHeimdallVisibleRoot([root])).toBe(root)
  })
})
