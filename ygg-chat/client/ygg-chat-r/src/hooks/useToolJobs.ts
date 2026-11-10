/**
 * React hooks for Tool Job Manager integration
 *
 * These hooks provide reactive access to background tool jobs:
 * - useToolJobs: Subscribe to job list with real-time updates
 * - useToolJob: Subscribe to a specific job's status
 * - useRunningJobs: Get currently running jobs
 * - useJobSubmit: Submit jobs with loading/error states
 * - useJobStats: Get orchestrator statistics
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  Job,
  JobEvent,
  JobFilter,
  JobOptions,
  JobSummary,
  // JobStatus,
  OrchestratorStats,
  toolJobManager,
} from '../services/ToolJobManager'

// Check if running in web mode (Electron features disabled)

/**
 * Subscribe to all jobs with real-time updates
 */
export function useToolJobs(filter?: JobFilter): {
  jobs: JobSummary[]
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
} {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Reactive jobs via external store with cached snapshot
  const jobs = useSyncExternalStore(
    useCallback(callback => toolJobManager.onJobsChange(callback), []),
    () => toolJobManager.getJobs(),
    () => []
  )

  // Apply client-side filtering
  const filteredJobs = useMemo(() => {
    let result = jobs

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      result = result.filter(j => statuses.includes(j.status))
    }

    if (filter?.conversationId) {
      result = result.filter(j => j.conversationId === filter.conversationId)
    }

    if (filter?.toolName) {
      result = result.filter(j => j.toolName === filter.toolName)
    }

    // Sort
    const orderBy = filter?.orderBy ?? 'createdAt'
    const orderDir = filter?.orderDir ?? 'desc'

    result = [...result].sort((a, b) => {
      let cmp = 0
      if (orderBy === 'priority') {
        const weights: Record<string, number> = { low: 1, normal: 2, high: 3, critical: 4 }
        cmp = (weights[b.priority] || 0) - (weights[a.priority] || 0)
      } else if (orderBy === 'status') {
        cmp = a.status.localeCompare(b.status)
      } else {
        cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
      return orderDir === 'asc' ? -cmp : cmp
    })

    // Pagination
    if (filter?.offset) {
      result = result.slice(filter.offset)
    }
    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }, [jobs, filter])

  // Refresh from server
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await toolJobManager.refreshJobs(filter)
      // Stats are driven by useJobStats; keep this for a one-time sync on mount/open
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [filter])

  // Initial load (skip in web mode - electron only)
  useEffect(() => {
    refresh()
  }, [refresh])

  return { jobs: filteredJobs, loading, error, refresh }
}

/**
 * Subscribe to a specific job's status with real-time updates
 */
export function useToolJob(jobId: string | null): {
  job: Job | null
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
} {
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Listen for updates to this specific job
  useEffect(() => {
    if (!jobId) {
      setJob(null)
      return
    }

    const unsubscribe = toolJobManager.onJobEvent((event: JobEvent) => {
      if (event.job.id === jobId) {
        // Fetch full job details on update
        toolJobManager.getJob(jobId).then(setJob).catch(console.error)
      }
    })

    return unsubscribe
  }, [jobId])

  // Fetch job details
  const refresh = useCallback(async () => {
    if (!jobId) return

    setLoading(true)
    setError(null)
    try {
      const result = await toolJobManager.getJob(jobId)
      setJob(result)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [jobId])

  // Initial load
  useEffect(() => {
    if (jobId) {
      refresh()
    }
  }, [jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  return { job, loading, error, refresh }
}

/**
 * Get currently running jobs (pending + running)
 */
export function useRunningJobs(): JobSummary[] {
  return useSyncExternalStore(
    useCallback(callback => toolJobManager.onJobsChange(callback), []),
    () => toolJobManager.getRunningJobs(),
    () => []
  )
}

/**
 * Submit jobs with loading/error state management
 */
export function useJobSubmit(): {
  submit: (toolName: string, args: Record<string, any>, options?: JobOptions) => Promise<Job>
  submitting: boolean
  error: Error | null
  lastJob: Job | null
  reset: () => void
} {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [lastJob, setLastJob] = useState<Job | null>(null)

  const submit = useCallback(
    async (toolName: string, args: Record<string, any>, options?: JobOptions): Promise<Job> => {
      setSubmitting(true)
      setError(null)
      try {
        const job = await toolJobManager.submitJob(toolName, args, options)
        setLastJob(job)
        return job
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        setError(error)
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    []
  )

  const reset = useCallback(() => {
    setError(null)
    setLastJob(null)
  }, [])

  return { submit, submitting, error, lastJob, reset }
}

/**
 * Get orchestrator statistics
 */
export function useJobStats(): {
  stats: OrchestratorStats | null
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
} {
  const [stats, setStats] = useState<OrchestratorStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // const [version, setVersion] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await toolJobManager.getStats()
      setStats(result)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load (skip in web mode - electron only)
  useEffect(() => {
    refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update stats when jobs change (skip in web mode - electron only)
  useEffect(() => {
    const unsubscribe = toolJobManager.onJobsChange(() => {
      // setVersion(v => v + 1)
      // fire-and-forget refresh without loading state to keep UI live
      toolJobManager
        .getStats()
        .then(setStats)
        .catch(err => setError(err instanceof Error ? err : new Error(String(err))))
    })
    return unsubscribe
  }, [])

  return { stats, loading, error, refresh }
}

/**
 * Cancel a job
 */
export function useJobCancel(): {
  cancel: (jobId: string) => Promise<boolean>
  cancelling: boolean
  error: Error | null
} {
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const cancel = useCallback(async (jobId: string): Promise<boolean> => {
    setCancelling(true)
    setError(null)
    try {
      return await toolJobManager.cancelJob(jobId)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setError(error)
      return false
    } finally {
      setCancelling(false)
    }
  }, [])

  return { cancel, cancelling, error }
}

/**
 * Subscribe to job events
 */
export function useJobEvents(callback: (event: JobEvent) => void): void {
  useEffect(() => {
    return toolJobManager.onJobEvent(callback)
  }, [callback])
}

/**
 * Check connection status
 */
export function useJobManagerConnection(): boolean {
  const [connected, setConnected] = useState(toolJobManager.isConnected())

  useEffect(() => {
    // Poll connection status (simple approach)
    const interval = setInterval(() => {
      setConnected(toolJobManager.isConnected())
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  return connected
}

/**
 * Get jobs for a specific conversation
 */
export function useConversationJobs(conversationId: string | null): JobSummary[] {
  const { jobs } = useToolJobs(conversationId ? { conversationId, orderBy: 'createdAt', orderDir: 'desc' } : undefined)

  return useMemo(() => {
    if (!conversationId) return []
    return jobs.filter(j => j.conversationId === conversationId)
  }, [jobs, conversationId])
}

/**
 * Composite hook for job management UI
 */
export function useJobManager(): {
  jobs: JobSummary[]
  runningJobs: JobSummary[]
  stats: OrchestratorStats | null
  connected: boolean
  submit: (toolName: string, args: Record<string, any>, options?: JobOptions) => Promise<Job>
  cancel: (jobId: string) => Promise<boolean>
  refresh: () => Promise<void>
} {
  const { jobs, refresh } = useToolJobs()
  const runningJobs = useRunningJobs()
  const { stats } = useJobStats()
  const connected = useJobManagerConnection()
  const { submit } = useJobSubmit()
  const { cancel } = useJobCancel()

  return {
    jobs,
    runningJobs,
    stats,
    connected,
    submit,
    cancel,
    refresh,
  }
}
