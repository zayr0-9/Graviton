import { useCallback, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ConversationId, MessageId } from '../../../../../shared/types'
import type { LineageId } from '../../features/chats/chatTypes'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import { Button } from '../Button/button'
import { abortGeneration, selectCurrentViewStreamFor, selectDisplayMessagesFor, sendMessage } from '../../features/chats'
import { generateStreamId } from '../../features/chats/streamHelpers'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'

export interface ParallelChatPaneTarget {
  conversationId: ConversationId
  messageId: MessageId
  path: MessageId[]
  lineageId?: LineageId | null
}

interface ParallelChatPaneProps {
  target: ParallelChatPaneTarget
  onClose: () => void
  onActivate?: () => void
  active?: boolean
}

/**
 * A lightweight second transcript for the same conversation. Conversation data remains shared;
 * only branch identity, draft text and the pending stream are pane-local.
 */
export function ParallelChatPane({ target, onClose, onActivate, active = false }: ParallelChatPaneProps) {
  const dispatch = useAppDispatch()
  const messages = useAppSelector(state => state.chat.conversation.messages)
  const streaming = useAppSelector(state => state.chat.streaming)
  const operationMode = useAppSelector(state => state.chat.operationMode)
  const displayMessages = useMemo(() => selectDisplayMessagesFor(messages, target.path), [messages, target.path])
  const stream = useMemo(
    () => selectCurrentViewStreamFor(streaming, {
      conversationId: String(target.conversationId),
      lineageId: target.lineageId == null ? null : String(target.lineageId),
      path: target.path,
    }),
    [streaming, target]
  )
  const [draft, setDraft] = useState('')
  const [pendingStreamId, setPendingStreamId] = useState<string | null>(null)
  const effectiveStream = stream ?? (pendingStreamId ? streaming.byId[pendingStreamId] ? { id: pendingStreamId, ...streaming.byId[pendingStreamId] } : null : null)
  const canSend = draft.trim().length > 0 && !effectiveStream?.active

  const handleSend = useCallback(() => {
    const content = draft.trim()
    if (!content || effectiveStream?.active) return

    const streamId = generateStreamId('branch')
    const parent = target.path[target.path.length - 1] ?? target.messageId
    setPendingStreamId(streamId)
    setDraft('')
    void dispatch(sendMessage({
      conversationId: target.conversationId,
      input: { content },
      parent,
      repeatNum: 1,
      think: false,
      operationMode,
      streamId,
      lineageId: target.lineageId ?? null,
      branchPath: target.path,
    }))
      .unwrap()
      .finally(() => setPendingStreamId(null))
  }, [dispatch, draft, effectiveStream?.active, operationMode, target])

  return (
    <section
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden border-l border-stone-200/70 bg-transparent dark:border-neutral-700/70 ${active ? 'ring-1 ring-inset ring-sky-400/50' : ''}`}
      aria-label='Parallel conversation branch'
      onMouseDown={onActivate}
    >
      <header className='flex shrink-0 items-center gap-2 border-b border-stone-200/70 px-3 py-2 text-xs dark:border-neutral-700/70'>
        <span className='min-w-0 flex-1 truncate font-medium text-stone-600 dark:text-neutral-300'>Parallel branch</span>
        <Button variant='outline2' size='small' className='!rounded-full !p-1.5' onClick={onClose} aria-label='Close parallel branch' title='Close parallel branch'>
          <X className='h-3.5 w-3.5' />
        </Button>
      </header>

      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-4 thin-scrollbar'>
        {displayMessages.map(message => (
          <ChatMessage
            key={`parallel-${message.id}`}
            id={`parallel-${message.id}`}
            role={message.role}
            content={message.content}
            thinking={message.thinking_block}
            contentBlocks={message.content_blocks}
            timestamp={message.created_at}
            modelName={message.model_name}
            artifacts={message.artifacts}
            width='w-full'
          />
        ))}
        {effectiveStream?.active && (
          <ChatMessage
            id={`parallel-streaming-${effectiveStream.id}`}
            role='assistant'
            content={effectiveStream.buffer}
            thinking={effectiveStream.thinkingBuffer}
            toolCalls={effectiveStream.toolCalls}
            streamEvents={effectiveStream.events}
            width='w-full'
          />
        )}
      </div>

      <div className='shrink-0 border-t border-stone-200/70 p-3 dark:border-neutral-700/70'>
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              handleSend()
            }
          }}
          placeholder='Continue this branch…'
          className='min-h-20 w-full resize-y rounded-lg border border-stone-300 bg-white/70 p-2 text-sm outline-none focus:border-sky-400 dark:border-neutral-700 dark:bg-neutral-900/70'
        />
        <div className='mt-2 flex justify-end gap-2'>
          {effectiveStream?.active && (
            <Button variant='outline2' size='small' onClick={() => dispatch(abortGeneration({ streamId: effectiveStream.id }))}>Stop</Button>
          )}
          <Button variant='primary' size='small' disabled={!canSend} onClick={handleSend}>Send</Button>
        </div>
      </div>
    </section>
  )
}
