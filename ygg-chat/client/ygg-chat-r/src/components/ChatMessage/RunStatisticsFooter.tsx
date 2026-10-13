import { memo, useState } from 'react'
import { getThemeModeColor } from '../ThemeManager/themeConfig'
import type { CompactMessageNoticeProps } from './CompactMessageNotice'
import { formatRunStatistics, formatRunStatisticsDetails, type RunStatisticsFooterData } from '../../features/chats/runStatistics'
import './RunStatisticsFooter.css'

/** Full-width summary stays visible; hover overlays details without changing transcript height. */
export const RunStatisticsFooter = memo(function RunStatisticsFooter({ statistics, customTheme, customThemeEnabled, isDarkMode = false }:
  { statistics: RunStatisticsFooterData } & CompactMessageNoticeProps) {
  const summary = formatRunStatistics(statistics)
  const details = formatRunStatisticsDetails(statistics)
  const [expanded, setExpanded] = useState(false)
  return (
    <div className='px-0 pb-3 pt-1 text-right text-xs leading-5 text-neutral-500 dark:text-neutral-400 sm:px-2'
      style={customThemeEnabled && customTheme ? { color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode) } : undefined}
      aria-label='Run statistics'>
      <span className='run-statistics-reveal' tabIndex={0} role='button'
        aria-expanded={expanded} data-expanded={expanded ? 'true' : undefined}
        aria-label={`${summary}. ${details}. Slice tokens estimate transcript content once, excluding replayed history. Up arrow: input tokens (user text and tool results). Down arrow: output tokens (assistant/reasoning and tool calls). Hover or focus for details.`}
        onClick={() => setExpanded(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setExpanded(false)
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(value => !value) }
        }}>
        <span className='run-statistics-summary' aria-hidden='true'>{summary}</span>
        <span className='run-statistics-details' aria-hidden='true'>{details}</span>
      </span>
    </div>
  )
})
