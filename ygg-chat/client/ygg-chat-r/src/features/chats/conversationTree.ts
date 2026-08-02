import type { Message, ChatNode } from './chatTypes'

const messageId = (message: Pick<Message, 'id'>): string => String(message.id)
const parentId = (message: Pick<Message, 'parent_id'>): string | null =>
  message.parent_id == null || String(message.parent_id) === '' ? null : String(message.parent_id)

const compareMessages = (a: Message, b: Message): number => {
  const timeA = Date.parse(a.created_at || '')
  const timeB = Date.parse(b.created_at || '')
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB
  return messageId(a).localeCompare(messageId(b))
}

const toNode = (message: Message, children: ChatNode[]): ChatNode => ({
  id: messageId(message),
  message: message.content,
  sender: message.role === 'user' ? 'user' : message.role === 'ex_agent' ? 'ex_agent' : 'assistant',
  children,
})

/**
 * Builds one deterministic Heimdall tree from a flat conversation snapshot.
 * Duplicate IDs keep their last row. Missing-parent rows and cycles are promoted to
 * top-level roots so malformed data cannot hide otherwise valid messages.
 */
export function buildConversationTree(messages: Message[]): ChatNode | null {
  if (!messages.length) return null

  const byId = new Map<string, Message>()
  for (const message of messages) byId.set(messageId(message), message)

  const childrenByParent = new Map<string, Message[]>()
  const rootIds = new Set<string>()

  for (const message of byId.values()) {
    const id = messageId(message)
    const parent = parentId(message)
    if (!parent || parent === id || !byId.has(parent)) {
      rootIds.add(id)
      continue
    }
    const children = childrenByParent.get(parent) ?? []
    children.push(message)
    childrenByParent.set(parent, children)
  }

  for (const children of childrenByParent.values()) children.sort(compareMessages)

  const visited = new Set<string>()
  const buildNode = (message: Message, ancestors: Set<string>): ChatNode => {
    const id = messageId(message)
    visited.add(id)
    const nextAncestors = new Set(ancestors).add(id)
    const children = (childrenByParent.get(id) ?? [])
      .filter(child => !nextAncestors.has(messageId(child)))
      .map(child => buildNode(child, nextAncestors))
    return toNode(message, children)
  }

  const roots = [...rootIds]
    .map(id => byId.get(id)!)
    .sort(compareMessages)
    .map(message => buildNode(message, new Set()))

  // Pure cycles have no natural root. Promote each still-unvisited component once.
  for (const message of [...byId.values()].sort(compareMessages)) {
    if (!visited.has(messageId(message))) roots.push(buildNode(message, new Set()))
  }

  if (roots.length === 1) return roots[0]
  return { id: 'root', message: 'Conversation', sender: 'assistant', children: roots }
}

export function buildPathToConversationMessage(messages: Message[], targetId: string): string[] {
  const byId = new Map(messages.map(message => [messageId(message), message]))
  if (!byId.has(String(targetId))) return []

  const reversed: string[] = []
  const seen = new Set<string>()
  let current: string | null = String(targetId)
  while (current && !seen.has(current)) {
    const message = byId.get(current)
    if (!message) return []
    reversed.push(current)
    seen.add(current)
    current = parentId(message)
  }
  if (current) return []
  return reversed.reverse()
}
