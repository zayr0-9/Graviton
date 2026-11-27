import type { ContentBlock, Message } from '../../features/chats/chatTypes'
import {
  buildToolCallGroupsFromBlocks,
  isExcludedFromProcessRunGrouping,
  normalizeAssistantDisplayBlocks,
} from './chatMessageShared'

type MessageRow = {
  kind: 'message'
  id: string
  message: Message
  /** A display subset only; message actions still use the original blocks. */
  displayBlocks?: ContentBlock[]
  showMessageExtras?: boolean
  hookRunsAttached?: boolean
  footerAnchor?: string
}

type ProcessFragment = {
  key: string
  message: Message
  blocks: ContentBlock[]
  ownsHooks: boolean
  showMessageExtras: boolean
}

type ProcessRow = {
  kind: 'process_group'
  id: string
  memberMessageIds: string[]
  fragments: ProcessFragment[]
  footerAnchor?: string
}

export type MessageRenderRow = MessageRow | ProcessRow

const isText = (block: ContentBlock) => block.type === 'text' && typeof block.content === 'string' && Boolean(block.content.trim())

/** Project visible blocks, not database row boundaries, into the virtual transcript. */
export function projectPersistedAgentRows(
  messages: readonly Message[],
  blocksFor: (message: Message) => ContentBlock[] | undefined,
  isBoundary: (message: Message) => boolean,
  hasFooter: (id: string) => boolean,
  hideReasoning: boolean,
): MessageRenderRow[] {
  const rows: MessageRenderRow[] = []
  let pending: ProcessFragment[] = []
  let groupId: string | undefined
  const flush = () => {
    if (!pending.length) return
    if (groupId) {
      rows.push({ kind: 'process_group', id: groupId, memberMessageIds: pending.map(part => part.message.id), fragments: pending })
    } else {
      // A context/hook-only continuation is still visible, but does not invent an empty history.
      for (const part of pending) rows.push({ kind: 'message', id: part.showMessageExtras ? part.message.id : part.key,
        message: part.message, displayBlocks: part.blocks, showMessageExtras: part.showMessageExtras,
        hookRunsAttached: !part.ownsHooks })
    }
    pending = []
    groupId = undefined
  }

  for (const message of messages) {
    const id = message.id
    if ((message.role !== 'assistant' && message.role !== 'ex_agent') || isBoundary(message)) {
      flush()
      rows.push({ kind: 'message', id, message, footerAnchor: id })
      continue
    }
    const sourceBlocks = blocksFor(message)
    const blocks = normalizeAssistantDisplayBlocks(sourceBlocks)
    const tools = buildToolCallGroupsFromBlocks(blocks)
    const processBlocks = new Set<ContentBlock>()
    const standaloneTools = new Set<ContentBlock>()
    const toolAnchors = new Map<string, ContentBlock>()
    const resultsByAnchor = new Map<ContentBlock, ContentBlock[]>()
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      if (block?.type !== 'tool_use' && block?.type !== 'tool_result') continue
      const tool = tools.get(index)
      if (tool) {
        if (block.type === 'tool_use') toolAnchors.set(tool.id, block)
        const classification = isExcludedFromProcessRunGrouping(tool.name, tool.args, tool.results) ? standaloneTools : processBlocks
        classification.add(block)
      } else if (block.type === 'tool_result') {
        const anchor = toolAnchors.get(block.tool_use_id)
        if (anchor) {
          const results = resultsByAnchor.get(anchor) ?? []
          results.push(block)
          resultsByAnchor.set(anchor, results)
        }
      }
    }

    type Segment = { key: string; blocks: ContentBlock[]; hasProcess: boolean; kind: 'process' | 'visible' }
    const segments: Segment[] = []
    let current: Segment | undefined
    const append = (kind: Segment['kind'], block: ContentBlock, index: number, hasProcess = false) => {
      if (current?.kind !== kind) {
        current = { key: `${id}:${index}`, kind, blocks: [], hasProcess: false }
        segments.push(current)
      }
      current.blocks.push(block, ...(resultsByAnchor.get(block) ?? []))
      current.hasProcess ||= hasProcess
    }
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      if (!block) continue
      if (isText(block) || block.type === 'error' || (block.type === 'image' && block.url) || standaloneTools.has(block)) {
        append('visible', block, index)
      } else if (processBlocks.has(block) || (block.type === 'thinking' && !hideReasoning && block.content.trim())) {
        append('process', block, index, true)
      } else if (block.type === 'context_injection') {
        append('process', block, index)
      }
    }

    if (!segments.length) {
      if ((!sourceBlocks?.length && message.content?.trim()) || (message.body_omitted && !message.hook_runs?.length)) {
        // Preserve legacy prose and the visible hydration placeholder.
        flush()
        rows.push({ kind: 'message', id, message, footerAnchor: id })
        continue
      }
      // Metadata, empty display blocks and context/hook-only continuations never start a
      // disclosure by themselves, but also don't split visible process work on either side.
      segments.push({ kind: 'process', key: id, blocks: [], hasProcess: false })
    }
    let lastProcess: Segment | undefined
    let lastVisible: Segment | undefined
    for (const segment of segments) {
      if (segment.kind === 'process') lastProcess = segment
      else lastVisible = segment
    }
    for (const segment of segments) {
      if (segment.kind === 'process') {
        // Use the message ID for its leading group even if more blocks arrive on this row.
        if (segment.hasProcess && !groupId) groupId = segment === segments[0] ? id : segment.key
        pending.push({ key: segment.key, message, blocks: segment.blocks, ownsHooks: segment === lastProcess,
          showMessageExtras: !lastVisible && segment === lastProcess })
      } else {
        flush()
        rows.push({ kind: 'message', id: segment === lastVisible ? id : segment.key, message,
          displayBlocks: segment.blocks, showMessageExtras: segment === lastVisible, hookRunsAttached: Boolean(lastProcess) })
      }
    }
    if (hasFooter(id)) {
      flush()
      // Emit a footer only after the last fragment of its original message.
      rows[rows.length - 1].footerAnchor = id
    }
  }
  flush()
  return rows
}
