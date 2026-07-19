import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { selectCurrentConversationId, selectCurrentPath } from '../../features/chats'
import type { BranchDebugData, BranchDebugRow } from '../../features/chats/branchDebug'
import { uiActions, type UiNotification } from '../../features/ui'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import {
  getAgentActivityBadgeClasses,
  summarizeAgentStreamId,
  useRunningAgentStreams,
  type AgentStreamListItem,
} from '../../hooks/useRunningAgentStreams'
import { useConversationBranchDebugData, type ResearchNoteItem } from '../../hooks/useQueries'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { useMotionPreferences } from '../motion'

interface RunningAgentsFloatingButtonProps {
  notes?: ResearchNoteItem[]
  className?: string
  onOpenApps: () => void
  appsOpen?: boolean
}

const codexDevLogsEnabled =
  (typeof __YGG_CODEX_DEV_LOGS__ !== 'undefined' && __YGG_CODEX_DEV_LOGS__) ||
  (typeof window !== 'undefined' && Boolean(window.electronAPI?.dev?.codexDevLogsEnabled))

const getStreamHref = (stream: AgentStreamListItem): string | null => {
  if (!stream.conversationId) return null
  const projectSegment = stream.projectId ? String(stream.projectId) : 'unknown'
  const hash = stream.anchorMessageId ? `#${stream.anchorMessageId}` : ''
  return `/chat/${projectSegment}/${stream.conversationId}${hash}`
}

const formatAgentTime = (value: string | null | undefined): string => {
  if (!value) return ''
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const getNotificationHref = (notification: UiNotification): string => {
  const projectSegment = notification.projectId != null ? String(notification.projectId) : 'unknown'
  return `/chat/${projectSegment}/${notification.conversationId}#${notification.messageId}`
}

const getTranslucentCssColor = (color: string, alpha: number) => {
  const clampedAlpha = Math.max(0, Math.min(1, alpha))
  const hexMatch = color.match(/^#([0-9a-fA-F]{6})$/)

  if (hexMatch) {
    const hex = hexMatch[1]
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`
  }

  return `color-mix(in srgb, ${color} ${Math.round(clampedAlpha * 100)}%, transparent)`
}

interface BranchDebugStreamMatch {
  stream: AgentStreamListItem
  matchedMessageId: string
}

const getBranchStreamMatches = (
  branch: BranchDebugRow,
  activeStreams: AgentStreamListItem[],
  conversationId: string | number | null
): BranchDebugStreamMatch[] => {
  const branchMessageIds = new Set(branch.messages.map(message => String(message.id)))
  const conversationKey = conversationId == null ? null : String(conversationId)

  return activeStreams
    .filter(stream => {
      if (!stream.conversationId) return false
      return conversationKey == null || String(stream.conversationId) === conversationKey
    })
    .map(stream => {
      const candidateIds = [
        stream.triggerUserMessageId,
        stream.currentBranchAnchorMessageId,
        stream.liveMessageId,
        stream.streamingMessageId,
        stream.lastCompletedMessageId,
        stream.finalMessageId,
        stream.messageId,
        stream.branchAnchorMessageId,
        stream.originMessageId,
        stream.rootMessageId,
        stream.anchorMessageId,
      ]

      const matchedMessageId = candidateIds.find(candidate => candidate != null && branchMessageIds.has(String(candidate)))
      return matchedMessageId ? { stream, matchedMessageId: String(matchedMessageId) } : null
    })
    .filter((match): match is BranchDebugStreamMatch => match != null)
}

const messageRoleTone = (role: string): string => {
  switch (role) {
    case 'user':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
    case 'assistant':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200'
    case 'system':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
    case 'ex_agent':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'
    case 'tool':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-200'
    default:
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
  }
}

const BranchDebugModal = ({
  open,
  data,
  conversationId,
  currentPath,
  activeStreams,
  onClose,
}: {
  open: boolean
  data: BranchDebugData | undefined
  conversationId: string | number | null
  currentPath: Array<string | number>
  activeStreams: AgentStreamListItem[]
  onClose: () => void
}) => {
  if (!open) return null

  const branches = data?.branches ?? []
  const maxDepth = data?.maxDepth ?? 0
  const columnIndexes = Array.from({ length: maxDepth }, (_, index) => index)
  const currentPathKey = currentPath.map(id => String(id)).join('>')
  const conversationKey = conversationId == null ? null : String(conversationId)
  const conversationActiveStreams = activeStreams.filter(
    stream => stream.conversationId && (conversationKey == null || String(stream.conversationId) === conversationKey)
  )

  const isCurrentBranch = (branch: BranchDebugRow) => {
    if (!currentPathKey) return false
    return branch.messages.map(message => String(message.id)).join('>') === currentPathKey
  }

  return (
    <div className='fixed inset-0 z-[1700] flex items-end justify-center bg-black/35 p-4 backdrop-blur-sm sm:items-center'>
      <div className='flex max-h-[82vh] w-[min(92rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-neutral-200/80 bg-white text-neutral-900 shadow-2xl dark:border-neutral-700/80 dark:bg-yBlack-900 dark:text-neutral-100'>
        <div className='flex items-start justify-between gap-4 border-b border-neutral-200/80 px-5 py-4 dark:border-neutral-800'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-2'>
              <div className='text-sm font-bold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400'>
                Branch diagnostics
              </div>
              <span className='rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'>
                YGG_CODEX_DEV_LOGS
              </span>
            </div>
            <div className='mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400'>
              Conversation: {conversationId == null ? 'none selected' : String(conversationId)} · Messages:{' '}
              {data?.messageCount ?? 0} · Branches: {data?.leafCount ?? branches.length} · Active streams:{' '}
              {conversationActiveStreams.length}
            </div>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
            aria-label='Close branch diagnostics'
          >
            <i className='bx bx-x text-xl' aria-hidden='true' />
          </button>
        </div>

        <div className='min-h-0 flex-1 overflow-auto p-4 thin-scrollbar'>
          {branches.length === 0 ? (
            <div className='rounded-2xl bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400'>
              No cached branches for the current conversation. Open a chat with loaded messages first.
            </div>
          ) : (
            <table className='min-w-full border-separate border-spacing-0 text-left text-xs'>
              <thead className='sticky top-0 z-10 bg-white dark:bg-yBlack-900'>
                <tr>
                  <th className='sticky left-0 z-20 min-w-36 border-b border-neutral-200 bg-white px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500 dark:border-neutral-800 dark:bg-yBlack-900 dark:text-neutral-400'>
                    Branch
                  </th>
                  {columnIndexes.map(index => (
                    <th
                      key={index}
                      className='min-w-56 border-b border-neutral-200 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400'
                    >
                      Message {index + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {branches.map(branch => {
                  const current = isCurrentBranch(branch)
                  const streamMatches = getBranchStreamMatches(branch, conversationActiveStreams, conversationId)
                  const streaming = streamMatches.length > 0
                  return (
                    <tr
                      key={String(branch.leafMessageId)}
                      className={
                        streaming
                          ? 'bg-emerald-50/75 dark:bg-emerald-500/10'
                          : current
                            ? 'bg-amber-50/70 dark:bg-amber-500/5'
                            : ''
                      }
                    >
                      <td className='sticky left-0 z-10 border-b border-neutral-200 bg-inherit px-3 py-3 align-top dark:border-neutral-800'>
                        <div className='flex items-center gap-2'>
                          <span className='font-bold text-neutral-900 dark:text-neutral-100'>#{branch.branchIndex}</span>
                          {current ? (
                            <span className='rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white'>
                              current
                            </span>
                          ) : null}
                          {streaming ? (
                            <span className='rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white'>
                              streaming
                            </span>
                          ) : null}
                        </div>
                        <div className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400'>depth {branch.depth}</div>
                        <div className='mt-1 max-w-32 truncate font-mono text-[10px] text-neutral-400' title={String(branch.leafMessageId)}>
                          leaf {String(branch.leafMessageId)}
                        </div>
                        {streamMatches.length > 0 ? (
                          <div className='mt-2 space-y-1'>
                            {streamMatches.map(match => (
                              <div
                                key={match.stream.streamId}
                                className='rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-2 py-1 dark:border-emerald-500/25 dark:bg-emerald-500/10'
                                title={`stream ${match.stream.streamId} matched ${match.matchedMessageId}`}
                              >
                                <div className='flex flex-wrap items-center gap-1.5'>
                                  <span className='rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white'>
                                    {match.stream.status === 'waiting_for_tool' ? 'tool loop' : match.stream.status}
                                  </span>
                                  <span className={getAgentActivityBadgeClasses(match.stream.activityKind)}>
                                    {match.stream.activityLabel}
                                  </span>
                                </div>
                                <div className='mt-1 truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-200'>
                                  {summarizeAgentStreamId(match.stream.streamId)} · anchor {summarizeAgentStreamId(match.matchedMessageId)}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      {columnIndexes.map(index => {
                        const message = branch.messages[index]
                        return (
                          <td key={index} className='border-b border-neutral-200 px-3 py-3 align-top dark:border-neutral-800'>
                            {message ? (
                              <div className='rounded-2xl border border-neutral-200/80 bg-neutral-50/80 p-2 dark:border-neutral-800 dark:bg-neutral-950/35'>
                                <div className='flex items-center gap-2'>
                                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${messageRoleTone(message.role)}`}>
                                    {message.role}
                                  </span>
                                  <span className='truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400' title={String(message.id)}>
                                    {String(message.id)}
                                  </span>
                                </div>
                                <div className='mt-1 line-clamp-3 text-[11px] leading-4 text-neutral-700 dark:text-neutral-300' title={message.contentPreview}>
                                  {message.contentPreview}
                                </div>
                                <div className='mt-2 grid gap-1 text-[10px] text-neutral-400'>
                                  <span className='truncate' title={message.parentId == null ? 'root' : String(message.parentId)}>
                                    parent: {message.parentId == null ? 'root' : String(message.parentId)}
                                  </span>
                                  <span>children: {message.childrenIds.length}</span>
                                </div>
                              </div>
                            ) : (
                              <div className='text-center text-neutral-300 dark:text-neutral-700'>—</div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

const ParentMessageTicker = ({ text, reduceMotion }: { text: string | null | undefined; reduceMotion: boolean | null }) => {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const duration = 24

  if (reduceMotion) {
    return (
      <div className='mt-1 truncate rounded-full bg-white/70 px-2 py-1 text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:bg-neutral-950/30 dark:text-neutral-400'>
        {trimmed}
      </div>
    )
  }

  return (
    <div
      className='mt-1 overflow-hidden rounded-full bg-white/70 px-2 py-1 text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:bg-neutral-950/30 dark:text-neutral-400'
      style={{ maskImage: 'linear-gradient(90deg, transparent, black 10%, black 90%, transparent)' }}
      title={trimmed}
    >
      <motion.div
        className='flex w-max whitespace-nowrap'
        animate={{ x: ['0%', '-50%'] }}
        transition={{ duration, ease: 'linear', repeat: Infinity }}
      >
        <span className='pr-8'>{trimmed}</span>
        <span className='pr-8' aria-hidden='true'>
          {trimmed}
        </span>
      </motion.div>
    </div>
  )
}

export const RunningAgentsFloatingButton: React.FC<RunningAgentsFloatingButtonProps> = ({
  notes = [],
  className = '',
  onOpenApps,
  appsOpen = false,
}) => {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const shouldReduceMotion = useReducedMotion()
  const motionPreferences = useMotionPreferences(shouldReduceMotion)
  const { activeStreams, streamHistory } = useRunningAgentStreams(notes)
  const notifications = useAppSelector(state => state.ui.notifications)
  const currentConversationId = useAppSelector(selectCurrentConversationId)
  const currentPath = useAppSelector(selectCurrentPath)
  const branchDebugQuery = useConversationBranchDebugData(codexDevLogsEnabled ? currentConversationId : null)
  const [expanded, setExpanded] = useState(false)
  const [branchDebugOpen, setBranchDebugOpen] = useState(false)
  const [inlineNotification, setInlineNotification] = useState<UiNotification | null>(null)
  const seenNotificationIdsRef = useRef<Set<string>>(new Set())
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasActiveStreams = activeStreams.length > 0
  const hasErroredStream = activeStreams.some(stream => stream.hasError)
  const compactLabel = 'agents'
  const activeCountLabel = activeStreams.length > 1 ? `+${activeStreams.length - 1}` : null
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const floatingSurfaceBaseBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode)
    : undefined
  const floatingSurfaceBorder = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesCardBorder, isDarkMode), 0.5)
    : undefined
  const floatingSurfaceText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode)
    : undefined
  const floatingSurfaceMutedText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode)
    : undefined
  const floatingSectionTitleText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesTitleText, isDarkMode)
    : undefined
  const floatingAgentNameText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesAccentText, isDarkMode)
    : undefined
  const floatingAgentHistoryNameText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesListItemMetaText, isDarkMode)
    : undefined
  const floatingAccentBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesAccentBg, isDarkMode)
    : undefined
  const floatingAccentText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesAccentText, isDarkMode)
    : undefined
  const floatingBadgeBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeBg, isDarkMode)
    : undefined
  const floatingBadgeText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeText, isDarkMode)
    : undefined
  const floatingInnerBg = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode), 0.74)
    : undefined
  const floatingHoverBg = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode), 0.62)
    : undefined
  const floatingTintColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonBg, isDarkMode)
    : undefined
  const floatingActiveDotColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsProgressRunning, isDarkMode)
    : undefined
  const floatingIdleDotColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsProgressPending, isDarkMode)
    : undefined
  const floatingErrorDotColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsProgressFailed, isDarkMode)
    : undefined
  const floatingCompletedDotColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsProgressCompleted, isDarkMode)
    : undefined
  const floatingButtonBg = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode), 0.82)
    : undefined
  const floatingButtonBorder = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBorder, isDarkMode), 0.56)
    : undefined
  const floatingButtonText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode)
    : undefined
  const currentStatusDotColor = hasErroredStream
    ? floatingErrorDotColor
    : hasActiveStreams
      ? floatingActiveDotColor
      : floatingIdleDotColor
  const floatingShellStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        background: [
          floatingTintColor ? `radial-gradient(circle at 16% 0%, ${getTranslucentCssColor(floatingTintColor, 0.18)}, transparent 42%)` : null,
          floatingAccentBg ? `linear-gradient(135deg, ${getTranslucentCssColor(floatingAccentBg, 0.22)}, transparent 56%)` : null,
          floatingSurfaceBaseBg ? getTranslucentCssColor(floatingSurfaceBaseBg, 0.78) : null,
        ]
          .filter(Boolean)
          .join(', '),
        borderColor: floatingSurfaceBorder,
        color: floatingSurfaceText,
      }
    : undefined
  const floatingTopRowStyle: React.CSSProperties | undefined = customThemeEnabled
    ? ({ '--running-agents-floating-hover-bg': floatingHoverBg } as React.CSSProperties)
    : undefined
  const floatingDividerStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { borderColor: floatingSurfaceBorder }
    : undefined
  const floatingMutedTextStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: floatingSurfaceMutedText }
    : undefined
  const floatingPrimaryTextStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: floatingSurfaceText }
    : undefined
  const floatingSectionTitleStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: floatingSectionTitleText }
    : undefined
  const floatingAgentNameStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: floatingAgentNameText }
    : undefined
  const floatingAgentHistoryNameStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: floatingAgentHistoryNameText }
    : undefined
  const floatingStatusDotStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: currentStatusDotColor }
    : undefined
  const floatingActiveDotStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingActiveDotColor }
    : undefined
  const floatingCompletedDotStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingCompletedDotColor }
    : undefined
  const floatingErrorDotStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingErrorDotColor }
    : undefined
  const floatingErrorBadgeStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: floatingErrorDotColor ? getTranslucentCssColor(floatingErrorDotColor, 0.14) : undefined,
        color: floatingErrorDotColor,
      }
    : undefined
  const floatingBadgeStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingBadgeBg, color: floatingBadgeText }
    : undefined
  const floatingAccentBadgeStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingAccentBg, color: floatingAccentText }
    : undefined
  const floatingCardStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: floatingInnerBg, color: floatingSurfaceMutedText }
    : undefined
  const floatingRowStyle: React.CSSProperties | undefined = customThemeEnabled
    ? ({
        '--running-agents-row-hover-bg': floatingHoverBg,
        backgroundColor: floatingInnerBg,
      } as React.CSSProperties)
    : undefined
  const floatingControlButtonStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: floatingButtonBg,
        borderColor: floatingButtonBorder,
        color: floatingButtonText,
      }
    : undefined

  const statusTone = hasErroredStream
    ? 'bg-rose-500'
    : hasActiveStreams
      ? 'bg-emerald-500'
      : 'bg-neutral-400 dark:bg-neutral-500'

  const ariaLabel = useMemo(() => {
    if (inlineNotification) return inlineNotification.title
    if (activeStreams.length === 0) return 'Running agents: none active'
    return `Running agents: ${activeStreams.length} active`
  }, [activeStreams.length, inlineNotification])

  useEffect(() => {
    const activeIds = new Set(notifications.map(notification => notification.id))
    seenNotificationIdsRef.current.forEach(id => {
      if (!activeIds.has(id)) seenNotificationIdsRef.current.delete(id)
    })

    const nextNotification = notifications
      .filter(notification => !seenNotificationIdsRef.current.has(notification.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]

    if (!nextNotification) return

    seenNotificationIdsRef.current.add(nextNotification.id)
    setExpanded(false)
    setInlineNotification(nextNotification)

    if (notificationTimerRef.current) {
      clearTimeout(notificationTimerRef.current)
    }

    notificationTimerRef.current = setTimeout(() => {
      setInlineNotification(current => (current?.id === nextNotification.id ? null : current))
      notificationTimerRef.current = null
    }, 4200)
  }, [notifications])

  useEffect(() => {
    return () => {
      if (notificationTimerRef.current) {
        clearTimeout(notificationTimerRef.current)
      }
    }
  }, [])

  const navigateToNotification = (notification: UiNotification) => {
    if (notificationTimerRef.current) {
      clearTimeout(notificationTimerRef.current)
      notificationTimerRef.current = null
    }
    setInlineNotification(null)
    dispatch(uiActions.notificationDismissed(notification.id))
    navigate(getNotificationHref(notification))
  }

  const navigateToStream = (stream: AgentStreamListItem) => {
    const href = getStreamHref(stream)
    if (!href) return
    navigate(href)
    setExpanded(false)
  }

  const toggleExpanded = () => {
    if (inlineNotification) return
    setExpanded(value => !value)
  }

  const openBranchDebug = (event: React.MouseEvent) => {
    event.stopPropagation()
    setBranchDebugOpen(true)
  }

  return (
    <>
      <BranchDebugModal
        open={branchDebugOpen}
        data={branchDebugQuery.data}
        conversationId={currentConversationId}
        currentPath={currentPath}
        activeStreams={activeStreams}
        onClose={() => setBranchDebugOpen(false)}
      />
      <motion.div
      layout
      transition={motionPreferences.shellTransition}
      className={`fixed z-[1500] ${className}`}
      style={{ transformOrigin: 'bottom right' }}
    >
      <motion.div
        layout
        transition={motionPreferences.shellTransition}
        className='overflow-hidden rounded-[28px] border border-neutral-200/60 bg-white/75 text-neutral-800 shadow-[0_18px_55px_rgba(15,23,42,0.18)] backdrop-blur-2xl will-change-[width,height,transform] dark:border-neutral-700/55 dark:bg-yBlack-900/75 dark:text-neutral-100'
        style={floatingShellStyle}
      >
        <div className='relative'>
          <motion.div
            layout
            onClick={toggleExpanded}
            className={`relative flex w-full cursor-pointer items-center justify-between gap-1.5 p-1.5 outline-none transition-colors ${
              customThemeEnabled
                ? 'hover:bg-[var(--running-agents-floating-hover-bg)] dark:hover:bg-[var(--running-agents-floating-hover-bg)]'
                : 'hover:bg-neutral-100/45 dark:hover:bg-neutral-800/35'
            }`}
            style={floatingTopRowStyle}
          >
            <AnimatePresence mode='popLayout' initial={false}>
              {inlineNotification ? (
                <motion.button
                  key={`notification-${inlineNotification.id}`}
                  type='button'
                  layout
                  onClick={() => navigateToNotification(inlineNotification)}
                  className={`group flex min-h-11 max-w-[min(19rem,calc(100vw-6rem))] items-center gap-2 rounded-full px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                    customThemeEnabled
                      ? 'hover:bg-[var(--running-agents-floating-hover-bg)] dark:hover:bg-[var(--running-agents-floating-hover-bg)]'
                      : 'hover:bg-neutral-100/75 dark:hover:bg-neutral-800/70'
                  }`}
                  style={floatingTopRowStyle}
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 10, scale: 0.985 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.985 }}
                  transition={motionPreferences.contentTransition}
                  aria-label={inlineNotification.title}
                >
                  <span
                    className='relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200'
                    style={floatingAccentBadgeStyle}
                  >
                    <i className='bx bx-check text-sm lg:text-base' aria-hidden='true' />
                  </span>
                  <span className='min-w-0'>
                    <span
                      className='block truncate text-xs lg:text-sm font-semibold text-neutral-900 dark:text-neutral-100'
                      style={floatingPrimaryTextStyle}
                    >
                      {inlineNotification.title}
                    </span>
                    {inlineNotification.description ? (
                      <span
                        className='block truncate text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:text-neutral-400'
                        style={floatingMutedTextStyle}
                      >
                        {inlineNotification.description}
                      </span>
                    ) : null}
                  </span>
                </motion.button>
              ) : (
                <motion.button
                  key='agent-compact'
                  type='button'
                  layout
                  onClick={event => {
                    event.stopPropagation()
                    toggleExpanded()
                  }}
                  className={`group flex min-h-11 items-center gap-2 rounded-full px-3 py-2 text-sm lg:text-base font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                    customThemeEnabled
                      ? 'hover:bg-[var(--running-agents-floating-hover-bg)] dark:hover:bg-[var(--running-agents-floating-hover-bg)]'
                      : 'hover:bg-neutral-100/75 dark:hover:bg-neutral-800/70'
                  }`}
                  style={floatingTopRowStyle}
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: -8, scale: 0.985 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: -8, scale: 0.985 }}
                  transition={motionPreferences.contentTransition}
                  aria-label={ariaLabel}
                  aria-expanded={expanded}
                >
                  <span className='relative flex h-3.5 w-3.5 items-center justify-center' aria-hidden='true'>
                    <motion.span
                      className={`relative h-2.5 w-2.5 rounded-full ${customThemeEnabled ? '' : statusTone}`}
                      style={floatingStatusDotStyle}
                      animate={
                        hasActiveStreams && !shouldReduceMotion
                          ? { scale: [1, 1.16, 1], opacity: [1, 0.68, 1] }
                          : { scale: 1, opacity: 1 }
                      }
                      transition={{ duration: 1.6, repeat: hasActiveStreams && !shouldReduceMotion ? Infinity : 0, ease: 'easeInOut' }}
                    />
                  </span>

                  <motion.span layout className='whitespace-nowrap tracking-[-0.01em]' style={floatingPrimaryTextStyle}>
                    {compactLabel}
                  </motion.span>

                  <AnimatePresence mode='popLayout' initial={false}>
                    {activeCountLabel ? (
                      <motion.span
                        layout
                        key='count'
                        initial={{ opacity: 0, scale: 0.75, x: -4 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.75, x: -4 }}
                        transition={motionPreferences.contentTransition}
                        className='rounded-full bg-neutral-900/90 px-1.5 py-0.5 text-[10px] lg:text-[11px] font-bold leading-none text-white dark:bg-neutral-100 dark:text-neutral-900'
                        style={floatingBadgeStyle}
                      >
                        {activeCountLabel}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </motion.button>
              )}
            </AnimatePresence>

            <AnimatePresence initial={false} mode='popLayout'>
              {expanded ? (
                <motion.div
                  key='expanded-actions'
                  layout
                  className='flex shrink-0 items-center gap-1.5'
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, x: 8 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, x: 8 }}
                  transition={motionPreferences.contentTransition}
                >
                  {codexDevLogsEnabled ? (
                    <motion.button
                      key='branch-debug-button'
                      type='button'
                      layout
                      onClick={openBranchDebug}
                      className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-200/80 bg-amber-50/90 text-amber-700 shadow-sm transition-colors duration-150 hover:bg-amber-100 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20'
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, x: 8 }}
                      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, x: 8 }}
                      transition={motionPreferences.contentTransition}
                      aria-label='Open branch diagnostics'
                      title='Open branch diagnostics'
                    >
                      <motion.i
                        className='bx bx-git-branch text-lg'
                        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, rotate: -8 }}
                        animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: 0 }}
                        transition={motionPreferences.feedbackTransition}
                        aria-hidden='true'
                      />
                    </motion.button>
                  ) : null}
                  <motion.button
                    key='apps-expand-button'
                  type='button'
                  layout
                  onClick={event => {
                    event.stopPropagation()
                    onOpenApps()
                  }}
                  className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-200/70 bg-neutral-50/85 text-neutral-700 shadow-sm transition-colors duration-150 hover:bg-white hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 dark:border-neutral-700/70 dark:bg-neutral-900/80 dark:text-neutral-200 dark:hover:bg-neutral-800'
                  style={floatingControlButtonStyle}
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, x: 8 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, x: 8 }}
                  transition={motionPreferences.contentTransition}
                  aria-label={appsOpen ? 'Close apps modal' : 'Open apps modal'}
                  title={appsOpen ? 'Close apps' : 'Open apps'}
                >
                  <motion.i
                    key={appsOpen ? 'apps-close' : 'apps-expand'}
                    className={`bx ${appsOpen ? 'bx-x' : 'bx-expand-alt'} text-lg`}
                    initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, rotate: -8 }}
                    animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: 0 }}
                    transition={motionPreferences.feedbackTransition}
                    aria-hidden='true'
                  />
                  </motion.button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>

          <AnimatePresence initial={false} mode='popLayout'>
            {expanded && (
              <motion.div
                key='details-shell'
                initial={shouldReduceMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0 }}
                animate={shouldReduceMotion ? { opacity: 1, height: 'auto' } : { opacity: 1, height: 'auto' }}
                exit={shouldReduceMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0, transition: motionPreferences.shellTransition }}
                transition={motionPreferences.shellTransition}
                className='w-[min(22rem,calc(100vw-2rem))] overflow-hidden border-t border-neutral-200/70 dark:border-neutral-800/80'
                style={floatingDividerStyle}
              >
                <motion.div
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
                  transition={motionPreferences.contentTransition}
                  className='px-2 pb-2 pt-1'
                >
                <div className='flex items-center justify-between px-2 py-2'>
                  <div className='flex items-center gap-2'>
                    <div
                      className='text-[11px] lg:text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400'
                      style={floatingSectionTitleStyle}
                    >
                      Running agents
                    </div>
                    <span
                      className='flex items-center gap-1.5 rounded-full bg-neutral-100/80 px-2 py-0.5 text-[10px] lg:text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800/80 dark:text-neutral-300'
                      style={floatingCardStyle}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${customThemeEnabled ? '' : statusTone}`}
                        style={floatingStatusDotStyle}
                        aria-hidden='true'
                      />
                      {activeStreams.length}
                    </span>
                  </div>
                </div>

                {activeStreams.length === 0 ? (
                  <div
                    className='rounded-2xl bg-neutral-50/80 px-3 py-3 text-xs lg:text-sm text-neutral-500 dark:bg-neutral-900/50 dark:text-neutral-400'
                    style={floatingCardStyle}
                  >
                    Agents are idle. New running streams will appear here instantly.
                  </div>
                ) : (
                  <div className='max-h-72 space-y-1.5 overflow-y-auto pr-1 thin-scrollbar'>
                    {activeStreams.map(stream => {
                      const href = getStreamHref(stream)
                      return (
                        <motion.button
                          key={stream.streamId}
                          type='button'
                          layout
                          onClick={() => navigateToStream(stream)}
                          disabled={!href}
                          className={`group w-full rounded-2xl bg-neutral-50/80 px-3 py-2.5 text-left transition disabled:cursor-default disabled:opacity-60 ${
                            customThemeEnabled
                              ? 'hover:bg-[var(--running-agents-row-hover-bg)] dark:hover:bg-[var(--running-agents-row-hover-bg)]'
                              : 'hover:bg-neutral-100/90 dark:bg-neutral-900/45 dark:hover:bg-neutral-800/70'
                          }`}
                          style={floatingRowStyle}
                          transition={motionPreferences.contentTransition}
                          whileHover={shouldReduceMotion ? undefined : { scale: 1.004 }}
                          whileTap={shouldReduceMotion ? undefined : { scale: 0.996 }}
                        >
                          <div className='flex items-start justify-between gap-3'>
                            <div className='min-w-0 flex-1'>
                              <div className='flex min-w-0 items-center gap-2'>
                                <span
                                  className='shrink-0 text-[11px] lg:text-xs font-bold text-emerald-600 dark:text-emerald-300'
                                  style={floatingAgentNameStyle}
                                >
                                  {stream.displayName}
                                </span>
                                <span className='shrink-0 text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:text-neutral-400'
                                  style={floatingMutedTextStyle}>
                                  {formatAgentTime(stream.createdAt)}
                                </span>
                                <span
                                  className='truncate text-[12px] lg:text-sm font-semibold text-neutral-900 dark:text-neutral-100'
                                  style={floatingPrimaryTextStyle}
                                >
                                  {stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`}
                                </span>
                              </div>
                              <ParentMessageTicker text={stream.parentMessageText} reduceMotion={shouldReduceMotion} />
                              <div className='mt-1 flex flex-wrap items-center gap-1.5 text-[11px] lg:text-xs'>
                                <span className='relative flex h-4 w-4 items-center justify-center' aria-label='Agent stream active'>
                                  <motion.span
                                    className='h-2.5 w-2.5 rounded-full bg-emerald-500'
                                    style={floatingActiveDotStyle}
                                    animate={shouldReduceMotion ? { scale: 1, opacity: 1 } : { scale: [1, 1.16, 1], opacity: [1, 0.68, 1] }}
                                    transition={{ duration: 1.6, repeat: shouldReduceMotion ? 0 : Infinity, ease: 'easeInOut' }}
                                  />
                                </span>
                                {stream.hasError ? (
                                  <span
                                    className='rounded-full bg-rose-100 px-2 py-0.5 text-[10px] lg:text-[11px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200'
                                    style={floatingErrorBadgeStyle}
                                  >
                                    error
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className='shrink-0 text-right'>
                              <i
                                className='bx bx-right-arrow-alt text-base text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-neutral-500'
                                aria-hidden='true'
                              />
                            </div>
                          </div>
                        </motion.button>
                      )
                    })}
                  </div>
                )}

                <div className='mt-3 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/80' style={floatingDividerStyle}>
                  <div className='flex items-center justify-between px-2 pb-2'>
                    <div
                      className='text-[11px] lg:text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400'
                      style={floatingSectionTitleStyle}
                    >
                      History
                    </div>
                    {streamHistory.length > 0 ? (
                      <div className='text-[10px] lg:text-[11px] text-neutral-500 dark:text-neutral-400' style={floatingMutedTextStyle}>
                        last {streamHistory.length}
                      </div>
                    ) : null}
                  </div>

                  {streamHistory.length === 0 ? (
                    <div
                      className='rounded-2xl bg-neutral-50/70 px-3 py-2.5 text-xs lg:text-sm text-neutral-500 dark:bg-neutral-900/40 dark:text-neutral-400'
                      style={floatingCardStyle}
                    >
                      Completed streams will appear here.
                    </div>
                  ) : (
                    <div className='max-h-56 space-y-1.5 overflow-y-auto pr-1 thin-scrollbar'>
                      {streamHistory.map(stream => {
                        const href = getStreamHref(stream)
                        return (
                          <motion.button
                            key={`history-${stream.streamId}`}
                            type='button'
                            layout
                            onClick={() => navigateToStream(stream)}
                            disabled={!href}
                            className={`group w-full rounded-2xl bg-stone-50/70 px-3 py-2.5 text-left opacity-90 transition hover:opacity-100 disabled:cursor-default disabled:opacity-60 ${
                              customThemeEnabled
                                ? 'hover:bg-[var(--running-agents-row-hover-bg)] dark:hover:bg-[var(--running-agents-row-hover-bg)]'
                                : 'hover:bg-neutral-100/90 dark:bg-neutral-900/35 dark:hover:bg-neutral-800/65'
                            }`}
                            style={floatingRowStyle}
                            transition={motionPreferences.contentTransition}
                            whileHover={shouldReduceMotion ? undefined : { scale: 1.004 }}
                            whileTap={shouldReduceMotion ? undefined : { scale: 0.996 }}
                          >
                            <div className='flex items-start justify-between gap-3'>
                              <div className='min-w-0 flex-1'>
                                <div className='flex min-w-0 items-center gap-2'>
                                  <span
                                    className='shrink-0 text-[11px] lg:text-xs font-bold text-neutral-500 dark:text-neutral-400'
                                    style={floatingAgentHistoryNameStyle}
                                  >
                                    {stream.displayName}
                                  </span>
                                  <span className='shrink-0 text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:text-neutral-400'
                                  style={floatingMutedTextStyle}>
                                    {formatAgentTime(stream.completedAt || stream.createdAt)}
                                  </span>
                                  <span
                                    className='truncate text-[12px] lg:text-sm font-semibold text-neutral-800 dark:text-neutral-100'
                                    style={floatingPrimaryTextStyle}
                                  >
                                    {stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`}
                                  </span>
                                </div>
                                <ParentMessageTicker text={stream.parentMessageText} reduceMotion={shouldReduceMotion} />
                                <div className='mt-1 flex flex-wrap items-center gap-1.5 text-[11px] lg:text-xs'>
                                  <span
                                    className={`h-2.5 w-2.5 rounded-full ${customThemeEnabled ? '' : stream.hasError ? 'bg-rose-500' : 'bg-emerald-500'}`}
                                    style={stream.hasError ? floatingErrorDotStyle : floatingCompletedDotStyle}
                                    aria-label={stream.hasError ? 'Agent stream ended with error' : 'Agent stream completed'}
                                  />
                                  {stream.hasError ? (
                                    <span
                                      className='rounded-full bg-rose-100 px-2 py-0.5 text-[10px] lg:text-[11px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200'
                                      style={floatingErrorBadgeStyle}
                                    >
                                      ended with error
                                    </span>
                                  ) : (
                                    <span
                                      className='rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] lg:text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                                      style={floatingBadgeStyle}
                                    >
                                      completed
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </motion.button>
                        )
                      })}
                    </div>
                  )}
                </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
    </>
  )
}
