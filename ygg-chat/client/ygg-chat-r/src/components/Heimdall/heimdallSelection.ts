import type { Message } from '../../features/chats/chatTypes'

/** Ordinary right-click opens actions for the selection; modifiers still toggle nodes. */
export function selectHeimdallContextMenuNodes(
  selectedIds: Message['id'][],
  nodeId: Message['id'],
  toggleSelection: boolean
): Message['id'][] {
  const isSelected = selectedIds.some(id => String(id) === String(nodeId))
  if (toggleSelection) {
    return isSelected
      ? selectedIds.filter(id => String(id) !== String(nodeId))
      : [...selectedIds, nodeId]
  }
  return isSelected ? selectedIds : [nodeId]
}

/** Include connecting rows and hidden-only tails, but never unselected visible descendants. */
export function expandHeimdallSelectionToBranchMessages(
  messages: Message[],
  selectedIds: Message['id'][],
  visibleNodeIds?: ReadonlySet<string>
): Message['id'][] {
  if (selectedIds.length === 0 || messages.length === 0) return selectedIds
  if (selectedIds.length === 1 && !visibleNodeIds) return selectedIds

  const selectedSet = new Set(selectedIds.map(String))
  const expandedSet = new Set(selectedSet)
  const messageById = new Map(messages.map(message => [String(message.id), message]))

  for (const id of selectedIds) {
    const path: string[] = []
    let cursorId: string | null = String(id)
    const visited = new Set<string>()

    while (cursorId != null && !visited.has(cursorId)) {
      visited.add(cursorId)
      path.push(cursorId)
      const parentId = messageById.get(cursorId)?.parent_id
      if (parentId == null) break

      const parentKey = String(parentId)
      if (visited.has(parentKey)) break
      if (selectedSet.has(parentKey)) {
        path.forEach(pathId => expandedSet.add(pathId))
        break
      }
      cursorId = parentKey
    }
  }

  if (visibleNodeIds) {
    const childrenByParent = new Map<string, string[]>()
    for (const message of messageById.values()) {
      if (message.parent_id == null) continue
      const parentId = String(message.parent_id)
      const children = childrenByParent.get(parentId) ?? []
      children.push(String(message.id))
      childrenByParent.set(parentId, children)
    }

    // Work upward from hidden leaves. A hidden row is a tail only when its entire
    // subtree is hidden; do not absorb prefixes leading to unselected visible turns.
    // Cycles never become eligible, and each row is processed at most once.
    const remainingChildren = new Map<string, number>()
    const hiddenTails = new Set<string>()
    const pending: string[] = []
    for (const id of messageById.keys()) {
      const count = childrenByParent.get(id)?.length ?? 0
      remainingChildren.set(id, count)
      if (count === 0 && !visibleNodeIds.has(id)) pending.push(id)
    }
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]
      hiddenTails.add(id)
      const parentId = messageById.get(id)?.parent_id
      if (parentId == null) continue
      const parentKey = String(parentId)
      const count = remainingChildren.get(parentKey)
      if (count == null) continue
      remainingChildren.set(parentKey, count - 1)
      if (count === 1 && !visibleNodeIds.has(parentKey)) pending.push(parentKey)
    }

    const selectedBranch = [...expandedSet]
    for (let index = 0; index < selectedBranch.length; index++) {
      for (const childId of childrenByParent.get(selectedBranch[index]) ?? []) {
        if (!hiddenTails.has(childId) || expandedSet.has(childId)) continue
        expandedSet.add(childId)
        selectedBranch.push(childId)
      }
    }
  }

  return messages.filter(message => expandedSet.has(String(message.id))).map(message => message.id)
}
