import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getThemeModeColor } from '../ThemeManager/themeConfig'
import type { CompactMessageNoticeProps } from './CompactMessageNotice'
import { formatRunStatistics, formatRunStatisticsDetails, type RunStatisticsFooterData } from '../../features/chats/runStatistics'
import './RunStatisticsFooter.css'

/** Display-only chrome. Hover reveals details without changing measured transcript height. */
export const RunStatisticsFooter = memo(function RunStatisticsFooter({ statistics, customTheme, customThemeEnabled, isDarkMode = false }:
  { statistics: RunStatisticsFooterData } & CompactMessageNoticeProps) {
  const summary = formatRunStatistics(statistics)
  const details = formatRunStatisticsDetails(statistics)
  const viewportRef = useRef<HTMLSpanElement>(null)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [geometry, setGeometry] = useState({ width: 0, offset: 0 })
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    const summaryElement = summaryRef.current
    if (!viewport || !track || !summaryElement) return
    const measure = () => {
      const width = Math.ceil(summaryElement.getBoundingClientRect().width)
      const offset = Math.min(0, viewport.clientWidth - track.scrollWidth)
      setGeometry(previous => previous.width === width && previous.offset === offset ? previous : { width, offset })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(viewport)
    observer?.observe(summaryElement)
    observer?.observe(track)
    return () => observer?.disconnect()
  }, [summary, details])
  const revealStyle = {
    '--run-statistics-summary-width': geometry.width ? `${geometry.width}px` : '100%',
    '--run-statistics-slide-offset': `${geometry.offset}px`,
  } as CSSProperties
  return (
    <div className='px-0 pb-3 pt-1 text-right text-xs leading-5 text-neutral-500 dark:text-neutral-400 sm:px-2'
      style={customThemeEnabled && customTheme ? { color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode) } : undefined}
      aria-label='Run statistics'>
      <span ref={viewportRef} className='run-statistics-reveal' style={revealStyle} tabIndex={0} role='button'
        aria-expanded={expanded} data-expanded={expanded ? 'true' : undefined}
        aria-label={`${summary}. ${details}. Slice tokens estimate transcript content once, excluding replayed history. Hover or focus for details.`}
        onClick={() => setExpanded(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setExpanded(false)
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(value => !value) }
        }}>
        <span ref={trackRef} className='run-statistics-track' aria-hidden='true'>
          <span ref={summaryRef}>{summary}</span>
          <span> · {details}</span>
        </span>
      </span>
    </div>
  )
})
