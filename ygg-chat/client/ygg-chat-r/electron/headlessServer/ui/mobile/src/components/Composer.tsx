import React, { useCallback, useEffect, useRef } from 'react'
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
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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

      <Textarea
        ref={textareaRef}
        rows={DEFAULT_ROWS}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={isBranching ? 'Rewrite branched prompt...' : 'Type a message...'}
        disabled={disabled}
        onInput={autoResize}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <Button onClick={onSubmit} disabled={disabled || sending || !value.trim()}>
        {sending ? 'Stop' : isBranching ? 'Send Branch' : 'Send'}
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
