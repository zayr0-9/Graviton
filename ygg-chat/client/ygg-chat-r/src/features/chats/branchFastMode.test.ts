import { afterEach, describe, expect, it, vi } from 'vitest'
import { branchModelKey } from './branchModelSelection'
import { loadBranchFastModeDrafts, resolveBranchFastMode, saveBranchFastModeDrafts } from './branchFastMode'
import type { ChatState } from './chatTypes'

function state(): ChatState {
  return {
    conversation: { currentConversationId: 'c', currentLineageId: 'a', currentPath: ['root', 'a'], messages: [
      { id: 'root', meta: { fastMode: true } },
      { id: 'a' },
      { id: 'b', meta: JSON.stringify({ fastMode: false }) },
    ] },
  } as unknown as ChatState
}

afterEach(() => vi.unstubAllGlobals())

describe('branch Fast mode', () => {
  it('restores sibling branches independently, including an explicit off choice', () => {
    const chat = state()
    expect(resolveBranchFastMode(chat)).toBe(true)
    expect(resolveBranchFastMode(chat, ['root', 'b'], 'c', 'b')).toBe(false)
    expect(resolveBranchFastMode(chat)).toBe(true)
  })
  it('inherits the nearest recorded choice on a new child branch', () => {
    expect(resolveBranchFastMode(state(), ['root', 'a', 'new'], 'c', 'new-lineage')).toBe(true)
    expect(resolveBranchFastMode(state(), ['root', 'b', 'new'], 'c', null)).toBe(false)
  })
  it('keeps an unsent off choice while a lineage grows without leaking to siblings', () => {
    const chat = state()
    chat.branchFastModeDrafts = { [branchModelKey('c', 'lineage:a')]: false }
    expect(resolveBranchFastMode(chat, ['root', 'a', 'later'])).toBe(false)
    expect(resolveBranchFastMode(chat, ['root', 'a'], 'c', 'fork')).toBe(true)
  })
  it('scopes drafts to conversation and lineage', () => {
    const chat = state()
    chat.branchFastModeDrafts = {
      [branchModelKey('other', 'lineage:a')]: false,
      [branchModelKey('c', 'lineage:b')]: false,
    }
    expect(resolveBranchFastMode(chat)).toBe(true)
  })
  it('resolves tip-anchored drafts before metadata and handles an empty conversation', () => {
    const chat = state()
    chat.branchFastModeDrafts = { [branchModelKey('c', 'a')]: false, [branchModelKey('empty', null)]: true }
    expect(resolveBranchFastMode(chat)).toBe(false)
    expect(resolveBranchFastMode(chat, [], 'empty', null)).toBe(true)
  })
  it('defaults to standard for legacy or malformed metadata, not the old global toggle', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'true' })
    const chat = state()
    chat.conversation.messages = [{ id: 'root', meta: '{broken' }, { id: 'a', meta: { fastMode: 'true' } }] as any
    expect(resolveBranchFastMode(chat)).toBe(false)
  })
  it('round-trips both on and off drafts and filters malformed storage', () => {
    let stored = ''
    vi.stubGlobal('localStorage', {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value },
    })
    const drafts = { [branchModelKey('c', 'lineage:a')]: true, [branchModelKey('c', 'lineage:b')]: false }
    saveBranchFastModeDrafts(drafts)
    expect(loadBranchFastModeDrafts()).toEqual(drafts)
    stored = '{"a":true,"b":false,"bad":"true","null":null}'
    expect(loadBranchFastModeDrafts()).toEqual({ a: true, b: false })
    for (const invalid of ['{broken', 'null', '[]']) {
      stored = invalid
      expect(loadBranchFastModeDrafts()).toEqual({})
    }
  })
})
