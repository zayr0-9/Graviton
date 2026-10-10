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

/** Include connecting rows, but not ancestors before the selection or other branches. */
export function expandHeimdallSelectionToBranchMessages(
  messages: Message[],
  selectedIds: Message['id'][]
): Message['id'][] {
  if (selectedIds.length <= 1 || messages.length === 0) return selectedIds

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

  return messages.filter(message => expandedSet.has(String(message.id))).map(message => message.id)
}
