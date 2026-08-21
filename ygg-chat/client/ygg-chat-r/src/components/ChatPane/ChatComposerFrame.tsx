import React from 'react'
import type { SendButtonAnimationType } from '../SettingsPane/SendButtonAnimationSettings'
import { SendButtonLoadingAnimation } from '../SettingsPane/SendButtonAnimationSettings'

export interface ChatComposerFrameProps {
  children: React.ReactNode
  controlsLeft?: React.ReactNode
  controlsRight?: React.ReactNode
  canSend: boolean
  streaming: boolean
  onSend: () => void
  onStop: () => void
  sendButtonAnimation: SendButtonAnimationType
  sendButtonColor?: string
  borderClassName?: string
  surfaceStyle?: React.CSSProperties
  className?: string
}

/** Shared composer chrome used by every transcript pane. State and controls remain pane-owned. */
export function ChatComposerFrame({
  children,
  controlsLeft,
  controlsRight,
  canSend,
  streaming,
  onSend,
  onStop,
  sendButtonAnimation,
  sendButtonColor,
  borderClassName = 'outline-1 outline-neutral-200/70 dark:outline-neutral-700/50',
  surfaceStyle,
  className = '',
}: ChatComposerFrameProps) {
  return (
    <div className={`relative isolate ${className}`} data-chat-composer-frame='true'>
      <div
        className={`slate-input-wrapper relative z-10 ${borderClassName} rounded-3xl bg-neutral-100/40 px-2 pb-2 pt-3 backdrop-blur-xl transition-[background-color,outline-color] duration-300 dark:bg-neutral-900/40`}
        style={surfaceStyle}
      >
        {children}
        <div className='composer-controls-row relative z-10 mt-2 flex items-center justify-between gap-3'>
          <div
            className={`composer-controls-left relative z-20 flex h-10 min-w-0 flex-1 items-center overflow-visible rounded-full ${borderClassName} bg-neutral-100/40 px-2 py-1 backdrop-blur-xl xl:h-12 xl:py-1.5 dark:bg-neutral-900/40`}
          >
            {controlsLeft}
          </div>
          <div
            className={`flex h-10 shrink-0 items-center gap-1 rounded-full ${borderClassName} bg-neutral-100/40 px-2 py-1 backdrop-blur-xl xl:h-12 xl:py-1.5 dark:bg-neutral-900/40`}
          >
            {controlsRight}
            {streaming ? (
              <button
                type='button'
                onClick={onStop}
                title='Stop generation'
                aria-label='Stop generation'
                className='cursor-pointer transition-transform hover:scale-105 active:scale-95'
              >
                <SendButtonLoadingAnimation animationType={sendButtonAnimation} bgColor={sendButtonColor} />
              </button>
            ) : (
              <button
                type='button'
                className={`ml-1 flex h-9 w-9 items-center justify-center rounded-full transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                  canSend
                    ? 'cursor-pointer bg-white text-black hover:scale-105 hover:bg-blue-500 hover:text-white active:scale-95 dark:bg-neutral-200'
                    : 'cursor-not-allowed bg-neutral-300 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400'
                }`}
                disabled={!canSend}
                title='Send message'
                aria-label='Send message'
                onClick={onSend}
              >
                <svg
                  className='relative h-6 w-6 -rotate-45'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                  strokeWidth={3}
                  aria-hidden='true'
                >
                  <path d='m5 12 14 0' />
                  <path d='m12 5 7 7-7 7' />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
