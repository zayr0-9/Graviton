import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationId } from '../../../../../shared/types'
import type { ImageDraftTarget } from '../../features/chats/chatTypes'
import { InputTextArea } from '../InputTextArea/InputTextArea'

export type ChatInputUpdater = string | ((prev: string) => string)

export type ChatInputControllerHandle = {
  getValue: () => string
  setValue: (next: ChatInputUpdater) => void
  clear: () => void
  focus: () => void
}

export type ComposerSlashCommandResult = {
  handled: boolean
  clearInput?: boolean
}

export type ChatInputControllerProps = {
  conversationId: ConversationId | null
  initialValue: string
  slashCommands?: string[]
  onSlashCommandSelect?: (command: string) => ComposerSlashCommandResult | void
  onHasTextChange: (hasText: boolean) => void
  onSubmit: () => void
  onBlurPersist: (content: string) => void
  onAddCurrentIdeContext?: () => boolean
  onClearIdeContexts?: () => void
  selectedIdeContextItems?: Array<{ id: string; label: string }>
  fallbackFileSearchRoot?: string | null
  filterSelectedMentionFiles?: boolean
  imageDraftTarget?: ImageDraftTarget
  enableImageAttachments?: boolean
  enableFileMentions?: boolean
  fontSizeOffset?: number
  autoFocus?: boolean
}

/**
 * Pane-local composer input. Keystrokes stay inside this component so two mounted chat panes
 * never share draft state or force their parent workspace to rerender per character.
 */
export const ChatInputController = React.memo(
  React.forwardRef<ChatInputControllerHandle, ChatInputControllerProps>(
    (
      {
        conversationId,
        initialValue,
        slashCommands,
        onSlashCommandSelect,
        onHasTextChange,
        onSubmit,
        onBlurPersist,
        onAddCurrentIdeContext,
        onClearIdeContexts,
        selectedIdeContextItems,
        fallbackFileSearchRoot,
        filterSelectedMentionFiles = true,
        imageDraftTarget = { kind: 'composer' },
        enableImageAttachments = true,
        enableFileMentions = true,
        fontSizeOffset = 0,
        autoFocus = true,
      },
      ref
    ) => {
      const [value, setValueState] = useState(initialValue)
      const valueRef = useRef(initialValue)
      const wrapperRef = useRef<HTMLDivElement | null>(null)
      const lastHasTextRef = useRef(initialValue.trim().length > 0)

      const publishHasText = useCallback(
        (nextValue: string) => {
          const hasText = nextValue.trim().length > 0
          if (hasText !== lastHasTextRef.current) {
            lastHasTextRef.current = hasText
            onHasTextChange(hasText)
          }
        },
        [onHasTextChange]
      )

      const setValue = useCallback(
        (next: ChatInputUpdater) => {
          const previous = valueRef.current
          const nextValue = typeof next === 'function' ? next(previous) : next
          valueRef.current = nextValue
          setValueState(nextValue)
          publishHasText(nextValue)
        },
        [publishHasText]
      )

      const clear = useCallback(() => setValue(''), [setValue])
      const focus = useCallback(() => {
        const textarea = wrapperRef.current?.querySelector('textarea')
        if (!textarea) return
        try {
          textarea.focus({ preventScroll: true })
        } catch {
          textarea.focus()
        }
      }, [])

      useEffect(() => {
        valueRef.current = initialValue
        setValueState(initialValue)
        const hasText = initialValue.trim().length > 0
        lastHasTextRef.current = hasText
        onHasTextChange(hasText)
      }, [conversationId, initialValue, onHasTextChange])

      React.useImperativeHandle(
        ref,
        () => ({ getValue: () => valueRef.current, setValue, clear, focus }),
        [clear, focus, setValue]
      )

      const handleChange = useCallback(
        (nextValue: string) => {
          valueRef.current = nextValue
          setValueState(nextValue)
          publishHasText(nextValue)
        },
        [publishHasText]
      )

      return (
        <div ref={wrapperRef}>
          <InputTextArea
            value={value}
            onChange={handleChange}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSubmit()
              }
            }}
            onBlur={() => onBlurPersist(valueRef.current)}
            placeholder='Type your message...'
            state='default'
            width='w-full'
            minRows={1}
            autoFocus={autoFocus}
            showCharCount={false}
            slashCommands={slashCommands}
            onSlashCommandSelect={onSlashCommandSelect}
            onAddCurrentIdeContext={onAddCurrentIdeContext}
            onClearIdeContexts={onClearIdeContexts}
            selectedIdeContextItems={selectedIdeContextItems}
            fallbackFileSearchRoot={fallbackFileSearchRoot}
            filterSelectedMentionFiles={filterSelectedMentionFiles}
            enableImageAttachments={enableImageAttachments}
            enableFileMentions={enableFileMentions}
            imageDraftTarget={imageDraftTarget}
            fontSizeOffset={fontSizeOffset}
            className='!border-0 !focus:border-0 !outline-none !shadow-none focus:!ring-0'
          />
        </div>
      )
    }
  )
)

ChatInputController.displayName = 'ChatInputController'
