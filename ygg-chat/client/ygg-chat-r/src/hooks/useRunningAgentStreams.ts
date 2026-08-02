import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, StreamEvent, StreamLifecycleStatus, StreamState } from '../features/chats/chatTypes'
import type { Conversation } from '../features/conversations/conversationTypes'
import { useAppSelector } from './redux'
import type { ResearchNoteItem } from './useQueries'

export type AgentStreamActivityKind = StreamEvent['type'] | 'idle'

export type AgentStreamListItem = {
  streamId: string
  streamType: string
  lineageId: string | null
  conversationId: string | null
  projectId: string | null
  conversationTitle: string | null
  anchorMessageId: string | null
  hasError: boolean
  createdAt: string
  status: StreamLifecycleStatus
  triggerUserMessageId: string | null
  currentBranchAnchorMessageId: string | null
  branchAnchorMessageId: string | null
  liveMessageId: string | null
  streamingMessageId: string | null
  lastCompletedMessageId: string | null
  finalMessageId: string | null
  messageId: string | null
  originMessageId: string | null
  rootMessageId: string | null
  parentMessageId: string | null
  parentMessageText: string | null
  activityKind: AgentStreamActivityKind
  activityLabel: string
  completedAt: string | null
  displayName: string
}

export const summarizeAgentStreamId = (value: string | null | undefined): string => {
  if (!value) return '—'
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

export const getAgentActivityBadgeClasses = (kind: AgentStreamActivityKind): string => {
  const baseClasses = 'rounded-full px-2 py-0.5 font-medium'
  if (kind === 'tool_call' || kind === 'tool_result') {
    return `${baseClasses} bg-violet-100/80 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200`
  }
  if (kind === 'reasoning') {
    return `${baseClasses} bg-sky-100/80 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200`
  }
  if (kind === 'text') {
    return `${baseClasses} bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200`
  }
  if (kind === 'image') {
    return `${baseClasses} bg-fuchsia-100/80 dark:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-200`
  }
  return `${baseClasses} bg-neutral-100 dark:bg-neutral-800/70 text-neutral-600 dark:text-neutral-300`
}

const getStreamActivity = (stream: StreamState): { activityKind: AgentStreamActivityKind; activityLabel: string } => {
  if (Array.isArray(stream.events) && stream.events.length > 0) {
    for (let index = stream.events.length - 1; index >= 0; index -= 1) {
      const event = stream.events[index]
      if (!event) continue

      if (event.type === 'tool_call') {
        const toolName = event.toolCall?.name || stream.toolCalls[stream.toolCalls.length - 1]?.name || 'tool'
        return {
          activityKind: 'tool_call',
          activityLabel: `tool: ${toolName}`,
        }
      }

      if (event.type === 'tool_result') {
        const matchingTool = stream.toolCalls.find(toolCall => toolCall.id === event.toolResult?.tool_use_id)
        return {
          activityKind: 'tool_result',
          activityLabel: matchingTool?.name ? `result: ${matchingTool.name}` : 'tool result',
        }
      }

      if (event.type === 'reasoning') return { activityKind: 'reasoning', activityLabel: 'reasoning' }
      if (event.type === 'text') return { activityKind: 'text', activityLabel: 'text' }
      if (event.type === 'image') return { activityKind: 'image', activityLabel: 'image' }
    }
  }

  if (stream.toolCalls.length > 0) {
    const latestTool = stream.toolCalls[stream.toolCalls.length - 1]
    return {
      activityKind: 'tool_call',
      activityLabel: `tool: ${latestTool?.name || 'tool'}`,
    }
  }

  if (stream.thinkingBuffer.trim().length > 0) return { activityKind: 'reasoning', activityLabel: 'reasoning' }
  if (stream.buffer.trim().length > 0) return { activityKind: 'text', activityLabel: 'text' }

  return { activityKind: 'idle', activityLabel: 'starting' }
}

const normalizeMessagePreview = (message: Message | null | undefined): string | null => {
  if (!message) return null
  const rawContent =
    message.content_plain_text ||
    (message as any).plain_text_content ||
    message.content ||
    (Array.isArray(message.content_blocks)
      ? message.content_blocks
          .map(block => ('content' in block && typeof block.content === 'string' ? block.content : ''))
          .filter(Boolean)
          .join(' ')
      : '')
  const preview = String(rawContent || '')
    .replace(/\s+/g, ' ')
    .trim()
  return preview.length > 0 ? preview : null
}

const resolveParentMessage = (messagesById: Map<string, Message>, stream: StreamState): Message | null => {
  const explicitTriggerMessage = stream.triggerUserMessageId
    ? messagesById.get(String(stream.triggerUserMessageId))
    : null
  if (explicitTriggerMessage?.role === 'user') return explicitTriggerMessage

  const candidateIds = [
    stream.triggerUserMessageId,
    stream.lineage.originMessageId,
    stream.currentBranchAnchorMessageId,
    stream.branchAnchorMessageId,
    stream.liveMessageId,
    stream.streamingMessageId,
    stream.lastCompletedMessageId,
    stream.finalMessageId,
    stream.messageId,
    stream.lineage.rootMessageId,
  ]

  const visitedIds = new Set<string>()

  for (const candidateId of candidateIds) {
    if (!candidateId) continue
    let current: Message | null | undefined = messagesById.get(String(candidateId))

    while (current) {
      const currentId = String(current.id)
      if (visitedIds.has(currentId)) break
      visitedIds.add(currentId)

      if (current.role === 'user') return current
      current = current.parent_id ? messagesById.get(String(current.parent_id)) : null
    }
  }

  return null
}

export function useRunningAgentStreams(notes: ResearchNoteItem[] = []) {
  const conversations = useAppSelector(state => state.conversations.items)
  const streamingRoot = useAppSelector(state => state.chat.streaming)
  const messages = useAppSelector(state => state.chat.conversation.messages)
  const [streamHistory, setStreamHistory] = useState<AgentStreamListItem[]>([])
  const previousActiveStreamIdsRef = useRef<Set<string>>(new Set())

  const notesByConversationId = useMemo(() => {
    const map = new Map<string, ResearchNoteItem>()
    for (const note of notes) {
      map.set(String(note.id), note)
    }
    return map
  }, [notes])

  const conversationsById = useMemo(() => {
    const map = new Map<string, Conversation>()
    for (const item of conversations) {
      map.set(String(item.id), item)
    }
    return map
  }, [conversations])

  const messagesById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const message of messages) {
      map.set(String(message.id), message)
    }
    return map
  }, [messages])

  const buildAgentStreamListItem = useCallback(
    (streamId: string, stream: StreamState, completedAt: string | null = null, displayIndex = 0): AgentStreamListItem => {
      const streamConversationId = stream.conversationId ? String(stream.conversationId) : null
      const convo = streamConversationId ? conversationsById.get(streamConversationId) : null
      const note = streamConversationId ? notesByConversationId.get(streamConversationId) : null
      const anchorMessageId =
        stream.liveMessageId ||
        stream.streamingMessageId ||
        stream.currentBranchAnchorMessageId ||
        stream.lastCompletedMessageId ||
        stream.finalMessageId ||
        stream.messageId ||
        stream.triggerUserMessageId ||
        stream.lineage.originMessageId ||
        stream.lineage.rootMessageId ||
        null
      const { activityKind, activityLabel } = getStreamActivity(stream)
      const parentMessage = resolveParentMessage(messagesById, stream)
      const parentMessageText = normalizeMessagePreview(parentMessage)

      return {
        streamId,
        streamType: stream.streamType,
        lineageId: stream.lineage.lineageId ? String(stream.lineage.lineageId) : null,
        conversationId: streamConversationId,
        projectId: convo?.project_id ? String(convo.project_id) : note?.project_id ? String(note.project_id) : null,
        conversationTitle: convo?.title || note?.title || (streamConversationId ? `Conversation ${streamConversationId}` : null),
        anchorMessageId: anchorMessageId ? String(anchorMessageId) : null,
        hasError: Boolean(stream.error),
        createdAt: stream.createdAt,
        status: stream.status,
        triggerUserMessageId: stream.triggerUserMessageId ? String(stream.triggerUserMessageId) : null,
        currentBranchAnchorMessageId: stream.currentBranchAnchorMessageId ? String(stream.currentBranchAnchorMessageId) : null,
        branchAnchorMessageId: stream.branchAnchorMessageId ? String(stream.branchAnchorMessageId) : null,
        liveMessageId: stream.liveMessageId ? String(stream.liveMessageId) : null,
        streamingMessageId: stream.streamingMessageId ? String(stream.streamingMessageId) : null,
        lastCompletedMessageId: stream.lastCompletedMessageId ? String(stream.lastCompletedMessageId) : null,
        finalMessageId: stream.finalMessageId ? String(stream.finalMessageId) : null,
        messageId: stream.messageId ? String(stream.messageId) : null,
        originMessageId: stream.lineage.originMessageId ? String(stream.lineage.originMessageId) : null,
        rootMessageId: stream.lineage.rootMessageId ? String(stream.lineage.rootMessageId) : null,
        parentMessageId: parentMessage?.id ? String(parentMessage.id) : null,
        parentMessageText,
        activityKind,
        activityLabel,
        completedAt,
        displayName: `agent-${displayIndex + 1}`,
      }
    },
    [conversationsById, messagesById, notesByConversationId]
  )

  const activeStreams = useMemo(() => {
    const streams: Array<{ streamId: string; stream: StreamState }> = []

    for (const streamId of streamingRoot.activeIds) {
      const stream = streamingRoot.byId[streamId]
      if (!stream || !stream.active) continue
      streams.push({ streamId, stream })
    }

    return streams
      .sort((a, b) => b.stream.createdAt.localeCompare(a.stream.createdAt))
      .map((entry, index) => buildAgentStreamListItem(entry.streamId, entry.stream, null, index))
  }, [buildAgentStreamListItem, streamingRoot.activeIds, streamingRoot.byId])

  useEffect(() => {
    const currentActiveIds = new Set<string>()

    for (const streamId of streamingRoot.activeIds) {
      const stream = streamingRoot.byId[streamId]
      if (stream?.active) {
        currentActiveIds.add(streamId)
      }
    }

    const completedItems: AgentStreamListItem[] = []

    previousActiveStreamIdsRef.current.forEach(streamId => {
      if (currentActiveIds.has(streamId)) return
      const stream = streamingRoot.byId[streamId]
      if (!stream) return
      completedItems.push(buildAgentStreamListItem(streamId, stream, new Date().toISOString(), completedItems.length))
    })

    if (completedItems.length > 0) {
      setStreamHistory(previous => {
        const incomingById = new Map(completedItems.map(item => [item.streamId, item]))
        const merged = [...previous.filter(item => !incomingById.has(item.streamId)), ...completedItems]
        return merged
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 40)
          .map((item, index) => ({ ...item, displayName: `agent-${index + 1}` }))
      })
    }

    previousActiveStreamIdsRef.current = currentActiveIds
  }, [buildAgentStreamListItem, streamingRoot.activeIds, streamingRoot.byId])

  return {
    activeStreams,
    streamHistory,
    buildAgentStreamListItem,
    streamingRoot,
  }
}
