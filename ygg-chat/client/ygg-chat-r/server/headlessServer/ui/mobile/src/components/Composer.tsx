import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Textarea } from './ui'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  onDisabledInteract?: () => void
  sending?: boolean
  isBranching?: boolean
  branchLabel?: string
  onCancelBranch?: () => void
  slashCommands?: string[]
  // `| undefined`, not `| void`: selectSlashCommand reads `.handled` off the result,
  // and a `void` return type forbids that property access even behind `?.`.
  onSlashCommandSelect?: (command: string) => { handled: boolean; clearInput?: boolean } | undefined
}

const DEFAULT_ROWS = 1
const MAX_ROWS = 6

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  onDisabledInteract,
  sending = false,
  isBranching = false,
  branchLabel,
  onCancelBranch,
  slashCommands = [],
  onSlashCommandSelect,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const computedStyle = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 20
    const paddingY = (Number.parseFloat(computedStyle.paddingTop) || 0) + (Number.parseFloat(computedStyle.paddingBottom) || 0)
    const borderY = (Number.parseFloat(computedStyle.borderTopWidth) || 0) + (Number.parseFloat(computedStyle.borderBottomWidth) || 0)

    const minHeight = lineHeight * DEFAULT_ROWS + paddingY + borderY
    const maxHeight = lineHeight * MAX_ROWS + paddingY + borderY

    textarea.style.height = 'auto'
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  const activeSlashQuery = useMemo(() => {
    const trimmedStart = value.trimStart()
    if (!trimmedStart.startsWith('/') || trimmedStart.includes('\n')) return null
    const commandText = trimmedStart.slice(1)
    if (commandText.includes(' ')) return null
    return commandText.toLowerCase()
  }, [value])

  const filteredSlashCommands = useMemo(() => {
    if (activeSlashQuery == null || disabled || slashCommands.length === 0) return []
    return slashCommands.filter(command => command.toLowerCase().startsWith(activeSlashQuery))
  }, [activeSlashQuery, disabled, slashCommands])

  useEffect(() => {
    setSelectedSlashIndex(0)
  }, [activeSlashQuery])

  const selectSlashCommand = useCallback(
    (command: string) => {
      const result = onSlashCommandSelect?.(command)
      if (result?.handled && result.clearInput) {
        onChange('')
      }
    },
    [onChange, onSlashCommandSelect]
  )

  return (
    <div className='mobile-composer'>
      {isBranching ? (
        <div className='mobile-branch-banner'>
          <span>{branchLabel || 'Branching from selected message'}</span>
          {onCancelBranch ? (
            <Button onClick={onCancelBranch} disabled={disabled || sending} variant='ghost' size='sm'>
              Cancel branch
            </Button>
          ) : null}
        </div>
      ) : null}

      {filteredSlashCommands.length > 0 ? (
        <div className='mobile-slash-menu' role='listbox' aria-label='Slash commands'>
          <div className='mobile-slash-menu-heading'>Commands</div>
          {filteredSlashCommands.map((command, index) => {
            const selected = index === selectedSlashIndex
            return (
              <button
                key={command}
                type='button'
                className={selected ? 'selected' : undefined}
                onMouseEnter={() => setSelectedSlashIndex(index)}
                onClick={() => selectSlashCommand(command)}
              >
                <span className='mobile-slash-menu-icon'>/</span>
                <span className='mobile-slash-menu-copy'>
                  <span className='mobile-slash-menu-label'>/{command}</span>
                  <span className='mobile-slash-menu-description'>Summarize this branch context</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      <Textarea
        ref={textareaRef}
        rows={DEFAULT_ROWS}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={isBranching ? 'Rewrite branched prompt...' : 'Type a message...'}
        disabled={disabled}
        onInput={autoResize}
        onKeyDown={event => {
          if (filteredSlashCommands.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelectedSlashIndex(index => (index < filteredSlashCommands.length - 1 ? index + 1 : 0))
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedSlashIndex(index => (index > 0 ? index - 1 : filteredSlashCommands.length - 1))
              return
            }
            if (event.key === 'Tab') {
              event.preventDefault()
              selectSlashCommand(filteredSlashCommands[selectedSlashIndex] || filteredSlashCommands[0])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onChange('')
              return
            }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <Button onClick={onSubmit} disabled={disabled || sending || !value.trim()}>
        {sending ? 'Busy' : isBranching ? 'Send Branch' : 'Send'}
      </Button>

      {disabled && onDisabledInteract ? (
        <button
          type='button'
          className='mobile-composer-disabled-overlay'
          onClick={onDisabledInteract}
          aria-label='Composer is disabled. Show reason'
        />
      ) : null}
    </div>
  )
}
