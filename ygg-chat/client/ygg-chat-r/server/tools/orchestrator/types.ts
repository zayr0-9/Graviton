/**
 * Tool Orchestrator Types
 *
 * Defines the core types for the background job management system.
 * Jobs survive page changes and remounts - they run on the server side.
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type JobPriority = 'low' | 'normal' | 'high' | 'critical'

export interface JobOptions {
  /** Priority for queue ordering (default: 'normal') */
  priority?: JobPriority
  /** Timeout in milliseconds (default: 300000 = 5 minutes) */
  timeoutMs?: number
  /** Number of retry attempts on failure (default: 0) */
  retries?: number
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs?: number
  /** Root path for tool execution */
  rootPath?: string | null
  /** Operation mode (plan/execute) */
  operationMode?: 'plan' | 'execute'
  /** Optional metadata to attach to the job */
  metadata?: Record<string, any>
  /** Conversation ID this job belongs to */
  conversationId?: string | null
  /** Message ID that triggered this job */
  messageId?: string | null
  /** Parent user/root message ID for the current stream */
  parentMessageId?: string | null
  /** Stream ID for real-time updates */
  streamId?: string | null
  /** Tool call ID, when available */
  toolCallId?: string | null
}

export interface Job {
  /** Unique job identifier */
  id: string
  /** Tool name to execute */
  toolName: string
  /** Tool arguments */
  args: Record<string, any>
  /** Current job status */
  status: JobStatus
  /** Job priority */
  priority: JobPriority
  /** Root path for execution */
  rootPath: string | null
  /** Operation mode */
  operationMode: 'plan' | 'execute'
  /** Timeout in milliseconds */
  timeoutMs: number
  /** Retry configuration */
  retries: number
  retriesRemaining: number
  retryDelayMs: number
  /** Associated metadata */
  metadata: Record<string, any>
  /** Conversation context */
  conversationId: string | null
  messageId: string | null
  parentMessageId: string | null
  streamId: string | null
  toolCallId: string | null
  /** Timestamps */
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  /** Result or error */
  result: any | null
  error: string | null
  /** Progress tracking (0-100) */
  progress: number
  progressMessage: string | null
}

export interface JobSummary {
  id: string
  toolName: string
  status: JobStatus
  priority: JobPriority
  progress: number
  progressMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  conversationId: string | null
  messageId: string | null
  streamId: string | null
  error: string | null
  parentMessageId?: string | null
  toolCallId?: string | null
}

export interface JobFilter {
  status?: JobStatus | JobStatus[]
  conversationId?: string
  toolName?: string
  limit?: number
  offset?: number
  orderBy?: 'createdAt' | 'priority' | 'status'
  orderDir?: 'asc' | 'desc'
}

export interface JobEvent {
  type: 'job_created' | 'job_started' | 'job_progress' | 'job_completed' | 'job_failed' | 'job_cancelled'
  job: JobSummary
  timestamp: string
}

export interface OrchestratorStats {
  pending: number
  running: number
  completed: number
  failed: number
  cancelled: number
  total: number
  concurrencyLimit: number
  activeWorkers: number
}

export interface OrchestratorConfig {
  /** Maximum concurrent job executions (default: 5) */
  concurrencyLimit?: number
  /** Default job timeout in ms (default: 300000 = 5 minutes) */
  defaultTimeoutMs?: number
  /** How long to keep completed jobs in memory (default: 3600000 = 1 hour) */
  completedJobRetentionMs?: number
  /** Enable persistence to SQLite (default: true) */
  persistJobs?: boolean
}
