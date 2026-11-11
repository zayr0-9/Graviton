import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppSelector } from '../../hooks/redux'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import { SummarisedMessage } from '../ChatMessage/SummarisedMessage'
import { WatcherCompletionNotice } from '../ChatMessage/WatcherCompletionNotice'
import { StreamingThinkingIndicator } from '../StreamingThinkingIndicator'
import { buildAgentPreviewRows } from './agentPreviewContent'
import { buildForkPreviewRows, createAgentPreviewRunsSelector } from './agentForkPreview'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export interface AgentPreviewScrollState { top: number; following: boolean }

export const AgentRunPreview = memo(function AgentRunPreview({ streamId, grouped, fillHeight = false, transcriptLabel = 'Run transcript', wholeFork = false, isStreaming = false, scrollState }: { streamId: string; grouped: boolean; fillHeight?: boolean; transcriptLabel?: string; wholeFork?: boolean; isStreaming?: boolean; scrollState?: AgentPreviewScrollState }) {
  const selectRuns = useMemo(() => createAgentPreviewRunsSelector(streamId, wholeFork), [streamId, wholeFork])
  const runs = useAppSelector(selectRuns)
  const run = runs.find(preview => preview.streamId === streamId)
  const rows = useMemo(() => wholeFork ? buildForkPreviewRows(runs) : run ? buildAgentPreviewRows(run).map(row => ({ ...row, streamId, firstInRun: false, runStartedAt: run.stream.createdAt })) : [], [runs, run, wholeFork, streamId])
  // Read run-scoped state, not Chat's currently selected branch. A whole-fork
  // preview may include a compacting run other than its representative.
  const compacting = runs.some(preview => preview.stream.active && preview.stream.compactionStatus === 'started')
  const showActivity = isStreaming || compacting
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(scrollState?.following ?? true)
  const [following, setFollowing] = useState(followRef.current)
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  useLayoutEffect(() => {
    if (scrollRef.current && scrollState && !scrollState.following) scrollRef.current.scrollTop = scrollState.top
  }, [scrollState])

  useEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [rows, grouped, showActivity, compacting])

  if (!run) return <p className='p-4 text-sm text-neutral-500'>No captured transcript is available for this run. Use Open chat to view saved messages.</p>

  return (
    <div className={fillHeight ? 'relative flex min-h-0 flex-1 flex-col' : 'relative min-h-0'}>
      <div ref={scrollRef} className={`${fillHeight ? 'min-h-0 flex-1' : 'h-[min(52vh,34rem)]'} overflow-y-auto overscroll-contain px-1 pb-3 thin-scrollbar`}
        aria-label={transcriptLabel} tabIndex={0}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          setFollowing(followRef.current)
          if (scrollState) { scrollState.top = element.scrollTop; scrollState.following = followRef.current }
        }}>
        {rows.length === 0 ? !showActivity && <p className='p-3 text-sm text-neutral-500'>Waiting for run output…</p> : rows.map(row => (
          <div key={row.key} className={row.role === 'user' ? 'min-w-0 [&_.chat-markdown]:[overflow-wrap:anywhere]' : 'min-w-0'}>
          {row.summarised ? <SummarisedMessage id={`agent-preview:${row.streamId}:${row.key}`} className='w-full'
            customTheme={theme} customThemeEnabled={enabled} isDarkMode={isDarkMode} /> :
          row.watcherCompletion ? <WatcherCompletionNotice id={`agent-preview:${row.streamId}:${row.key}`} className='w-full'
            content={row.content} customTheme={theme} customThemeEnabled={enabled} isDarkMode={isDarkMode} /> :
          <ChatMessage id={`agent-preview:${row.streamId}:${row.key}`} role={row.role}
            content={row.content} contentBlocks={row.blocks}
            width='w-full' showInlineActions={false} readOnly keepTextOutsideGroups
            groupToolReasoningRuns={grouped} customTheme={theme} customThemeEnabled={enabled} isDarkMode={isDarkMode} />}
          </div>
        ))}
        {showActivity && (
          <div className={`${rows.length > 0 ? 'pt-2' : 'pt-1'} px-0 sm:px-2`}>
            <StreamingThinkingIndicator compacting={compacting} />
          </div>
        )}
      </div>
      {!following && <button type='button' className='absolute bottom-3 right-3 rounded-full bg-neutral-800 px-3 py-1.5 text-xs text-white shadow'
        onClick={() => {
          followRef.current = true
          if (scrollState) scrollState.following = true
          setFollowing(true)
          const element = scrollRef.current
          if (element) element.scrollTop = element.scrollHeight
        }}>Jump to latest</button>}
    </div>
  )
})
