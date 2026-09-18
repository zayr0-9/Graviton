import type { Message } from './chatTypes'

export interface MessageTransferItem {
  source_id: string
  parent_source_id: string | null
  role: Message['role']
  content: string
  thinking_block?: string
  model_name?: string
  tool_calls?: string | any
  tool_call_id?: string | null
  note?: string
  note_color?: string | null
  ex_agent_session_id?: string | null
  ex_agent_type?: string | null
  content_blocks?: any
  meta?: string | Record<string, unknown> | null
}

const normalizeChildIds = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || !value.trim()) return []

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Builds a topologically ordered clone payload for the selected message forest.
 * Parent/child relationships are retained only when both rows are selected. Sibling
 * order follows the source parent's ordered children_ids, with stable snapshot order
 * as a fallback for cloud/legacy rows that do not carry that denormalized list.
 */
export function buildMessageTransferPayload(
  messages: Message[],
  selectedIds: Array<Message['id']>
): MessageTransferItem[] {
  if (messages.length === 0 || selectedIds.length === 0) return []

  const selectedSet = new Set(selectedIds.map(String))
  const messageById = new Map<string, Message>()
  const snapshotIndex = new Map<string, number>()

  messages.forEach((message, index) => {
    const id = String(message.id)
    messageById.set(id, message)
    snapshotIndex.set(id, index)
  })

  const compareFallbackOrder = (left: Message, right: Message): number => {
    const leftTime = Date.parse(left.created_at || '')
    const rightTime = Date.parse(right.created_at || '')
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }

    const indexDifference = (snapshotIndex.get(String(left.id)) ?? 0) - (snapshotIndex.get(String(right.id)) ?? 0)
    return indexDifference || String(left.id).localeCompare(String(right.id))
  }

  const childrenByParent = new Map<string, Message[]>()
  for (const message of messageById.values()) {
    if (message.parent_id == null) continue
    const parentId = String(message.parent_id)
    const siblings = childrenByParent.get(parentId) ?? []
    siblings.push(message)
    childrenByParent.set(parentId, siblings)
  }

  for (const [parentId, children] of childrenByParent) {
    const sourceChildren = normalizeChildIds(messageById.get(parentId)?.children_ids)
    const sourceRank = new Map(sourceChildren.map((id, index) => [id, index]))
    children.sort((left, right) => {
      const leftRank = sourceRank.get(String(left.id))
      const rightRank = sourceRank.get(String(right.id))
      if (leftRank != null && rightRank != null) return leftRank - rightRank
      if (leftRank != null) return -1
      if (rightRank != null) return 1
      return compareFallbackOrder(left, right)
    })
  }

  // Rank every source row by a deterministic pre-order walk so selected siblings keep
  // their original relative position even when their common parent is not selected.
  const sourceOrder = new Map<string, number>()
  const sourceVisited = new Set<string>()
  const visitSourceTree = (message: Message): void => {
    const id = String(message.id)
    if (sourceVisited.has(id)) return
    sourceVisited.add(id)
    sourceOrder.set(id, sourceOrder.size)
    for (const child of childrenByParent.get(id) ?? []) visitSourceTree(child)
  }
  const sourceRoots = [...messageById.values()]
    .filter(message => message.parent_id == null || !messageById.has(String(message.parent_id)))
    .sort(compareFallbackOrder)
  sourceRoots.forEach(visitSourceTree)
  ;[...messageById.values()].sort(compareFallbackOrder).forEach(visitSourceTree)

  const compareSourceOrder = (left: Message, right: Message): number =>
    (sourceOrder.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER) || compareFallbackOrder(left, right)

  const orderedMessages: Message[] = []
  const visited = new Set<string>()
  const visitSelectedSubtree = (message: Message): void => {
    const id = String(message.id)
    if (visited.has(id) || !selectedSet.has(id)) return

    visited.add(id)
    orderedMessages.push(message)
    for (const child of childrenByParent.get(id) ?? []) visitSelectedSubtree(child)
  }

  const selectedRoots = [...messageById.values()]
    .filter(message => {
      const id = String(message.id)
      if (!selectedSet.has(id)) return false
      return message.parent_id == null || !selectedSet.has(String(message.parent_id))
    })
    .sort(compareSourceOrder)

  selectedRoots.forEach(visitSelectedSubtree)

  // Keep malformed/cyclic selected rows transferable without flattening valid rows.
  const remainingMessages = [...messageById.values()].sort(compareSourceOrder)
  remainingMessages.forEach(visitSelectedSubtree)
  const transferRank = new Map(orderedMessages.map((message, index) => [String(message.id), index]))

  return orderedMessages.map(message => {
    const id = String(message.id)
    const parent = message.parent_id == null ? null : String(message.parent_id)
    const parentPrecedesChild =
      parent != null &&
      selectedSet.has(parent) &&
      (transferRank.get(parent) ?? Number.MAX_SAFE_INTEGER) < (transferRank.get(id) ?? -1)

    return {
      source_id: id,
      parent_source_id: parentPrecedesChild ? parent : null,
      role: message.role,
      content: message.content,
      thinking_block: message.thinking_block || '',
      model_name: message.model_name || 'unknown',
      tool_calls: message.tool_calls || undefined,
      tool_call_id: message.tool_call_id || null,
      note: message.note || undefined,
      note_color: message.note_color || null,
      ex_agent_session_id: message.ex_agent_session_id || null,
      ex_agent_type: message.ex_agent_type || null,
      content_blocks: message.content_blocks || undefined,
      meta: message.meta ?? null,
    }
  })
}

/** Moving a selected ancestor would cascade-delete any unselected descendants. */
export function hasUnselectedDescendants(messages: Message[], selectedIds: Array<Message['id']>): boolean {
  const selectedSet = new Set(selectedIds.map(String))
  if (selectedSet.size === 0) return false

  let cursorChanged = true
  const descendantsOfSelection = new Set(selectedSet)
  while (cursorChanged) {
    cursorChanged = false
    for (const message of messages) {
      const id = String(message.id)
      if (descendantsOfSelection.has(id) || message.parent_id == null) continue
      if (descendantsOfSelection.has(String(message.parent_id))) {
        descendantsOfSelection.add(id)
        cursorChanged = true
      }
    }
  }

  return [...descendantsOfSelection].some(id => !selectedSet.has(id))
}
