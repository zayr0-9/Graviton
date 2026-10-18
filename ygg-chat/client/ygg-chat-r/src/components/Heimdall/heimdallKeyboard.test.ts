import { describe, expect, it, vi } from 'vitest'
import { buildKeyboardTree, getKeyboardActivationPath, moveKeyboardNode, resolveKeyboardNode } from './heimdallKeyboard'

const leaf = (id: string) => ({ id, message: id, children: [] })
const tree = buildKeyboardTree({
  id: 'root', message: 'Conversation', children: [
    { id: 'a', message: 'a', children: [leaf('z'), leaf('b')] },
    leaf('other-root'),
  ],
})

describe('Heimdall keyboard navigation', () => {
  it('excludes synthetic root and preserves filtered visual sibling order', () => {
    expect(tree.has('root')).toBe(false)
    expect(tree.get('z')?.siblings).toEqual(['z', 'b'])
    expect(tree.get('z')?.level).toBe(2)
    expect(moveKeyboardNode(tree, 'z', 'nextSibling', [])).toBe('b')
    expect(moveKeyboardNode(tree, 'b', 'previousSibling', [])).toBe('z')
    expect(moveKeyboardNode(tree, 'a', 'nextSibling', [])).toBe('other-root')
  })

  it('crosses parent boundaries horizontally in visual row order', () => {
    const branches = buildKeyboardTree({
      id: 'top', message: 'top', children: [
        { id: 'left', message: 'left', children: [leaf('left-tip')] },
        { id: 'middle', message: 'middle', children: [leaf('middle-tip')] },
        { id: 'right', message: 'right', children: [leaf('right-tip')] },
      ],
    })
    expect(branches.get('left-tip')?.siblings).toEqual(['left-tip'])
    expect(moveKeyboardNode(branches, 'left-tip', 'nextSibling', [])).toBe('middle-tip')
    expect(moveKeyboardNode(branches, 'middle-tip', 'nextSibling', [])).toBe('right-tip')
    expect(moveKeyboardNode(branches, 'right-tip', 'previousSibling', [])).toBe('middle-tip')
    expect(moveKeyboardNode(branches, 'middle-tip', 'previousSibling', [])).toBe('left-tip')
    expect(moveKeyboardNode(branches, 'left-tip', 'previousSibling', [])).toBe('left-tip')
    expect(moveKeyboardNode(branches, 'right-tip', 'nextSibling', [])).toBe('right-tip')
    // Vertical navigation still follows the actual parent/child relationships.
    expect(moveKeyboardNode(branches, 'right-tip', 'parent', [])).toBe('right')
  })

  it('keeps horizontal moves at the current visible depth, including across roots', () => {
    const forest = buildKeyboardTree({
      id: 'root', message: 'Conversation', children: [
        { id: 'left-root', message: 'left-root', children: [
          { id: 'left-child', message: 'left-child', children: [leaf('deep-tip')] },
        ] },
        { id: 'right-root', message: 'right-root', children: [leaf('right-child')] },
      ],
    })
    expect(moveKeyboardNode(forest, 'left-child', 'nextSibling', [])).toBe('right-child')
    expect(moveKeyboardNode(forest, 'right-child', 'previousSibling', [])).toBe('left-child')
    expect(moveKeyboardNode(forest, 'deep-tip', 'nextSibling', [])).toBe('deep-tip')
  })

  it('moves to parent and prefers the current branch child', () => {
    expect(moveKeyboardNode(tree, 'z', 'parent', [])).toBe('a')
    expect(moveKeyboardNode(tree, 'a', 'child', ['a', 'b'])).toBe('b')
    expect(moveKeyboardNode(tree, 'a', 'child', [])).toBe('z')
  })

  it('does not wrap or move beyond leaves/roots', () => {
    expect(moveKeyboardNode(tree, 'a', 'parent', [])).toBe('a')
    expect(moveKeyboardNode(tree, 'z', 'child', [])).toBe('z')
    expect(moveKeyboardNode(tree, 'b', 'nextSibling', [])).toBe('b')
    expect(moveKeyboardNode(tree, 'z', 'previousSibling', [])).toBe('z')
  })

  it('recovers focus after filtering/deletion and handles empty trees', () => {
    expect(resolveKeyboardNode(tree, 'removed', ['hidden', 'b', 'a'])).toBe('b')
    expect(resolveKeyboardNode(tree, 'z', ['b'])).toBe('z')
    expect(resolveKeyboardNode(tree, null, [])).toBe('a')
    expect(resolveKeyboardNode(buildKeyboardTree(null), null, [])).toBeNull()
  })

  it('preserves on-path activation and uses canonical paths (including hidden messages) off-path', () => {
    const buildPath = vi.fn(() => ['a', 'hidden', 'z'])
    expect(getKeyboardActivationPath('a', ['a', 'b'], buildPath)).toEqual(['a', 'b'])
    expect(buildPath).not.toHaveBeenCalled()
    expect(getKeyboardActivationPath('z', ['a', 'b'], buildPath)).toEqual(['a', 'hidden', 'z'])
    expect(buildPath).toHaveBeenCalledWith('z')
  })
})
