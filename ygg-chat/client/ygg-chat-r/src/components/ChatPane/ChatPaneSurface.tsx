import React from 'react'

export interface ChatPaneSurfaceProps {
  children: React.ReactNode
  toolbar: React.ReactNode
  composer: React.ReactNode
  active?: boolean
  onActivate?: () => void
  surfaceColor?: string
  className?: string
  transcriptClassName?: string
  transcriptRef?: React.Ref<HTMLDivElement>
  onTranscriptScroll?: React.UIEventHandler<HTMLDivElement>
  ariaLabel: string
  style?: React.CSSProperties
}

/**
 * Shared transcript-pane geometry. Controllers provide toolbar, transcript content and composer;
 * this component keeps the visual shell identical without coupling pane-local state.
 */
export function ChatPaneSurface({
  children,
  toolbar,
  composer,
  active = false,
  onActivate,
  surfaceColor,
  className = '',
  transcriptClassName = '',
  transcriptRef,
  onTranscriptScroll,
  ariaLabel,
  style,
}: ChatPaneSurfaceProps) {
  return (
    <section
      className={`relative mb-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-transparent sm:min-w-[240px] md:min-w-[280px] ${className}`}
      style={{ backgroundColor: surfaceColor, ...style }}
      aria-label={ariaLabel}
      data-chat-pane-surface='true'
      data-chat-pane-active={active ? 'true' : 'false'}
      onMouseDown={onActivate}
      onFocusCapture={onActivate}
    >
      <div
        className={`relative mx-4 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-transparent ${
          active ? 'bg-black/[0.01] dark:bg-white/[0.015]' : ''
        }`}
        style={{ backgroundColor: surfaceColor }}
      >
        <div className='pointer-events-none absolute left-0 right-0 top-0 z-20 px-2 pt-4'>
          <div className='pointer-events-auto mx-auto'>{toolbar}</div>
        </div>
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className={`thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain rounded-lg pt-25 ${transcriptClassName}`}
          style={{ backgroundColor: surfaceColor, overflowAnchor: 'none' }}
        >
          {children}
        </div>
        <div
          className='absolute bottom-0 left-0 right-0 z-30 mx-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-0 md:px-4'
          data-chat-pane-composer='true'
        >
          {composer}
        </div>
      </div>
    </section>
  )
}
