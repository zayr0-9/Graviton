import type { ChatNode } from '../../features/chats/chatTypes'

/** Preorder, preserving sibling order without a call frame per tree level. */
export function* walkChatTree(root: ChatNode): Generator<ChatNode> {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    yield node
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i])
  }
}

export interface HiddenTreeBoundary {
  parentId: string | null
  childIds: string[]
}

/** Promote hidden nodes directly into their output parent, without copying paths. */
export function filterChatTree(
  root: ChatNode,
  present: (node: ChatNode, hasSiblings: boolean) => { promote: boolean; message: string; hiddenBoundary?: boolean },
  hasSiblings = false,
  boundaries?: HiddenTreeBoundary[]
): ChatNode[] {
  const roots: ChatNode[] = []
  const pending = [{ node: root, output: roots, hasSiblings, parentId: null as string | null,
    boundary: null as HiddenTreeBoundary | null }]
  while (pending.length) {
    const { node, output, hasSiblings: siblings, parentId, boundary: incomingBoundary } = pending.pop()!
    const presentation = present(node, siblings)
    let children = output
    let boundary = incomingBoundary
    let visibleParentId = parentId
    if (presentation.promote && presentation.hiddenBoundary && boundaries && !boundary) {
      boundary = { parentId, childIds: [] }
      boundaries.push(boundary)
    }
    if (!presentation.promote) {
      const copy = { ...node, message: presentation.message, children: [] as ChatNode[] }
      output.push(copy)
      children = copy.children
      boundary?.childIds.push(node.id)
      boundary = null
      visibleParentId = node.id
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], output: children, hasSiblings: node.children.length > 1,
        parentId: visibleParentId, boundary })
    }
  }
  return roots
}

export function layoutChatTree(root: ChatNode, horizontalSpacing: number, verticalSpacing: number, gapBefore = new Set<string>()) {
  const positions: Record<string, { x: number; y: number; node: ChatNode }> = {}
  const ordered = Array.from(walkChatTree(root))
  const widths = new Map<ChatNode, number>()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i]
    widths.set(node, node.children.length ? node.children.reduce((sum, child) => sum + widths.get(child)!, 0) : 1)
  }
  const pending = [{ node: root, x: 0, y: 0 }]
  while (pending.length) {
    const { node, x, y } = pending.pop()!
    positions[node.id] = { node, x, y }
    let childX = x - ((widths.get(node)! - 1) * horizontalSpacing) / 2
    const children = []
    // Siblings share a branch rail, so reserve the same gap for the whole row.
    const boundaryGap = node.children.some(child => gapBefore.has(child.id)) ? 24 : 0
    for (const child of node.children) {
      const width = widths.get(child)!
      children.push({ node: child, x: childX + ((width - 1) * horizontalSpacing) / 2, y: y + verticalSpacing + boundaryGap })
      childX += width * horizontalSpacing
    }
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
  return positions
}
