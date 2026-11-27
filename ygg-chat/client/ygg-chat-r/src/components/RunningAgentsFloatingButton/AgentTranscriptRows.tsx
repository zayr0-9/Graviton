import { memo } from 'react'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import { SummarisedMessage } from '../ChatMessage/SummarisedMessage'
import { WatcherCompletionNotice } from '../ChatMessage/WatcherCompletionNotice'
import { createDefaultCustomChatTheme, getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import type { PreviewRow } from './agentPreviewContent'

const DEFAULT_THEME = createDefaultCustomChatTheme()

type TranscriptRow = PreviewRow & { streamId?: string }

/** Both agent viewers use the same read-only cards, grouping and theme. */
export const AgentTranscriptRows = memo(function AgentTranscriptRows({ rows, idPrefix, grouped }: {
  rows: TranscriptRow[]; idPrefix: string; grouped: boolean
}) {
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const userSurfaceColor = getThemeModeColor((enabled ? theme : DEFAULT_THEME).colors.agentsGridUserMessageBg, isDarkMode)
  const themeProps = { customTheme: theme, customThemeEnabled: enabled, isDarkMode }
  return <>{rows.map(row => {
    const id = `${idPrefix}:${row.streamId ? `${row.streamId}:` : ''}${row.key}`
    return <div key={id} className={row.role === 'user' && !row.watcherCompletion ? 'ml-auto w-fit min-w-0 max-w-[90%] [&_.chat-markdown]:[overflow-wrap:anywhere]' : 'min-w-0'}>
      {row.summarised ? <SummarisedMessage id={id} className='w-full' {...themeProps} /> :
        row.watcherCompletion ? <WatcherCompletionNotice id={id} className='w-full' content={row.content} {...themeProps} /> :
        <ChatMessage id={id} role={row.role} content={row.content} contentBlocks={row.blocks}
          width='w-full' showInlineActions={false} readOnly groupToolReasoningRuns={grouped}
          userSurfaceColor={userSurfaceColor} {...themeProps} />}
    </div>
  })}</>
})
