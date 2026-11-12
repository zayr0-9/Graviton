import type { ContentBlock, HookRunRecord, StreamEvent } from '../../features/chats/chatTypes'
import { buildToolCallGroupsFromStream, isExcludedFromProcessRunGrouping, type ToolCallRenderGroup } from './chatMessageShared'

export const isProcessRunSeparatorText = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('#') || trimmed.startsWith('```')) return false
  return trimmed.split(/\s+/).filter(Boolean).length <= 12
}

export interface ActivityItem {
  key: string
  kind: 'process' | 'activity' | 'other'
  ignoreForProcessRunGrouping?: boolean
}

/** Attachments do not end a process run, but prose, errors and interactive output do. */
export function partitionAgentItems<T extends ActivityItem>(items: T[]): Array<{ key: string; history: T[]; activity: T[] } | T> {
  const groups: Array<{ key: string; history: T[]; activity: T[] } | T> = []
  let pending: T[] = []
  const flush = () => {
    // Attachments after prose must not make a short final answer look like an annotation.
    const lastProcess = pending.reduce((last, item, index) => item.kind === 'process' ? index : last, -1)
    const firstTrailingText = pending.findIndex((item, index) => index > lastProcess && item.kind === 'other')
    const trailing = firstTrailingText >= 0 ? pending.splice(firstTrailingText) : []
    if (pending.some(item => item.kind === 'process')) {
      groups.push({ key: pending[0].key, history: pending.filter(item => item.kind !== 'activity'), activity: pending.filter(item => item.kind === 'activity') })
    } else groups.push(...pending)
    groups.push(...trailing)
    pending = []
  }
  for (const item of items) {
    if (item.kind === 'process' || item.kind === 'activity' || item.ignoreForProcessRunGrouping) pending.push(item)
    else { flush(); groups.push(item) }
  }
  flush()
  return groups
}

/** Only the leading process segment may join the previous persisted group. Never move prose. */
export function splitLiveAgentEvents(events: StreamEvent[]): { process: StreamEvent[]; outside: StreamEvent[] } {
  let boundary = events.length
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'text') {
      let text = event.delta || ''
      let end = index + 1
      while (events[end]?.type === 'text') text += events[end++].delta || ''
      if (text.trim() && (!isProcessRunSeparatorText(text) || !events.slice(end).some(next => next.type === 'tool_call' || next.type === 'reasoning'))) { boundary = index; break }
      index = end - 1
    } else if (event.type === 'image' || event.type === 'error' || event.type === 'notice' ||
      (event.type === 'tool_call' && isExcludedFromProcessRunGrouping(event.toolCall?.name, event.toolCall?.arguments))) {
      boundary = index
      break
    }
  }
  // Results of an already attached call belong to its history, even if a later event is a boundary.
  const ids = new Set(events.slice(0, boundary).flatMap(event => event.toolCall ? [event.toolCall.id] : []))
  const process = events.filter((event, index) => index < boundary || (event.type === 'tool_result' && ids.has(event.toolResult?.tool_use_id || '')))
  const outside = events.filter((event, index) => index >= boundary && !(event.type === 'tool_result' && ids.has(event.toolResult?.tool_use_id || '')))
  return { process, outside }
}

export function getAgentProgress(blocks: ContentBlock[], events: StreamEvent[] = [], hooks: HookRunRecord[] = [], active = false) {
  const calls = new Map<string, string>()
  const settled = new Set<string>()
  const failed = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'tool_use') calls.set(block.id, block.name)
    if (block.type === 'tool_result') {
      settled.add(block.tool_use_id)
      if (block.is_error) failed.add(block.tool_use_id)
    }
  }
  for (const event of events) {
    if (event.type === 'tool_call' && event.toolCall) {
      calls.set(event.toolCall.id, event.toolCall.name)
      if (event.toolCall.status === 'complete') settled.add(event.toolCall.id)
    }
    if (event.type === 'tool_result' && event.toolResult) {
      settled.add(event.toolResult.tool_use_id)
      if (event.toolResult.is_error) failed.add(event.toolResult.tool_use_id)
    }
  }
  const completed = [...calls.keys()].filter(id => settled.has(id)).length
  const pending = [...calls].filter(([id]) => !settled.has(id))
  const activeHook = hooks.find(hook => hook.status === 'running' || hook.status === 'scheduled')
  const failedHook = hooks.some(hook => hook.status === 'failed' || hook.status === 'timed_out')
  const hasFailure = failed.size > 0 || failedHook
  const status = activeHook
    ? `${activeHook.event} · ${activeHook.label}`
    : active && pending.length ? `${pending[0][1]} · Awaiting result`
      : active ? 'Continuing agent work' : undefined
  return { toolCount: calls.size, completed, pending: pending.length, status, active: active || Boolean(activeHook), hasFailure }
}

/** A short trailing answer is still prose; only annotations before later work may fold. */
export function hasTrailingAgentProse(blocks: ContentBlock[]): boolean {
  const lastProcess = blocks.reduce((last, block, index) =>
    block.type === 'tool_use' || block.type === 'thinking' || block.type === 'reasoning_details' ? index : last, -1)
  return blocks.some((block, index) => block.type === 'text' && Boolean(block.content.trim()) && index > lastProcess)
}

/** Live ownership is branch/run scoped; retained buffers are gated separately by the caller. */
export function canAttachLiveAgentGroup(input: {
  enabled: boolean
  active: boolean
  compacting: boolean
  optimistic: boolean
  trailing?: { kind: string; memberMessageIds?: string[]; bridgedMessageId?: string }
  anchor: string | null
  boundaryAfter: boolean
}): boolean {
  return input.enabled && input.active && !input.compacting && !input.optimistic &&
    input.trailing?.kind === 'process_group' && !input.trailing.bridgedMessageId && !input.boundaryAfter &&
    input.anchor != null && Boolean(input.trailing.memberMessageIds?.some(id => String(id) === String(input.anchor)))
}

/** JSX-free live render descriptors: both layout ownership and ChatMessage consume these. */
export type StreamRenderItem = ActivityItem & (
  | { source: 'text'; text: string; index: number }
  | { source: 'reasoning'; text: string; index: number }
  | { source: 'tool'; group: ToolCallRenderGroup; renderKey: string }
  | { source: 'notice' | 'error' | 'image'; event: StreamEvent }
)

export function buildStreamRenderItems(events: StreamEvent[], keepTextOutsideGroups = false): StreamRenderItem[] {
  const items: StreamRenderItem[] = []
  const tools = buildToolCallGroupsFromStream(events)
  const hiddenSeparator = (index: number) => {
    const event = events[index]
    return event?.type === 'text' && (!(event.delta || '').trim() ||
      (events[index - 1]?.type === 'reasoning' && events[index + 1]?.type === 'reasoning' && isProcessRunSeparatorText(event.delta || '')))
  }
  for (let index = 0; index < events.length;) {
    const event = events[index]
    const group = tools.get(index)
    if (group) {
      if (group.anchorIndex === index) items.push({ key: `stream-tool-${group.id}-${index}`, source: 'tool', group,
        renderKey: `stream-${group.id}-${index}`, kind: isExcludedFromProcessRunGrouping(group.name, group.args) ? 'other' : 'process' })
      index++
      continue
    }
    if (event.type === 'text') {
      let end = index + 1
      let text = event.delta || ''
      while (events[end]?.type === 'text') text += events[end++].delta || ''
      if (text.trim()) items.push({ key: `text-${index}`, kind: 'other', source: 'text', text, index,
        ignoreForProcessRunGrouping: !keepTextOutsideGroups && isProcessRunSeparatorText(text) })
      index = end
      continue
    }
    if (event.type === 'reasoning' && event.delta) {
      let previous = index - 1
      while (previous >= 0 && hiddenSeparator(previous)) previous--
      if (events[previous]?.type === 'reasoning') { index++; continue }
      let text = event.delta
      let end = index + 1
      while (end < events.length) {
        if (events[end].type === 'reasoning' && events[end].delta) text += events[end++].delta
        else if (hiddenSeparator(end)) end++
        else break
      }
      items.push({ key: `reasoning-${index}`, kind: 'process', source: 'reasoning', text, index })
      index = end
      continue
    }
    if (event.type === 'notice' && event.content) items.push({ key: `stream-notice-${index}`, kind: 'other', source: 'notice', event })
    if (event.type === 'error' && event.errorEnvelope) items.push({ key: `stream-error-${index}`, kind: 'other', source: 'error', event })
    if (event.type === 'image' && event.url) items.push({ key: `image-${index}`, kind: 'other', source: 'image', event })
    index++
  }
  return items
}

/** A late result belongs at its tool's anchor; raw event order is not display order. */
export function trailingAgentGroupKey(items: ActivityItem[], grouped: boolean): string | null {
  if (!grouped) return null
  const parts = partitionAgentItems(items)
  const tail = parts[parts.length - 1]
  return tail && 'history' in tail ? tail.key : null
}

export type ActivityIndicatorOwner =
  | { kind: 'none' | 'input-tab' | 'live-tail' | 'virtual-footer' }
  | { kind: 'agent-steps'; groupKey: string }

export function resolveActivityIndicatorOwner(input: {
  visible: boolean
  placement: 'message' | 'input-tab'
  dedicatedStatus: boolean
  liveTail: boolean
  trailingGroupKey: string | null
}): ActivityIndicatorOwner {
  if (!input.visible) return { kind: 'none' }
  if (input.placement === 'input-tab') return { kind: 'input-tab' }
  if (!input.dedicatedStatus && input.trailingGroupKey) return { kind: 'agent-steps', groupKey: input.trailingGroupKey }
  return { kind: input.liveTail ? 'live-tail' : 'virtual-footer' }
}

/** Persisted groups can own only the trailing surface, not prose rendered after them. */
export function resolveTrailingStatusGroupKey(input: {
  items: ActivityItem[]
  grouped: boolean
  standalone: boolean
  streamingMessage: boolean
  attachedGroupId: string | null
}): string | null {
  const liveKey = input.standalone ? trailingAgentGroupKey(input.items, input.grouped) : null
  if (liveKey) return `live:${liveKey}`
  return input.attachedGroupId && (!input.streamingMessage || input.items.length === 0)
    ? `persisted:${input.attachedGroupId}` : null
}
