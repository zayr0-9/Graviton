/**
 * Tool Orchestrator
 *
 * Background job management system for tool executions.
 * - Survives page changes and remounts (server-side)
 * - Manages job queue with priority ordering
 * - Supports concurrent execution with limits
 * - Persists jobs to SQLite for crash recovery
 * - Emits events for real-time UI updates
 */

import type Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import type { WebSocket } from 'ws'
import {
  Job,
  JobEvent,
  JobFilter,
  JobOptions,
  JobPriority,
  JobStatus,
  JobSummary,
  OrchestratorConfig,
  OrchestratorStats,
} from './types.js'

// Priority weights for queue ordering (higher = more urgent)
const PRIORITY_WEIGHTS: Record<JobPriority, number> = {
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
}

// Tool handler type (matches built-in tool signature, extended with context)
type ToolHandler = (
  args: Record<string, any>,
  options: {
    rootPath?: string
    operationMode?: 'plan' | 'execute'
    conversationId?: string | null
    messageId?: string | null
    parentMessageId?: string | null
    streamId?: string | null
    toolCallId?: string | null
  }
) => Promise<any>

const normalizeToolName = (name: unknown): string => (typeof name === 'string' ? name.trim() : '')

export class ToolOrchestrator {
  private jobs: Map<string, Job> = new Map()
  private pendingQueue: string[] = [] // Job IDs ordered by priority
  private activeJobs: Set<string> = new Set()
  private config: Required<OrchestratorConfig>
  private db: Database.Database | null = null
  private statements: {
    insertJob: Database.Statement | null
    updateJob: Database.Statement | null
    getJob: Database.Statement | null
    listJobs: Database.Statement | null
    deleteOldJobs: Database.Statement | null
  } = {
    insertJob: null,
    updateJob: null,
    getJob: null,
    listJobs: null,
    deleteOldJobs: null,
  }

  // Registered tool handlers
  private toolHandlers: Map<string, ToolHandler> = new Map()

  // Event subscribers (WebSocket clients)
  private subscribers: Set<WebSocket> = new Set()

  // Cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      concurrencyLimit: config.concurrencyLimit ?? 5,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 300000, // 5 minutes
      completedJobRetentionMs: config.completedJobRetentionMs ?? 3600000, // 1 hour
      persistJobs: config.persistJobs ?? true,
    }
  }

  /**
   * Initialize the orchestrator with database connection
   */
  initialize(db: Database.Database): void {
    this.db = db

    if (this.config.persistJobs) {
      this.initializeSchema()
      this.loadPendingJobs()
    }

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupOldJobs(), 60000) // Every minute

    console.log('[ToolOrchestrator] Initialized with config:', this.config)
  }

  /**
   * Initialize SQLite schema for job persistence
   */
  private initializeSchema(): void {
    if (!this.db) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_jobs (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
        root_path TEXT,
        operation_mode TEXT CHECK (operation_mode IN ('plan', 'execute')),
        timeout_ms INTEGER NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0,
        retries_remaining INTEGER NOT NULL DEFAULT 0,
        retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
        metadata TEXT,
        conversation_id TEXT,
        message_id TEXT,
        stream_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        progress_message TEXT
      )
    `)

    // Index for efficient queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tool_jobs_status ON tool_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_tool_jobs_conversation ON tool_jobs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_tool_jobs_created ON tool_jobs(created_at);
    `)

    // Prepare statements
    this.statements.insertJob = this.db.prepare(`
      INSERT INTO tool_jobs (
        id, tool_name, args, status, priority, root_path, operation_mode,
        timeout_ms, retries, retries_remaining, retry_delay_ms, metadata,
        conversation_id, message_id, stream_id, created_at, started_at,
        completed_at, result, error, progress, progress_message
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)

    this.statements.updateJob = this.db.prepare(`
      UPDATE tool_jobs SET
        status = ?, started_at = ?, completed_at = ?, result = ?,
        error = ?, progress = ?, progress_message = ?, retries_remaining = ?
      WHERE id = ?
    `)

    this.statements.getJob = this.db.prepare(`SELECT * FROM tool_jobs WHERE id = ?`)

    this.statements.listJobs = this.db.prepare(`
      SELECT * FROM tool_jobs
      ORDER BY
        CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
        created_at ASC
      LIMIT ? OFFSET ?
    `)

    this.statements.deleteOldJobs = this.db.prepare(`
      DELETE FROM tool_jobs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at < ?
    `)

    console.log('[ToolOrchestrator] Database schema initialized')
  }

  /**
   * Load pending jobs from database on startup
   */
  private loadPendingJobs(): void {
    if (!this.db) return

    const rows = this.db
      .prepare(`SELECT * FROM tool_jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC`)
      .all() as any[]

    for (const row of rows) {
      const job = this.rowToJob(row)
      // Reset running jobs to pending (they were interrupted)
      if (job.status === 'running') {
        job.status = 'pending'
        job.startedAt = null
      }
      this.jobs.set(job.id, job)
      this.enqueuePending(job.id, job.priority)
    }

    console.log(`[ToolOrchestrator] Loaded ${rows.length} pending jobs from database`)

    // Start processing
    this.processQueue()
  }

  /**
   * Convert database row to Job object
   */
  private rowToJob(row: any): Job {
    return {
      id: row.id,
      toolName: normalizeToolName(row.tool_name),
      args: JSON.parse(row.args || '{}'),
      status: row.status as JobStatus,
      priority: row.priority as JobPriority,
      rootPath: row.root_path,
      operationMode: row.operation_mode || 'execute',
      timeoutMs: row.timeout_ms,
      retries: row.retries,
      retriesRemaining: row.retries_remaining,
      retryDelayMs: row.retry_delay_ms,
      metadata: JSON.parse(row.metadata || '{}'),
      conversationId: row.conversation_id,
      messageId: row.message_id,
      parentMessageId: null,
      streamId: row.stream_id,
      toolCallId: null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      progress: row.progress,
      progressMessage: row.progress_message,
    }
  }

  /**
   * Register a tool handler
   */
  registerTool(name: string, handler: ToolHandler): void {
    this.toolHandlers.set(normalizeToolName(name), handler)
  }

  /**
   * Register multiple tool handlers
   */
  registerTools(tools: Map<string, ToolHandler>): void {
    for (const [name, handler] of tools) {
      this.toolHandlers.set(normalizeToolName(name), handler)
    }
  }

  /**
   * Subscribe a WebSocket client to job events
   */
  subscribe(ws: WebSocket): void {
    this.subscribers.add(ws)
    ws.on('close', () => this.subscribers.delete(ws))
  }

  /**
   * Unsubscribe a WebSocket client
   */
  unsubscribe(ws: WebSocket): void {
    this.subscribers.delete(ws)
  }

  /**
   * Broadcast an event to all subscribers
   */
  private broadcastEvent(event: JobEvent): void {
    const message = JSON.stringify({ type: 'job_event', data: event })
    for (const ws of this.subscribers) {
      if (ws.readyState === 1) {
        // OPEN
        ws.send(message)
      }
    }
  }

  /**
   * Create a job summary for events
   */
  private toSummary(job: Job): JobSummary {
    return {
      id: job.id,
      toolName: job.toolName,
      status: job.status,
      priority: job.priority,
      progress: job.progress,
      progressMessage: job.progressMessage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      conversationId: job.conversationId,
      messageId: job.messageId,
      streamId: job.streamId,
      error: job.error,
      parentMessageId: job.parentMessageId,
      toolCallId: job.toolCallId,
    }
  }

  /**
   * Submit a new job
   */
  submit(toolName: string, args: Record<string, any>, options: JobOptions = {}): Job {
    const id = uuidv4()
    const now = new Date().toISOString()
    const normalizedToolName = normalizeToolName(toolName)
    if (!normalizedToolName) {
      throw new Error('toolName is required')
    }

    const job: Job = {
      id,
      toolName: normalizedToolName,
      args,
      status: 'pending',
      priority: options.priority ?? 'normal',
      rootPath: options.rootPath ?? null,
      operationMode: options.operationMode ?? 'execute',
      timeoutMs: options.timeoutMs ?? this.config.defaultTimeoutMs,
      retries: options.retries ?? 0,
      retriesRemaining: options.retries ?? 0,
      retryDelayMs: options.retryDelayMs ?? 1000,
      metadata: options.metadata ?? {},
      conversationId: options.conversationId ?? null,
      messageId: options.messageId ?? null,
      parentMessageId: options.parentMessageId ?? null,
      streamId: options.streamId ?? null,
      toolCallId: options.toolCallId ?? null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      progress: 0,
      progressMessage: null,
    }

    this.jobs.set(id, job)
    this.persistJob(job)
    this.enqueuePending(id, job.priority)

    // Broadcast event
    this.broadcastEvent({
      type: 'job_created',
      job: this.toSummary(job),
      timestamp: now,
    })

    // Try to process immediately
    this.processQueue()

    // console.log(`[ToolOrchestrator] Job submitted: ${id} (${toolName})`)
    return job
  }

  /**
   * Add job to pending queue with priority ordering
   */
  private enqueuePending(jobId: string, priority: JobPriority): void {
    const weight = PRIORITY_WEIGHTS[priority]

    // Find insertion point (maintain priority order)
    let insertIndex = this.pendingQueue.length
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const existingJob = this.jobs.get(this.pendingQueue[i])
      if (existingJob && PRIORITY_WEIGHTS[existingJob.priority] < weight) {
        insertIndex = i
        break
      }
    }

    this.pendingQueue.splice(insertIndex, 0, jobId)
  }

  /**
   * Process the job queue
   */
  private processQueue(): void {
    while (this.activeJobs.size < this.config.concurrencyLimit && this.pendingQueue.length > 0) {
      const jobId = this.pendingQueue.shift()
      if (!jobId) break

      const job = this.jobs.get(jobId)
      if (!job || job.status !== 'pending') continue

      this.executeJob(job)
    }
  }

  /**
   * Execute a single job
   */
  private async executeJob(job: Job): Promise<void> {
    const handler = this.toolHandlers.get(job.toolName)
    if (!handler) {
      this.failJob(job, `Unknown tool: ${job.toolName}`)
      return
    }

    // Mark as running
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    this.activeJobs.add(job.id)
    this.persistJob(job)

    this.broadcastEvent({
      type: 'job_started',
      job: this.toSummary(job),
      timestamp: job.startedAt,
    })

    // console.log(`[ToolOrchestrator] Job started: ${job.id} (${job.toolName})`)

    // Execute with timeout
    let timeoutId: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Job timed out after ${job.timeoutMs}ms`))
      }, job.timeoutMs)
    })

    try {
      const result = await Promise.race([
        handler(job.args, {
          rootPath: job.rootPath ?? undefined,
          operationMode: job.operationMode,
          conversationId: job.conversationId,
          messageId: job.messageId,
          parentMessageId: job.parentMessageId,
          streamId: job.streamId,
          toolCallId: job.toolCallId,
        }),
        timeoutPromise,
      ])

      if (timeoutId) clearTimeout(timeoutId)
      this.completeJob(job, result)
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId)
      const errorMsg = error instanceof Error ? error.message : String(error)

      // Check for retries
      if (job.retriesRemaining > 0) {
        job.retriesRemaining--
        job.status = 'pending'
        job.startedAt = null
        this.activeJobs.delete(job.id)
        this.persistJob(job)

        // console.log(`[ToolOrchestrator] Job ${job.id} failed, retrying (${job.retriesRemaining} left): ${errorMsg}`)

        // Re-queue with delay
        setTimeout(() => {
          this.enqueuePending(job.id, job.priority)
          this.processQueue()
        }, job.retryDelayMs)
      } else {
        this.failJob(job, errorMsg)
      }
    }

    // Continue processing queue
    this.processQueue()
  }

  /**
   * Mark job as completed
   */
  private completeJob(job: Job, result: any): void {
    job.status = 'completed'
    job.completedAt = new Date().toISOString()
    job.result = result
    job.progress = 100
    this.activeJobs.delete(job.id)
    this.persistJob(job)

    this.broadcastEvent({
      type: 'job_completed',
      job: this.toSummary(job),
      timestamp: job.completedAt,
    })

    // console.log(`[ToolOrchestrator] Job completed: ${job.id}`)
  }

  /**
   * Mark job as failed
   */
  private failJob(job: Job, error: string): void {
    job.status = 'failed'
    job.completedAt = new Date().toISOString()
    job.error = error
    this.activeJobs.delete(job.id)
    this.persistJob(job)

    this.broadcastEvent({
      type: 'job_failed',
      job: this.toSummary(job),
      timestamp: job.completedAt,
    })

    // console.log(`[ToolOrchestrator] Job failed: ${job.id} - ${error}`)
  }

  /**
   * Cancel a job
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return false
    }

    job.status = 'cancelled'
    job.completedAt = new Date().toISOString()
    this.activeJobs.delete(job.id)
    this.pendingQueue = this.pendingQueue.filter(id => id !== jobId)
    this.persistJob(job)

    this.broadcastEvent({
      type: 'job_cancelled',
      job: this.toSummary(job),
      timestamp: job.completedAt,
    })

    // console.log(`[ToolOrchestrator] Job cancelled: ${job.id}`)
    return true
  }

  /**
   * Update job progress
   */
  updateProgress(jobId: string, progress: number, message?: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return

    job.progress = Math.min(100, Math.max(0, progress))
    job.progressMessage = message ?? null
    this.persistJob(job)

    this.broadcastEvent({
      type: 'job_progress',
      job: this.toSummary(job),
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null
  }

  /**
   * List jobs with optional filters
   */
  listJobs(filter: JobFilter = {}): JobSummary[] {
    let jobs = Array.from(this.jobs.values())

    // Apply filters
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      jobs = jobs.filter(j => statuses.includes(j.status))
    }

    if (filter.conversationId) {
      jobs = jobs.filter(j => j.conversationId === filter.conversationId)
    }

    if (filter.toolName) {
      jobs = jobs.filter(j => j.toolName === filter.toolName)
    }

    // Sort
    const orderBy = filter.orderBy ?? 'createdAt'
    const orderDir = filter.orderDir ?? 'desc'
    jobs.sort((a, b) => {
      let cmp = 0
      if (orderBy === 'priority') {
        cmp = PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority]
      } else if (orderBy === 'status') {
        cmp = a.status.localeCompare(b.status)
      } else {
        cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
      return orderDir === 'asc' ? -cmp : cmp
    })

    // Paginate
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 100
    jobs = jobs.slice(offset, offset + limit)

    return jobs.map(j => this.toSummary(j))
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): OrchestratorStats {
    const jobs = Array.from(this.jobs.values())
    return {
      pending: jobs.filter(j => j.status === 'pending').length,
      running: jobs.filter(j => j.status === 'running').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      cancelled: jobs.filter(j => j.status === 'cancelled').length,
      total: jobs.length,
      concurrencyLimit: this.config.concurrencyLimit,
      activeWorkers: this.activeJobs.size,
    }
  }

  private serializeResultForPersistence(result: any): string | null {
    if (!result) return null
    const compactResult =
      result && typeof result === 'object' && !Array.isArray(result)
        ? Object.prototype.hasOwnProperty.call(result, 'persistedContent')
          ? result.persistedContent
          : Object.prototype.hasOwnProperty.call(result, 'displayContent')
            ? result.displayContent
            : result
        : result
    return JSON.stringify(compactResult)
  }

  /**
   * Persist job to database. Model-only payloads stay in memory only until the
   * execute-and-wait caller consumes them.
   */
  private persistJob(job: Job): void {
    if (!this.db || !this.config.persistJobs) return

    try {
      // Check if job exists
      const existing = this.statements.getJob?.get(job.id)

      if (existing) {
        this.statements.updateJob?.run(
          job.status,
          job.startedAt,
          job.completedAt,
          this.serializeResultForPersistence(job.result),
          job.error,
          job.progress,
          job.progressMessage,
          job.retriesRemaining,
          job.id
        )
      } else {
        this.statements.insertJob?.run(
          job.id,
          job.toolName,
          JSON.stringify(job.args),
          job.status,
          job.priority,
          job.rootPath,
          job.operationMode,
          job.timeoutMs,
          job.retries,
          job.retriesRemaining,
          job.retryDelayMs,
          JSON.stringify(job.metadata),
          job.conversationId,
          job.messageId,
          job.streamId,
          job.createdAt,
          job.startedAt,
          job.completedAt,
          this.serializeResultForPersistence(job.result),
          job.error,
          job.progress,
          job.progressMessage
        )
      }
    } catch (error) {
      console.error('[ToolOrchestrator] Failed to persist job:', error)
    }
  }

  /**
   * Clean up old completed jobs
   */
  private cleanupOldJobs(): void {
    const cutoff = new Date(Date.now() - this.config.completedJobRetentionMs).toISOString()

    // Clean in-memory
    for (const [id, job] of this.jobs) {
      if (
        (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
        job.completedAt &&
        job.completedAt < cutoff
      ) {
        this.jobs.delete(id)
      }
    }

    // Clean database
    if (this.db && this.statements.deleteOldJobs) {
      try {
        this.statements.deleteOldJobs.run(cutoff)
      } catch (error) {
        console.error('[ToolOrchestrator] Failed to cleanup old jobs:', error)
      }
    }
  }

  /**
   * Shutdown the orchestrator
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Cancel all running jobs
    for (const jobId of this.activeJobs) {
      this.cancel(jobId)
    }

    this.subscribers.clear()
    console.log('[ToolOrchestrator] Shutdown complete')
  }
}

// Singleton instance
export const toolOrchestrator = new ToolOrchestrator()
