import { isDraft } from 'immer'
import type { ChatNode } from './chatTypes'

// Only trees validated and deeply frozen here may bypass recursive library walks.
const finalizedTrees = new WeakSet<object>()
export const isFinalizedChatTree = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && finalizedTrees.has(value)

/** Own an external tree, validate its shape, and freeze it without recursion. */
export function finalizeChatTree(root: ChatNode | null): ChatNode | null {
  if (root === null || isFinalizedChatTree(root)) return root
  const copies = new Map<ChatNode, ChatNode>()
  const active = new Set<ChatNode>()
  const pending: Array<{ node: ChatNode; exit: boolean }> = [{ node: root, exit: false }]
  while (pending.length) {
    const { node, exit } = pending.pop()!
    if (exit) {
      const copy = copies.get(node)!
      for (const child of node.children) copy.children.push(copies.get(child)!)
      Object.freeze(copy.children)
      Object.freeze(copy)
      finalizedTrees.add(copy)
      active.delete(node)
      continue
    }
    if (active.has(node)) throw new Error('Conversation tree contains a reference cycle')
    if (copies.has(node)) continue
    if (!node || isDraft(node) || typeof node.id !== 'string' || typeof node.message !== 'string' ||
        !['user', 'assistant', 'ex_agent'].includes(node.sender) || !Array.isArray(node.children)) {
      throw new Error('Invalid conversation tree node')
    }
    copies.set(node, { id: node.id, message: node.message, sender: node.sender, children: [] })
    active.add(node)
    pending.push({ node, exit: true })
    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], exit: false })
  }
  return copies.get(root)!
}

/** Keep RTK's checks for other data, without recursively rechecking validated trees. */
export const chatTreeSerializableCheck = {
  // RTK's frozen-object cache itself recursively walks ancestors of tree values.
  disableCache: true,
  getEntries: (value: any): [string, any][] => isFinalizedChatTree(value) ? [] : Object.entries(value),
}

// DevTools is diagnostic only: serializing the derived hierarchy can also overflow.
export const chatTreeDevToolsReplacer = (_key: string, value: unknown) =>
  isFinalizedChatTree(value) ? { derivedChatTree: true, id: (value as ChatNode).id } : value

/** Literal/replayed actions must be normalized before RTK checks their payloads. */
export const chatTreeIngressMiddleware: import('@reduxjs/toolkit').Middleware = () => next => action => {
  const input = action as { type?: string; payload?: Record<string, unknown> }
  const field = input?.type === 'chat/conversationSnapshotApplied' ? 'tree'
    : input?.type === 'chat/heimdallDataLoaded' ? 'treeData' : null
  if (field && input.payload && input.payload[field] !== undefined) {
    return next({ ...input, payload: { ...input.payload, [field]: finalizeChatTree(input.payload[field] as ChatNode | null) } })
  }
  return next(action)
}
