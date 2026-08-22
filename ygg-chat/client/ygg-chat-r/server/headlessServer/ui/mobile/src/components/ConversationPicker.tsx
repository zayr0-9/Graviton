import React from 'react'
import type { MobileConversation } from '../types'

interface ConversationPickerProps {
  conversations: MobileConversation[]
  activeConversationId: string | null
  onSelect: (conversationId: string) => void
  onCreate: () => void
  disabled?: boolean
}

export const ConversationPicker: React.FC<ConversationPickerProps> = ({
  conversations,
  activeConversationId,
  onSelect,
  onCreate,
  disabled = false,
}) => {
  return (
    <div className='mobile-conversation-picker'>
      <select
        value={activeConversationId || ''}
        onChange={event => onSelect(event.target.value)}
        disabled={disabled || conversations.length === 0}
      >
        {conversations.length === 0 ? <option value=''>No conversations</option> : null}
        {conversations.map(conversation => (
          <option key={conversation.id} value={conversation.id}>
            {conversation.title || 'Untitled'}
          </option>
        ))}
      </select>

      <button type='button' onClick={onCreate} disabled={disabled}>
        New
      </button>
    </div>
  )
}
