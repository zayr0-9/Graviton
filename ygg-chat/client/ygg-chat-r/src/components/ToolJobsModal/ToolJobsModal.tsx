import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, formatDistance } from 'date-fns'
import React, { useEffect, useMemo, useState } from 'react'
import type { Conversation } from '../../features/conversations/conversationTypes'
import { useJobStats, useToolJobs } from '../../hooks/useToolJobs'
import type { PaginatedConversationsResponse } from '../../hooks/useQueries'
import { Job, toolJobManager } from '../../services/ToolJobManager'
import { Button } from '../Button/button'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

type ToolJobsModalProps = {
  isOpen: boolean
  onClose: () => void
}

type JobDetailsModalProps = {
  job: Job | null
  conversationTitle?: string
  isOpen: boolean
  onClose: () => void
}

const formatElapsedTime = (startedAt: string | null): string => {
  if (!startedAt) return '—'
  return formatDistance(new Date(startedAt), new Date(), { includeSeconds: true })
}

type ToolJobsThemeColors = {
  enabled: boolean
  modalBackdrop: string
  modalBg: string
  modalBorder: string
  panelBg: string
  panelBorder: string
  primaryText: string
  secondaryText: string
  mutedText: string
  codeBg: string
  codeText: string
  errorBg: string
  errorBorder: string
  errorText: string
  liveBadgeBg: string
  liveBadgeText: string
  liveDot: string
  progressTrack: string
  progress: {
    pending: string
    running: string
    completed: string
    failed: string
  }
  status: {
    pending: { bg: string; text: string }
    running: { bg: string; text: string }
    completed: { bg: string; text: string }
    failed: { bg: string; text: string }
    cancelled: { bg: string; text: string }
    activeWorkers: { bg: string; text: string }
  }
}

const useToolJobsThemeColors = (): ToolJobsThemeColors => {
  const { theme: customTheme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const pick = (customColor: { light: string; dark: string }, fallback: string) =>
    enabled ? getThemeModeColor(customColor, isDarkMode) : fallback

  return {
    enabled,
    modalBackdrop: pick(customTheme.colors.toolJobsModalBackdrop, 'rgba(0, 0, 0, 0.6)'),
    modalBg: pick(customTheme.colors.toolJobsModalBg, isDarkMode ? 'oklch(20.5% 0 0)' : '#ffffff'),
    modalBorder: pick(customTheme.colors.toolJobsModalBorder, isDarkMode ? '#262626' : '#e5e5e5'),
    panelBg: pick(customTheme.colors.toolJobsPanelBg, isDarkMode ? 'rgba(23, 23, 23, 0.6)' : 'rgba(250, 250, 250, 0.8)'),
    panelBorder: pick(customTheme.colors.toolJobsPanelBorder, isDarkMode ? '#262626' : '#e5e5e5'),
    primaryText: pick(customTheme.colors.toolJobsPrimaryText, isDarkMode ? '#fafafa' : '#171717'),
    secondaryText: pick(customTheme.colors.toolJobsSecondaryText, isDarkMode ? '#a3a3a3' : '#525252'),
    mutedText: pick(customTheme.colors.toolJobsMutedText, isDarkMode ? '#a3a3a3' : '#737373'),
    codeBg: pick(customTheme.colors.toolJobsCodeBg, isDarkMode ? '#262626' : '#f5f5f5'),
    codeText: pick(customTheme.colors.toolJobsCodeText, isDarkMode ? '#e5e5e5' : '#262626'),
    errorBg: pick(customTheme.colors.toolJobsErrorBg, isDarkMode ? 'rgba(127, 29, 29, 0.2)' : 'rgba(255, 241, 242, 0.85)'),
    errorBorder: pick(customTheme.colors.toolJobsErrorBorder, isDarkMode ? '#9f1239' : '#fecdd3'),
    errorText: pick(customTheme.colors.toolJobsErrorText, isDarkMode ? '#fda4af' : '#be123c'),
    liveBadgeBg: pick(customTheme.colors.toolJobsLiveBadgeBg, isDarkMode ? 'rgba(6, 78, 59, 0.3)' : 'rgba(209, 250, 229, 1)'),
    liveBadgeText: pick(customTheme.colors.toolJobsLiveBadgeText, isDarkMode ? '#a7f3d0' : '#047857'),
    liveDot: pick(customTheme.colors.toolJobsLiveDot, isDarkMode ? '#34d399' : '#10b981'),
    progressTrack: pick(customTheme.colors.toolJobsProgressTrack, isDarkMode ? '#262626' : '#e5e5e5'),
    progress: {
      pending: pick(customTheme.colors.toolJobsProgressPending, '#f59e0b'),
      running: pick(customTheme.colors.toolJobsProgressRunning, isDarkMode ? '#60a5fa' : '#3b82f6'),
      completed: pick(customTheme.colors.toolJobsProgressCompleted, isDarkMode ? '#34d399' : '#10b981'),
      failed: pick(customTheme.colors.toolJobsProgressFailed, isDarkMode ? '#fb7185' : '#f43f5e'),
    },
    status: {
      pending: {
        bg: pick(customTheme.colors.toolJobsStatusPendingBg, isDarkMode ? 'rgba(120, 53, 15, 0.35)' : '#fef3c7'),
        text: pick(customTheme.colors.toolJobsStatusPendingText, isDarkMode ? '#fde68a' : '#b45309'),
      },
      running: {
        bg: pick(customTheme.colors.toolJobsStatusRunningBg, isDarkMode ? 'rgba(30, 58, 138, 0.35)' : '#dbeafe'),
        text: pick(customTheme.colors.toolJobsStatusRunningText, isDarkMode ? '#bfdbfe' : '#1d4ed8'),
      },
      completed: {
        bg: pick(customTheme.colors.toolJobsStatusCompletedBg, isDarkMode ? 'rgba(6, 78, 59, 0.35)' : '#d1fae5'),
        text: pick(customTheme.colors.toolJobsStatusCompletedText, isDarkMode ? '#a7f3d0' : '#047857'),
      },
      failed: {
        bg: pick(customTheme.colors.toolJobsStatusFailedBg, isDarkMode ? 'rgba(136, 19, 55, 0.35)' : '#ffe4e6'),
        text: pick(customTheme.colors.toolJobsStatusFailedText, isDarkMode ? '#fecdd3' : '#be123c'),
      },
      cancelled: {
        bg: pick(customTheme.colors.toolJobsStatusCancelledBg, isDarkMode ? '#262626' : '#e5e5e5'),
        text: pick(customTheme.colors.toolJobsStatusCancelledText, isDarkMode ? '#e5e5e5' : '#404040'),
      },
      activeWorkers: {
        bg: pick(customTheme.colors.toolJobsStatusActiveWorkersBg, isDarkMode ? 'rgba(30, 58, 138, 0.35)' : '#dbeafe'),
        text: pick(customTheme.colors.toolJobsStatusActiveWorkersText, isDarkMode ? '#bfdbfe' : '#1d4ed8'),
      },
    },
  }
}

const resolveStatusTheme = (status: string, themeColors: ToolJobsThemeColors) => {
  switch (status) {
    case 'running':
      return themeColors.status.running
    case 'completed':
      return themeColors.status.completed
    case 'failed':
      return themeColors.status.failed
    case 'cancelled':
      return themeColors.status.cancelled
    case 'pending':
    default:
      return themeColors.status.pending
  }
}

const JobDetailsModal: React.FC<JobDetailsModalProps> = ({ job, conversationTitle, isOpen, onClose }) => {
  const [elapsedTime, setElapsedTime] = useState<string>('—')
  const themeColors = useToolJobsThemeColors()

  // Update elapsed time every second for running jobs
  useEffect(() => {
    if (!job?.startedAt || job.completedAt) {
      setElapsedTime(job?.startedAt ? formatElapsedTime(job.startedAt) : '—')
      return
    }

    const updateElapsed = () => setElapsedTime(formatElapsedTime(job.startedAt))
    updateElapsed()
    const interval = setInterval(updateElapsed, 1000)
    return () => clearInterval(interval)
  }, [job?.startedAt, job?.completedAt])

  if (!isOpen || !job) return null

  const statusColor = resolveStatusTheme(job.status, themeColors)

  return (
    <div
      className='fixed inset-0 z-[60] flex items-center justify-center backdrop-blur-sm animate-in fade-in duration-200'
      style={{ backgroundColor: themeColors.modalBackdrop }}
    >
      <div
        className='rounded-2xl shadow-2xl border p-6 w-full max-w-3xl mx-4 max-h-[85vh] overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 duration-300'
        style={{ backgroundColor: themeColors.modalBg, borderColor: themeColors.modalBorder }}
      >
        <div className='flex items-start justify-between gap-4 mb-4'>
          <div>
            <h3 className='text-xl font-semibold flex items-center gap-2' style={{ color: themeColors.primaryText }}>
              <i className='bx bx-detail text-blue-500' aria-hidden='true'></i>
              Job Details
            </h3>
            <p className='text-sm mt-1' style={{ color: themeColors.secondaryText }}>
              {job.toolName}
            </p>
          </div>
          <Button variant='outline2' size='medium' onClick={onClose}>
            <i className='bx bx-x text-lg' aria-hidden='true'></i>
            Close
          </Button>
        </div>

        <div className='overflow-y-auto flex-1 space-y-4 pr-1'>
          {/* Status & Priority */}
          <div className='grid grid-cols-2 gap-3'>
            <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
              <div className='text-xs mb-1'
                style={{ color: themeColors.mutedText }}>Status</div>
              <span
                className='px-2 py-1 rounded-full text-xs font-medium'
                style={{ backgroundColor: statusColor.bg, color: statusColor.text }}
              >
                {job.status}
              </span>
            </div>
            <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
              <div className='text-xs mb-1'
                style={{ color: themeColors.mutedText }}>Priority</div>
              <span className='text-sm font-medium text-neutral-900 dark:text-neutral-50'>{job.priority}</span>
            </div>
          </div>

          {/* Time Info */}
          <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
            <div className='text-xs mb-2'
              style={{ color: themeColors.mutedText }}>Timing</div>
            <div className='grid grid-cols-2 gap-2 text-sm'>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Created: </span>
                <span className='text-neutral-900 dark:text-neutral-50'>
                  {job.createdAt ? new Date(job.createdAt).toLocaleString() : '—'}
                </span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Started: </span>
                <span className='text-neutral-900 dark:text-neutral-50'>
                  {job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}
                </span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Completed: </span>
                <span className='text-neutral-900 dark:text-neutral-50'>
                  {job.completedAt ? new Date(job.completedAt).toLocaleString() : '—'}
                </span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Elapsed: </span>
                <span className={`font-medium ${job.status === 'running' ? 'text-blue-500' : 'text-neutral-900 dark:text-neutral-50'}`}>
                  {elapsedTime}
                </span>
              </div>
            </div>
          </div>

          {/* Conversation & Message */}
          <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
            <div className='text-xs mb-2'
              style={{ color: themeColors.mutedText }}>Context</div>
            <div className='space-y-2 text-sm'>
              {conversationTitle && (
                <div>
                  <span className='text-neutral-600 dark:text-neutral-400'>Conversation: </span>
                  <span className='text-neutral-900 dark:text-neutral-50'>{conversationTitle}</span>
                </div>
              )}
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Conversation ID: </span>
                <span className='text-neutral-900 dark:text-neutral-50 font-mono text-xs'>{job.conversationId || '—'}</span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Message ID: </span>
                <span className='text-neutral-900 dark:text-neutral-50 font-mono text-xs'>{job.messageId || '—'}</span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Stream ID: </span>
                <span className='text-neutral-900 dark:text-neutral-50 font-mono text-xs'>{job.streamId || '—'}</span>
              </div>
            </div>
          </div>

          {/* Tool Input */}
          <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
            <div className='text-xs mb-2 flex items-center gap-1'
              style={{ color: themeColors.mutedText }}>
              <i className='bx bx-right-arrow-alt' aria-hidden='true'></i>
              Tool Input (Args)
            </div>
            <pre className='text-xs rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto'
              style={{ backgroundColor: themeColors.codeBg, color: themeColors.codeText }}>
              {JSON.stringify(job.args, null, 2)}
            </pre>
          </div>

          {/* Tool Output */}
          <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
            <div className='text-xs mb-2 flex items-center gap-1'
              style={{ color: themeColors.mutedText }}>
              <i className='bx bx-left-arrow-alt' aria-hidden='true'></i>
              Tool Output (Result)
            </div>
            {job.result !== null ? (
              <pre className='text-xs rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto'
              style={{ backgroundColor: themeColors.codeBg, color: themeColors.codeText }}>
                {typeof job.result === 'string' ? job.result : JSON.stringify(job.result, null, 2)}
              </pre>
            ) : (
              <div className='text-sm text-neutral-500 dark:text-neutral-400 italic'>
                {job.status === 'running' || job.status === 'pending' ? 'Job still in progress...' : 'No result'}
              </div>
            )}
          </div>

          {/* Error (if any) */}
          {job.error && (
            <div
              className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.errorBg, borderColor: themeColors.errorBorder }}
            >
              <div className='text-xs mb-2 flex items-center gap-1' style={{ color: themeColors.errorText }}>
                <i className='bx bx-error-circle' aria-hidden='true'></i>
                Error
              </div>
              <pre
                className='text-xs rounded-lg p-3 overflow-x-auto max-h-32 overflow-y-auto'
                style={{ backgroundColor: themeColors.codeBg, color: themeColors.errorText }}
              >
                {job.error}
              </pre>
            </div>
          )}

          {/* Progress */}
          {(job.status === 'running' || job.status === 'pending') && (
            <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
              <div className='text-xs mb-2'
              style={{ color: themeColors.mutedText }}>Progress</div>
              <div className='flex items-center gap-3'>
                <div className='flex-1'>
                  <ProgressBar value={job.progress ?? 0} status={job.status} themeColors={themeColors} />
                </div>
                <span className='text-sm font-medium text-neutral-900 dark:text-neutral-50'>{job.progress ?? 0}%</span>
              </div>
              {job.progressMessage && (
                <div className='text-xs text-neutral-600 dark:text-neutral-300 mt-2'>{job.progressMessage}</div>
              )}
            </div>
          )}

          {/* Job ID & Metadata */}
          <div className='rounded-lg border p-3'
              style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}>
            <div className='text-xs mb-2'
              style={{ color: themeColors.mutedText }}>Identifiers</div>
            <div className='space-y-1 text-sm'>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Job ID: </span>
                <span className='text-neutral-900 dark:text-neutral-50 font-mono text-xs'>{job.id}</span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Retries: </span>
                <span className='text-neutral-900 dark:text-neutral-50'>
                  {job.retriesRemaining}/{job.retries}
                </span>
              </div>
              <div>
                <span className='text-neutral-600 dark:text-neutral-400'>Timeout: </span>
                <span className='text-neutral-900 dark:text-neutral-50'>{job.timeoutMs}ms</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const ProgressBar: React.FC<{ value: number; status: string; themeColors: ToolJobsThemeColors }> = ({
  value,
  status,
  themeColors,
}) => {
  const pct = Math.min(100, Math.max(0, value || 0))
  const color =
    status === 'failed'
      ? themeColors.progress.failed
      : status === 'completed'
        ? themeColors.progress.completed
        : status === 'running'
          ? themeColors.progress.running
          : themeColors.progress.pending

  return (
    <div className='w-full h-2 rounded-full overflow-hidden' style={{ backgroundColor: themeColors.progressTrack }}>
      <div className='h-full transition-all duration-200' style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  )
}

export const ToolJobsModal: React.FC<ToolJobsModalProps> = ({ isOpen, onClose }) => {
  const queryClient = useQueryClient()
  const themeColors = useToolJobsThemeColors()
  const { jobs, loading, error } = useToolJobs()
  const { stats, loading: statsLoading } = useJobStats()
  const [cancelling, setCancelling] = useState<Set<string>>(new Set())
  const [selectedJobDetails, setSelectedJobDetails] = useState<Job | null>(null)
  const [conversationTitle, setConversationTitle] = useState<string | undefined>(undefined)
  const [detailsLoading, setDetailsLoading] = useState(false)

  // Look up conversation title from React Query cache
  const findConversationTitle = (conversationId: string | null): string | undefined => {
    if (!conversationId) return undefined

    // Search all cached conversation lists
    const allConversationQueries = queryClient.getQueriesData<
      Conversation[] | { pages: PaginatedConversationsResponse[] }
    >({ queryKey: ['conversations'] })

    for (const [, data] of allConversationQueries) {
      let conversations: Conversation[] = []

      // Handle both flat arrays and infinite query pages
      if (Array.isArray(data)) {
        conversations = data
      } else if (data && typeof data === 'object' && 'pages' in data) {
        conversations = data.pages.flatMap(page => page.conversations)
      }

      const match = conversations.find(c => String(c.id) === String(conversationId))
      if (match?.title) {
        return match.title
      }
    }

    return undefined
  }

  const handleViewDetails = async (jobId: string) => {
    setDetailsLoading(true)
    try {
      const fullJob = await toolJobManager.getJob(jobId)
      setSelectedJobDetails(fullJob)
      // Look up conversation title
      const title = findConversationTitle(fullJob?.conversationId ?? null)
      setConversationTitle(title)
    } catch (err) {
      console.error('[ToolJobsModal] Failed to fetch job details:', err)
    } finally {
      setDetailsLoading(false)
    }
  }

  const handleCloseDetails = () => {
    setSelectedJobDetails(null)
    setConversationTitle(undefined)
  }

  const handleCancel = async (jobId: string) => {
    setCancelling(prev => new Set(prev).add(jobId))
    try {
      await toolJobManager.cancelJob(jobId)
    } catch (err) {
      console.error('[ToolJobsModal] Cancel failed:', err)
    } finally {
      setCancelling(prev => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  const runningJobs = useMemo(() => jobs.filter(j => j.status === 'running' || j.status === 'pending'), [jobs])

  if (!isOpen) return null

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm animate-in fade-in duration-200'
      style={{ backgroundColor: themeColors.modalBackdrop }}
    >
      <div
        className='rounded-2xl shadow-2xl border p-6 w-full max-w-5xl mx-4 animate-in slide-in-from-bottom-4 duration-300'
        style={{ backgroundColor: themeColors.modalBg, borderColor: themeColors.modalBorder }}
      >
        <div className='flex items-start justify-between gap-4 mb-4'>
          <div>
            <h2 className='text-2xl font-semibold' style={{ color: themeColors.primaryText }}>
              Tool Jobs
            </h2>
            <p className='text-sm' style={{ color: themeColors.secondaryText }}>
              Live status from the orchestrator
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <div
              className='flex items-center gap-1 text-xs px-2 py-1 rounded-full'
              style={{ backgroundColor: themeColors.liveBadgeBg, color: themeColors.liveBadgeText }}
            >
              <span
                className='w-2 h-2 rounded-full animate-pulse'
                style={{ backgroundColor: themeColors.liveDot }}
                aria-hidden='true'
              ></span>
              Live
            </div>
            <Button variant='outline2' size='medium' onClick={onClose}>
              <i className='bx bx-x text-lg' aria-hidden='true'></i>
              Close
            </Button>
          </div>
        </div>

        <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-5'>
          {['pending', 'running', 'completed', 'failed'].map(key => {
            const value = statsLoading ? '—' : (stats?.[key as keyof typeof stats] ?? 0)
            const labels: Record<string, string> = {
              pending: 'Pending',
              running: 'Running',
              completed: 'Completed',
              failed: 'Failed',
            }
            const badge = resolveStatusTheme(key, themeColors)
            return (
              <div
                key={key}
                className='rounded-xl border p-3 flex items-center gap-3'
                style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}
              >
                <div
                  className='px-3 py-1 rounded-full text-xs font-medium'
                  style={{ backgroundColor: badge.bg, color: badge.text }}
                >
                  {labels[key]}
                </div>
                <div className='text-xl font-semibold' style={{ color: themeColors.primaryText }}>
                  {value}
                </div>
              </div>
            )
          })}
          <div
            className='rounded-xl border p-3 flex items-center gap-3'
            style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}
          >
            <div
              className='px-3 py-1 rounded-full text-xs font-medium'
              style={{
                backgroundColor: themeColors.status.activeWorkers.bg,
                color: themeColors.status.activeWorkers.text,
              }}
            >
              Active workers
            </div>
            <div className='text-xl font-semibold' style={{ color: themeColors.primaryText }}>
              {statsLoading ? '—' : (stats?.activeWorkers ?? 0)}
            </div>
          </div>
        </div>

        {error ? <div className='mb-4 text-sm text-rose-500'>Failed to load jobs: {error.message}</div> : null}

        {loading && jobs.length === 0 ? (
          <div className='flex items-center gap-2 text-sm mb-2' style={{ color: themeColors.secondaryText }}>
            <i className='bx bx-loader-alt bx-spin text-lg' aria-hidden='true'></i>
            Loading jobs...
          </div>
        ) : null}

        <div className='space-y-3 max-h-[60vh] overflow-y-auto pr-1'>
          {jobs.length === 0 ? (
            <div className='text-sm flex items-center gap-2' style={{ color: themeColors.secondaryText }}>
              <i className='bx bx-check-circle text-lg text-emerald-500' aria-hidden='true'></i>
              No jobs yet. Trigger a tool to see it here.
            </div>
          ) : (
            jobs.map(job => {
              const color = resolveStatusTheme(job.status, themeColors)
              const started = job.startedAt ? formatDistanceToNow(new Date(job.startedAt), { addSuffix: true }) : '—'
              const created = job.createdAt ? formatDistanceToNow(new Date(job.createdAt), { addSuffix: true }) : '—'
              const duration =
                job.startedAt && job.completedAt
                  ? `${Math.max(0, Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000))}s`
                  : job.startedAt && !job.completedAt
                    ? 'In progress'
                    : '—'
              const canCancel = !['completed', 'failed', 'cancelled'].includes(job.status)

              return (
                <div
                  key={job.id}
                  className='rounded-xl border p-4 shadow-sm'
                  style={{ backgroundColor: themeColors.panelBg, borderColor: themeColors.panelBorder }}
                >
                  <div className='flex flex-wrap items-start justify-between gap-3'>
                    <div className='flex flex-col gap-1'>
                      <div className='flex items-center gap-2'>
                        <span
                          className='px-2 py-1 rounded-full text-xs font-medium'
                          style={{ backgroundColor: color.bg, color: color.text }}
                        >
                          {job.status}
                        </span>
                        <span className='text-sm' style={{ color: themeColors.secondaryText }}>
                          Priority {job.priority}
                        </span>
                      </div>
                      <div className='text-base font-semibold' style={{ color: themeColors.primaryText }}>
                        {job.toolName}
                      </div>
                      <div className='text-xs' style={{ color: themeColors.mutedText }}>
                        Created {created} {started !== '—' ? `· Started ${started}` : ''} · {duration}
                      </div>
                      {job.progressMessage ? (
                        <div className='text-xs' style={{ color: themeColors.secondaryText }}>
                          {job.progressMessage}
                        </div>
                      ) : null}
                    </div>
                    <div
                      className='flex flex-col items-end gap-2 text-xs break-all'
                      style={{ color: themeColors.mutedText }}
                    >
                      <div className='text-right'>
                        <div>ID: {job.id}</div>
                        {job.conversationId ? <div>Conversation: {job.conversationId}</div> : null}
                        {job.error ? <div className='text-rose-500 mt-1'>Error: {job.error}</div> : null}
                      </div>
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='outline2'
                          size='small'
                          className='px-3'
                          disabled={detailsLoading}
                          onClick={() => handleViewDetails(job.id)}
                        >
                          <i className='bx bx-detail mr-1' aria-hidden='true'></i>
                          Details
                        </Button>
                        {canCancel && (
                          <Button
                            variant='outline2'
                            size='small'
                            className='px-3'
                            disabled={cancelling.has(job.id)}
                            onClick={() => handleCancel(job.id)}
                          >
                            {cancelling.has(job.id) ? (
                              <>
                                <i className='bx bx-loader-alt bx-spin mr-1' aria-hidden='true'></i>
                                Stopping
                              </>
                            ) : (
                              <>
                                <i className='bx bx-stop mr-1' aria-hidden='true'></i>
                                Stop
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className='mt-3'>
                    <ProgressBar value={job.progress ?? 0} status={job.status} themeColors={themeColors} />
                  </div>
                </div>
              )
            })
          )}
        </div>

        {runningJobs.length > 0 ? (
          <div className='mt-4 text-xs' style={{ color: themeColors.mutedText }}>
            {runningJobs.length} job{runningJobs.length === 1 ? '' : 's'} running or pending.
          </div>
        ) : null}
      </div>

      {/* Job Details Modal */}
      <JobDetailsModal
        job={selectedJobDetails}
        conversationTitle={conversationTitle}
        isOpen={selectedJobDetails !== null}
        onClose={handleCloseDetails}
      />
    </div>
  )
}
