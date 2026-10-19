import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'

interface TransferScopeChooserProps {
  action: 'copy' | 'move' | 'new'
  selectionCount: number
  branchCount: number
  branchMoveBlocked: boolean
  itemClassName: string
  itemStyle?: CSSProperties
  mutedStyle?: CSSProperties
  onBack: () => void
  onSelect: (scope: 'selection' | 'branch') => void
}

export function TransferScopeChooser({
  action, selectionCount, branchCount, branchMoveBlocked,
  itemClassName, itemStyle, mutedStyle, onBack, onSelect,
}: TransferScopeChooserProps) {
  const firstChoiceRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstChoiceRef.current?.focus() }, [])

  const title = action === 'new' ? 'New chat from' : `${action === 'move' ? 'Move' : 'Copy'} to existing chat`
  const buttonClassName = `${itemClassName} text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current disabled:cursor-not-allowed disabled:opacity-50`

  return (
    <div
      role='group'
      aria-label={title}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onBack()
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
      }}
    >
      <button type='button' className={buttonClassName} style={itemStyle} onClick={onBack}>
        <ArrowLeft size={16} aria-hidden='true' />
        <span>Back</span>
      </button>
      <div className='px-3 py-2 text-xs text-stone-500 dark:text-neutral-400' style={mutedStyle}>{title}</div>
      <button
        ref={firstChoiceRef}
        type='button'
        className={buttonClassName}
        style={itemStyle}
        disabled={selectionCount === 0}
        onClick={() => onSelect('selection')}
      >
        <span>Selected message{selectionCount === 1 ? '' : 's'}</span>
        <span className='ml-auto text-xs tabular-nums'>{selectionCount}</span>
      </button>
      <button
        type='button'
        className={buttonClassName}
        style={itemStyle}
        disabled={branchMoveBlocked || branchCount === 0}
        aria-describedby={branchMoveBlocked ? 'heimdall-branch-move-warning' : undefined}
        onClick={() => onSelect('branch')}
      >
        <span>Current active branch</span>
        <span className='ml-auto text-xs tabular-nums'>{branchCount}</span>
      </button>
      {branchMoveBlocked && (
        <p id='heimdall-branch-move-warning' className='px-3 py-2 text-xs text-stone-500 dark:text-neutral-400' style={mutedStyle}>
          Moving this branch would delete messages on other branches. Use copy instead.
        </p>
      )}
    </div>
  )
}
