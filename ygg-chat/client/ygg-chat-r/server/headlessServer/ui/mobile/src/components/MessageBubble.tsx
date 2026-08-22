import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Badge, Button } from './ui'
import remarkGfm from 'remark-gfm'
import type { MobileMessage } from '../types'
import { buildRenderItemsForMessage } from '../messageParser'
import { ReasoningCard } from './ReasoningCard'
import { ToolCallCard } from './ToolCallCard'

interface MessageBubbleProps {
  message: MobileMessage
  isStreaming?: boolean
  showUserActions?: boolean
  userActionsDisabled?: boolean
  isBranchTarget?: boolean
  currentUserId?: string | null
  rootPath?: string | null
  agentTextFontSizePx?: number
  onBranchUserMessage?: (message: MobileMessage) => void
  onDeleteUserMessage?: (message: MobileMessage) => void
}

const roleLabel = (role: string): string => {
  if (role === 'assistant') return 'Assistant'
  if (role === 'user') return 'You'
  if (role === 'tool') return 'Tool'
  return 'System'
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming = false,
  showUserActions = false,
  userActionsDisabled = false,
  isBranchTarget = false,
  currentUserId = null,
  rootPath = null,
  agentTextFontSizePx,
  onBranchUserMessage,
  onDeleteUserMessage,
}) => {
  const renderItems = useMemo(() => buildRenderItemsForMessage(message), [message])
  const textStyle =
    message.role === 'assistant' && typeof agentTextFontSizePx === 'number'
      ? ({ '--mobile-agent-text-font-size': `${agentTextFontSizePx}px` } as React.CSSProperties)
      : undefined

  return (
    <article className={`mobile-message ${message.role}${isBranchTarget ? ' branch-target' : ''}`}>
      <header className='mobile-message-header'>
        <span className='mobile-message-role'>{roleLabel(message.role)}</span>
        {isStreaming ? <Badge className='mobile-streaming-badge'>streaming</Badge> : null}
      </header>

      <div className='mobile-message-body'>
        {renderItems.length === 0 ? <div className='mobile-empty-text'>(no content)</div> : null}

        {renderItems.map(item => {
          if (item.type === 'text') {
            return (
              <div key={item.key} className='mobile-message-text markdown-body' style={textStyle}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
              </div>
            )
          }

          if (item.type === 'reasoning') {
            return <ReasoningCard key={item.key} text={item.text} />
          }

          return (
            <ToolCallCard
              key={item.key}
              group={item.group}
              defaultExpanded={false}
              currentUserId={currentUserId}
              rootPath={rootPath}
            />
          )
        })}
      </div>

      {showUserActions && message.role === 'user' && !isStreaming ? (
        <footer className='mobile-message-actions'>
          <Button onClick={() => onBranchUserMessage?.(message)} disabled={userActionsDisabled} variant='outline' size='sm'>
            Branch
          </Button>
          <Button
            onClick={() => onDeleteUserMessage?.(message)}
            disabled={userActionsDisabled}
            variant='destructive'
            size='sm'
          >
            Delete
          </Button>
        </footer>
      ) : null}
    </article>
  )
}
