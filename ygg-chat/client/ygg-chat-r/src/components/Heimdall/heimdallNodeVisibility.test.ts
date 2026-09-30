import { describe, expect, it } from 'vitest'
import { shouldPromoteHeimdallNode } from './heimdallNodeVisibility'

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
