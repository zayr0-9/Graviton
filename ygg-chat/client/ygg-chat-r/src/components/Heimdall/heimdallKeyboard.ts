export type KeyboardTreeNode = { id: string; message: string; children: KeyboardTreeNode[] }
export type KeyboardTreeEntry = {
  node: KeyboardTreeNode
  parent: string | null
  level: number
  siblings: string[]
  horizontalPeers: string[]
}

/** Logical, filtered tree order, independent of pan/zoom viewport culling. */
export const buildKeyboardTree = (root: KeyboardTreeNode | null) => {
  const entries = new Map<string, KeyboardTreeEntry>()
  const rows = new Map<number, string[]>()
  const visit = (nodes: KeyboardTreeNode[], parent: string | null, level: number) => {
    const siblings = nodes.map(node => node.id)
    nodes.forEach(node => {
      // Depth-first traversal preserves left-to-right layout order within each row.
      // Share the row array so peers include nodes under different parents.
      const horizontalPeers = rows.get(level) ?? []
      rows.set(level, horizontalPeers)
      horizontalPeers.push(node.id)
      entries.set(node.id, { node, parent, level, siblings, horizontalPeers })
      visit(node.children, node.id, level + 1)
    })
  }
  // The synthetic root is not an actionable message.
  visit(root?.id === 'root' ? root.children : root ? [root] : [], null, 1)
  return entries
}

export const resolveKeyboardNode = (
  entries: Map<string, KeyboardTreeEntry>, cursor: string | null, preferred: Array<string | null>
): string | null => {
  for (const id of [cursor, ...preferred]) {
    if (id != null && entries.has(id)) return id
  }
  return entries.keys().next().value ?? null
}

export const moveKeyboardNode = (
  entries: Map<string, KeyboardTreeEntry>, id: string, direction: 'parent' | 'child' | 'previousSibling' | 'nextSibling',
  currentPath: string[]
): string => {
  const entry = entries.get(id)
  if (!entry) return id
  if (direction === 'parent') return entry.parent ?? id
  if (direction === 'child') {
    return entry.node.children.find(child => currentPath.includes(child.id))?.id ?? entry.node.children[0]?.id ?? id
  }
  const index = entry.horizontalPeers.indexOf(id) + (direction === 'previousSibling' ? -1 : 1)
  return entry.horizontalPeers[index] ?? id
}

export const getKeyboardActivationPath = (id: string, currentPath: string[], buildPath: (id: string) => string[]) =>
  currentPath.includes(id) ? currentPath : buildPath(id)
