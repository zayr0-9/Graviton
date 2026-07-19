import React, { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

const STREAMING_THINKING_WORDS = [
  'Thinking',
  'Reading',
  'Tracing',
  'Checking',
  'Reviewing',
  'Inspecting',
  'Planning',
  'Composing',
  'Working',
]

const STREAMING_THINKING_WORD_INTERVAL_MS = 3200

type StreamingThinkingIndicatorVariant = 'inline' | 'tab'

type StreamingThinkingIndicatorProps = {
  variant?: StreamingThinkingIndicatorVariant
  className?: string
  animatedBorderClassName?: string
  style?: React.CSSProperties
}

export const StreamingThinkingIndicator = React.memo(function StreamingThinkingIndicator({
  variant = 'inline',
  className = '',
  animatedBorderClassName = '',
  style,
}: StreamingThinkingIndicatorProps) {
  const [wordIndex, setWordIndex] = useState(0)
  const shouldReduceMotion = useReducedMotion()

  useEffect(() => {
    if (shouldReduceMotion || typeof window === 'undefined' || STREAMING_THINKING_WORDS.length <= 1) return

    const intervalId = window.setInterval(() => {
      setWordIndex(prev => (prev + 1) % STREAMING_THINKING_WORDS.length)
    }, STREAMING_THINKING_WORD_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [shouldReduceMotion])

  const variantClassName =
    variant === 'tab'
      ? `relative rounded-t-xl border border-b-0 border-neutral-300/60 bg-neutral-100/40 px-2 pb-3.5 pt-1.5 backdrop-blur-xl before:absolute before:inset-x-0 before:-bottom-[5px] before:h-[6px] before:bg-neutral-100/40 after:absolute after:-left-px after:-bottom-[8px] after:h-[9px] after:w-4 after:border-l after:border-neutral-300/60 after:bg-neutral-100/40 dark:border-neutral-700/70 dark:bg-neutral-900/40 dark:before:bg-neutral-900/40 dark:after:border-neutral-700/70 dark:after:bg-neutral-900/40 ${animatedBorderClassName}`
      : 'rounded-md px-1 py-0.5'

  return (
    <div
      className={`inline-flex items-center gap-2 text-[0.75em] leading-[1.2] text-neutral-500 dark:text-neutral-400 ${variantClassName} ${className}`.trim()}
      style={style}
      aria-live='polite'
      aria-label='Assistant is working'
    >
      {variant === 'tab' && (
        <span
          aria-hidden='true'
          className='relative z-10 grid h-3 w-4 grid-cols-2 grid-rows-2 gap-0.5'
        >
          <span className='streaming-pixel h-1.5 w-1.5 rounded-[1px] bg-blue-500/75 shadow-[0_0_6px_rgba(59,130,246,0.55)] dark:bg-orange-500/80 dark:shadow-[0_0_6px_rgba(249,115,22,0.55)]' />
          <span className='streaming-pixel streaming-pixel-delay-1 h-1.5 w-1.5 rounded-[1px] bg-blue-500/35 dark:bg-orange-500/40' />
          <span className='streaming-pixel streaming-pixel-delay-2 h-1.5 w-1.5 rounded-[1px] bg-blue-500/35 dark:bg-orange-500/40' />
          <span className='streaming-pixel streaming-pixel-delay-3 h-1.5 w-1.5 rounded-[1px] bg-blue-500/60 dark:bg-orange-500/65' />
        </span>
      )}
      <span className={`relative z-10 min-w-[5.75rem] font-medium leading-[1.2] ${shouldReduceMotion ? '' : 'tool-name-shimmer'}`}>
        {STREAMING_THINKING_WORDS[wordIndex]}
      </span>
    </div>
  )
})
