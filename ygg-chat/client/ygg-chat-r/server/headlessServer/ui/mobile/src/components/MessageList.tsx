import React, { useEffect, useRef } from 'react'
import type { MobileMessage } from '../types'
import { MessageBubble } from './MessageBubble'

interface MessageListProps {
  messages: MobileMessage[]
  streamingMessage?: MobileMessage | null
  branchTargetMessageId?: string | null
  scrollToMessageId?: string | null
  onScrollToMessageHandled?: () => void
  userActionsDisabled?: boolean
  currentUserId?: string | null
  rootPath?: string | null
  agentTextFontSizePx?: number
  onBranchUserMessage?: (message: MobileMessage) => void
  onDeleteUserMessage?: (message: MobileMessage) => void
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingMessage,
  branchTargetMessageId = null,
  scrollToMessageId = null,
  onScrollToMessageHandled,
  userActionsDisabled = false,
  currentUserId = null,
  rootPath = null,
  agentTextFontSizePx,
  onBranchUserMessage,
  onDeleteUserMessage,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  useEffect(() => {
    if (!containerRef.current) return
    if (scrollToMessageId) return
    if (streamingMessage) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [messages, streamingMessage, scrollToMessageId])

  useEffect(() => {
    if (!scrollToMessageId) return

    let rafId: number | null = null
    const scrollToTarget = () => {
      const target = messageRefs.current.get(String(scrollToMessageId))
      if (!target) return

      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
      onScrollToMessageHandled?.()
    }

    rafId = window.requestAnimationFrame(scrollToTarget)

    return () => {
      if (rafId != null) {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [scrollToMessageId, onScrollToMessageHandled, messages])

  return (
    <div ref={containerRef} className='mobile-message-list'>
      {messages.map(message => {
        const messageId = String(message.id)
        return (
          <div
            key={message.id}
            data-message-id={messageId}
            ref={node => {
              if (node) {
                messageRefs.current.set(messageId, node)
              } else {
                messageRefs.current.delete(messageId)
              }
            }}
          >
            <MessageBubble
              message={message}
              showUserActions
              userActionsDisabled={userActionsDisabled}
              isBranchTarget={
                branchTargetMessageId !== null && String(branchTargetMessageId) === String(message.id)
              }
              currentUserId={currentUserId}
              rootPath={rootPath}
              agentTextFontSizePx={agentTextFontSizePx}
              onBranchUserMessage={onBranchUserMessage}
              onDeleteUserMessage={onDeleteUserMessage}
            />
          </div>
        )
      })}

      {streamingMessage ? (
        <MessageBubble
          message={streamingMessage}
          isStreaming
          currentUserId={currentUserId}
          rootPath={rootPath}
          agentTextFontSizePx={agentTextFontSizePx}
        />
      ) : null}
    </div>
  )
}
