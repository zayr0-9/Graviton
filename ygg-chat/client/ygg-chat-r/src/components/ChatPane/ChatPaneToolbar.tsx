import React from 'react'
import { X } from 'lucide-react'
import { Button } from '../Button/button'

export interface ChatPaneToolbarProps {
  title: string
  subtitle?: string
  leading?: React.ReactNode
  actions?: React.ReactNode
  onClose?: () => void
  backgroundColor?: string
  darkMode?: boolean
}

/** Shared floating glass toolbar; pane controllers decide which actions are available. */
export function ChatPaneToolbar({
  title,
  subtitle,
  leading,
  actions,
  onClose,
  backgroundColor,
  darkMode = false,
}: ChatPaneToolbarProps) {
  return (
    <div
      className='flex items-center gap-1 rounded-full border px-1.5 py-1 backdrop-blur-[12px]'
      style={{
        backgroundColor,
        borderColor: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
      }}
      data-chat-pane-toolbar='true'
    >
      {leading}
      <div className='min-w-0 flex-1 px-2'>
        <div className='truncate text-sm font-medium text-neutral-800 dark:text-neutral-100'>{title}</div>
        {subtitle && <div className='truncate text-[10px] text-neutral-500 dark:text-neutral-400'>{subtitle}</div>}
      </div>
      {actions}
      {onClose && (
        <Button
          variant='outline2'
          size='medium'
          className='!rounded-full !p-2 transition-[background-color,color,transform] duration-200 hover:bg-black/5 active:scale-95 dark:hover:bg-white/5'
          onClick={onClose}
          aria-label='Close parallel branch'
          title='Close parallel branch'
        >
          <X className='h-4 w-4' strokeWidth={2.25} aria-hidden='true' />
        </Button>
      )}
    </div>
  )
}
