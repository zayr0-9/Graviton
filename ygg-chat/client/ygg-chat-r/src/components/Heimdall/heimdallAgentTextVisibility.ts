import type { ChatNode, Message } from '../../features/chats/chatTypes'
import { messageRunAttribution } from '../../features/chats/runStatistics'
import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { isHeimdallScaffoldingMessage } from './heimdallNodeVisibility'
import { walkChatTree } from './heimdallTreeTraversal'

const readArray = (value: unknown): Record<string, unknown>[] => {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
}

/** Persisted rows may carry prose only in parsed or SQLite-encoded blocks. */
export function hasHeimdallTextContent(
  message: Pick<Message, 'content' | 'content_blocks' | 'meta'>,
  blocks = readArray(message.content_blocks)
): boolean {
  if (message.content?.trim()) return true
  // Claude's adapter excludes non-text SDK blocks from row.content, but writes
  // [Claude <type>] text placeholders into blocks. They are not emitted prose.
  const claudePlaceholder = Boolean(parseMessageMeta(message.meta)?.claude)
  return blocks.some(block => {
    const text = block.content ?? block.text
    return block.type === 'text' && typeof text === 'string' && Boolean(text.trim()) &&
      !(claudePlaceholder && /^\[Claude [a-z_]+\]$/.test(text))
  })
}

interface Continuation {
  run: string
  text: boolean
  process: boolean
}

/**
 * Hide commentary only when every continuation has later text and agent work in
 * the same persisted run. Missing ownership, user turns and terminal output are
 * boundaries. No canonical messages, content blocks or branch paths are changed.
 */
export function getIntermediateAgentTextIds(root: ChatNode, messages: ReadonlyMap<string, Message>): Set<string> {
  const hidden = new Set<string>()
  const continuations = new Map<ChatNode, Continuation>()
  const nodes = Array.from(walkChatTree(root))
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]
    const message = messages.get(String(node.id))
    const children = node.children.map(child => continuations.get(child))
    // A branch is safe to collapse only if all its paths continue this same run.
    const next = children.length && children.every(child => child && child.run === children[0]?.run)
      ? { run: children[0]!.run, text: children.every(child => child!.text), process: children.every(child => child!.process) }
      : undefined
    if (message && isHeimdallScaffoldingMessage(message)) {
      if (next) continuations.set(node, next)
      continue
    }
    if (!message || (message.role !== 'assistant' && message.role !== 'ex_agent' && message.role !== 'tool')) continue
    const attribution = messageRunAttribution(message)
    const blocks = readArray(message.content_blocks)
    // Errors, images and attachments must remain independently inspectable.
    if (attribution?.kind === 'terminal_error' || blocks.some(block => block.type === 'error' || block.type === 'image') ||
      message.has_attachments || message.attachments?.length) continue
    if (!attribution?.streamId) continue
    const run = JSON.stringify([String(message.conversation_id), attribution.streamId])
    const following = next?.run === run ? next : undefined
    const text = message.role !== 'tool' && hasHeimdallTextContent(message, blocks)
    const process = message.role === 'tool' || Boolean(message.thinking_block?.trim()) ||
      readArray(message.tool_calls).length > 0 || blocks.some(block =>
        block.type === 'thinking' || block.type === 'reasoning_details' || block.type === 'tool_use' || block.type === 'tool_result')
    if (text && following?.text && (process || following.process)) hidden.add(String(node.id))
    continuations.set(node, {
      run,
      text: text || Boolean(following?.text),
      process: process || Boolean(following?.process),
    })
  }
  return hidden
}
