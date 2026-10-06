import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppSelector } from '../../hooks/redux'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import { buildAgentPreviewRows } from './agentPreviewContent'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export function AgentRunPreview({ streamId, grouped, fillHeight = false }: { streamId: string; grouped: boolean; fillHeight?: boolean }) {
  const run = useAppSelector(state => state.agentRunPreviews.byStreamId[streamId])
  const rows = useMemo(() => run ? buildAgentPreviewRows(run) : [], [run])
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  useEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [rows, grouped])

  if (!run) return <p className='p-4 text-sm text-neutral-500'>Only the latest run preview per fork is retained. Use Open chat to view earlier messages.</p>

  return (
    <div className={fillHeight ? 'relative flex min-h-0 flex-1 flex-col' : 'relative min-h-0'}>
      <div className='shrink-0 px-3 py-2 text-xs text-neutral-500' role='status'>
        {run.stream.active ? run.stream.status === 'waiting_for_tool' ? 'Waiting for tools' : 'Live' : run.stream.error ? 'Ended with error' : 'Run ended'}
        {run.partial ? ' · Recovered preview may omit earlier turns' : ''}
      </div>
      <div ref={scrollRef} className={`${fillHeight ? 'min-h-0 flex-1' : 'h-[min(52vh,34rem)]'} overflow-y-auto overscroll-contain px-1 pb-3 thin-scrollbar`}
        aria-label='Run transcript' tabIndex={0}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          setFollowing(followRef.current)
        }}>
        {rows.length === 0 ? <p className='p-3 text-sm text-neutral-500'>Waiting for run output…</p> : rows.map(row => (
          <ChatMessage key={row.key} id={`agent-preview:${streamId}:${row.key}`} role={row.role}
            content={row.content} contentBlocks={row.blocks}
            width='w-full' showInlineActions={false} readOnly keepTextOutsideGroups
            groupToolReasoningRuns={grouped} customTheme={theme} customThemeEnabled={enabled} isDarkMode={isDarkMode} />
        ))}
      </div>
      {!following && <button type='button' className='absolute bottom-3 right-3 rounded-full bg-neutral-800 px-3 py-1.5 text-xs text-white shadow'
        onClick={() => {
          followRef.current = true
          setFollowing(true)
          const element = scrollRef.current
          if (element) element.scrollTop = element.scrollHeight
        }}>Jump to latest</button>}
    </div>
  )
}
