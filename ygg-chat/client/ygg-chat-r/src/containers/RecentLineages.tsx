import { ArrowLeft, GitBranch, MessageSquare, RefreshCw } from 'lucide-react'
import React, { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { type RecentLineage, useProject, useRecentLineages } from '../hooks/useQueries'

const panelClass =
  'rounded-xl border border-neutral-200/80 dark:border-neutral-700/90 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-2xl shadow-sm dark:shadow-black/30'

const getPreview = (lineage: RecentLineage): string => {
  const preview = lineage.pathPreview?.at(-1)?.content?.trim()
  return preview || 'No message preview available.'
}

const formatActivity = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown activity'

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (elapsedSeconds < 60) return 'Just now'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h ago`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays}d ago`
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}

const statusClasses = (status: string) => {
  const normalized = status.toLowerCase()
  if (normalized === 'active' || normalized === 'running') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
  }
  if (normalized === 'pending') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
  }
  return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
}

interface ConversationGroup {
  conversationId: string
  title: string
  latestActivity: number
  lineages: RecentLineage[]
}

const RecentLineages: React.FC = () => {
  const navigate = useNavigate()
  const { projectId = '' } = useParams<{ projectId: string }>()
  const { data: project } = useProject(projectId || null)
  const { data: lineages = [], isLoading, isFetching, error, refetch } = useRecentLineages(projectId || null)

  const groups = useMemo<ConversationGroup[]>(() => {
    const grouped = new Map<string, ConversationGroup>()
    for (const lineage of lineages) {
      const conversationId = String(lineage.conversationId)
      const activity = new Date(lineage.activityAt).getTime() || 0
      const existing = grouped.get(conversationId)
      if (existing) {
        existing.lineages.push(lineage)
        existing.latestActivity = Math.max(existing.latestActivity, activity)
        if (existing.title === 'Untitled conversation' && lineage.conversationTitle) {
          existing.title = lineage.conversationTitle
        }
      } else {
        grouped.set(conversationId, {
          conversationId,
          title: lineage.conversationTitle?.trim() || 'Untitled conversation',
          latestActivity: activity,
          lineages: [lineage],
        })
      }
    }

    return [...grouped.values()]
      .map(group => ({
        ...group,
        lineages: group.lineages.slice().sort((a, b) => b.activityAt.localeCompare(a.activityAt)),
      }))
      .sort((a, b) => b.latestActivity - a.latestActivity)
  }, [lineages])

  const openLineage = (lineage: RecentLineage) => {
    const route = `/chat/${encodeURIComponent(projectId)}/${encodeURIComponent(String(lineage.conversationId))}/lineage/${encodeURIComponent(String(lineage.lineageId))}`
    const focus = lineage.headMessageId
    navigate(focus ? `${route}?focus=${encodeURIComponent(String(focus))}` : route)
  }

  const errorMessage = error instanceof Error ? error.message : 'Recent lineages could not be loaded.'

  return (
    <main className='h-full min-h-full overflow-y-auto text-neutral-900 dark:text-neutral-100'>
      <div className='mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-6'>
        <header className='flex flex-wrap items-start justify-between gap-4'>
          <div className='flex min-w-0 items-start gap-3'>
            <button
              type='button'
              aria-label='Go back'
              onClick={() => navigate(-1)}
              className='mt-1 rounded-lg border border-neutral-200 bg-white/80 p-2 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white'
            >
              <ArrowLeft size={18} />
            </button>
            <div className='min-w-0'>
              <h1 className='truncate text-2xl font-semibold sm:text-3xl'>Recent lineages</h1>
              <p className='mt-1 text-sm text-neutral-500 dark:text-neutral-400'>
                {project?.name ? `${project.name} · ` : ''}Recent branches grouped by conversation
              </p>
            </div>
          </div>
          <button
            type='button'
            onClick={() => void refetch()}
            disabled={isFetching}
            className='inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-wait disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-800'
          >
            <RefreshCw size={15} className={isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </header>

        {isLoading && (
          <div className={`${panelClass} p-6`} role='status'>
            <div className='space-y-3 animate-pulse'>
              <div className='h-4 w-40 rounded bg-neutral-200 dark:bg-neutral-700' />
              <div className='h-20 rounded-lg bg-neutral-100 dark:bg-neutral-800' />
              <div className='h-20 rounded-lg bg-neutral-100 dark:bg-neutral-800' />
            </div>
            <span className='sr-only'>Loading recent lineages</span>
          </div>
        )}

        {!isLoading && error && (
          <section
            className='rounded-xl border border-rose-300 bg-rose-50/90 p-5 dark:border-rose-800 dark:bg-rose-950/30'
            role='alert'
          >
            <h2 className='font-semibold text-rose-800 dark:text-rose-200'>Unable to load recent lineages</h2>
            <p className='mt-1 text-sm text-rose-700 dark:text-rose-300'>{errorMessage}</p>
            <button
              type='button'
              onClick={() => void refetch()}
              className='mt-3 text-sm font-medium underline underline-offset-2'
            >
              Try again
            </button>
          </section>
        )}

        {!isLoading && !error && groups.length === 0 && (
          <section className={`${panelClass} px-6 py-14 text-center`}>
            <GitBranch className='mx-auto text-neutral-400' size={30} />
            <h2 className='mt-3 font-semibold'>No recent lineages</h2>
            <p className='mx-auto mt-1 max-w-md text-sm text-neutral-500 dark:text-neutral-400'>
              Branches for this project will appear here after conversation activity.
            </p>
          </section>
        )}

        {!isLoading &&
          !error &&
          groups.map(group => (
            <section key={group.conversationId} className={`${panelClass} overflow-hidden`}>
              <div className='flex items-center justify-between gap-3 border-b border-neutral-200/80 px-4 py-3 dark:border-neutral-800'>
                <div className='min-w-0'>
                  <h2 className='truncate text-sm font-semibold'>{group.title}</h2>
                  <p className='truncate text-xs text-neutral-500 dark:text-neutral-400'>{group.conversationId}</p>
                </div>
                <span className='shrink-0 rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'>
                  {group.lineages.length} {group.lineages.length === 1 ? 'lineage' : 'lineages'}
                </span>
              </div>
              <div className='divide-y divide-neutral-200/70 dark:divide-neutral-800'>
                {group.lineages.map(lineage => {
                  const status = lineage.status?.trim() || 'unknown'
                  const activityCount = lineage.activeRunCount
                  return (
                    <button
                      key={lineage.lineageId}
                      type='button'
                      onClick={() => openLineage(lineage)}
                      className='group flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-violet-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 dark:hover:bg-violet-950/20'
                    >
                      <span className='mt-0.5 rounded-lg bg-violet-100 p-2 text-violet-600 dark:bg-violet-950/60 dark:text-violet-300'>
                        <GitBranch size={15} />
                      </span>
                      <span className='min-w-0 flex-1'>
                        <span className='flex flex-wrap items-center gap-2'>
                          <span className='max-w-full truncate font-mono text-xs font-medium text-neutral-700 dark:text-neutral-200'>
                            {lineage.lineageId}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${statusClasses(status)}`}
                          >
                            {status}
                          </span>
                        </span>
                        <span className='mt-1.5 block line-clamp-2 text-sm text-neutral-600 dark:text-neutral-300'>
                          {getPreview(lineage)}
                        </span>
                        <span className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400'>
                          <span>{formatActivity(lineage.activityAt)}</span>
                          {activityCount > 0 && (
                            <span className='inline-flex items-center gap-1'>
                              <MessageSquare size={12} />
                              {activityCount} active
                            </span>
                          )}
                          {lineage.parentLineageId && <span>Branched lineage</span>}
                        </span>
                      </span>
                      <span
                        className='mt-2 text-neutral-400 transition group-hover:translate-x-0.5 group-hover:text-violet-500'
                        aria-hidden='true'
                      >
                        →
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
      </div>
    </main>
  )
}

export default RecentLineages
