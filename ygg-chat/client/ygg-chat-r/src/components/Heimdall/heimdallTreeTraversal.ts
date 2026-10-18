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

/** Promote hidden nodes directly into their output parent, without copying paths. */
export function filterChatTree(
  root: ChatNode,
  present: (node: ChatNode, hasSiblings: boolean) => { promote: boolean; message: string },
  hasSiblings = false
): ChatNode[] {
  const roots: ChatNode[] = []
  const pending = [{ node: root, output: roots, hasSiblings }]
  while (pending.length) {
    const { node, output, hasSiblings: siblings } = pending.pop()!
    const presentation = present(node, siblings)
    let children = output
    if (!presentation.promote) {
      const copy = { ...node, message: presentation.message, children: [] as ChatNode[] }
      output.push(copy)
      children = copy.children
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], output: children, hasSiblings: node.children.length > 1 })
    }
  }
  return roots
}

export function layoutChatTree(root: ChatNode, horizontalSpacing: number, verticalSpacing: number) {
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
    for (const child of node.children) {
      const width = widths.get(child)!
      children.push({ node: child, x: childX + ((width - 1) * horizontalSpacing) / 2, y: y + verticalSpacing })
      childX += width * horizontalSpacing
    }
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
  return positions
}
