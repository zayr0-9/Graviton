import React from 'react'
import { useStreamingThinkingWord } from './useStreamingThinkingWord'
import { useReducedMotion } from 'framer-motion'
import { MESSAGE_BLOCK_INSET_CLASS } from '../ChatMessage/chatMessageShared'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export type StreamingThinkingIndicatorVariant = 'inline' | 'tab'

/** Tab content on the composer's top edge. `ComposerSurface` draws the tab's glass and outline. */
export const STREAMING_TAB_SURFACE_CLASS = 'relative'

type StreamingThinkingIndicatorProps = {
  variant?: StreamingThinkingIndicatorVariant
  compacting?: boolean
  compactionCompleted?: boolean
  className?: string
  animatedBorderClassName?: string
  style?: React.CSSProperties
}

export const StreamingThinkingIndicator = React.memo(function StreamingThinkingIndicator({
  variant = 'inline',
  compacting = false,
  compactionCompleted = false,
  className = '',
  animatedBorderClassName = '',
  style,
}: StreamingThinkingIndicatorProps) {
  const thinkingWord = useStreamingThinkingWord(!compacting)
  const shouldReduceMotion = useReducedMotion()
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const mutedColor = enabled ? getThemeModeColor(theme.colors.toolJobsMutedText, isDarkMode) : undefined

  const variantClassName =
    variant === 'tab'
      ? `${STREAMING_TAB_SURFACE_CLASS} ${animatedBorderClassName}`
      : `rounded-md ${MESSAGE_BLOCK_INSET_CLASS} py-0.5`

  return (
    <div
      className={`inline-flex items-center gap-2 text-[0.75em] leading-[1.2] text-neutral-500 dark:text-neutral-400 ${variantClassName} ${className}`.trim()}
      style={{ color: mutedColor, ...style }}
      aria-live='polite'
      aria-label={compacting ? (compactionCompleted ? 'Context compacted' : 'Compacting context') : 'Assistant is working'}
    >
      {variant === 'tab' && !compacting && (
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
      <span className='relative z-10 flex min-w-[5.75rem] items-center gap-2'>
        <span
          className={`font-medium leading-[1.2] ${shouldReduceMotion || compactionCompleted ? '' : 'tool-name-shimmer'}`}
          style={mutedColor ? { '--tool-shimmer-base': mutedColor } as React.CSSProperties : undefined}
        >
          {compacting ? (compactionCompleted ? 'Compacted' : 'Compacting') : thinkingWord}
        </span>
        {compacting && (
          <span
            role='progressbar'
            aria-label='Context compaction progress'
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={compactionCompleted ? 100 : undefined}
            aria-valuetext={compactionCompleted ? 'Complete' : 'Compacting; duration unknown'}
            className='h-[2px] w-16 shrink-0 overflow-hidden rounded-full bg-current/10'
          >
            <span
              className='compaction-progress-fill block h-full w-full origin-left rounded-full bg-current opacity-60'
              data-completed={compactionCompleted}
            />
          </span>
        )}
      </span>
    </div>
  )
})
