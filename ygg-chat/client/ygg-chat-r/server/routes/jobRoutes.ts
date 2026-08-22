// server/routes/jobRoutes.ts
//
// Tool orchestrator / background job APIs (/api/jobs*), extracted
// verbatim from localServer.ts setupServer().

import type { Express } from 'express'
import { JobFilter, JobOptions, toolOrchestrator } from '../tools/orchestrator/index.js'

export function registerJobRoutes(app: Express): void {
  // ============================================================================
  // Tool Orchestrator / Job Management API
  // ============================================================================

  // POST /api/jobs - Submit a new background job
  app.post('/api/jobs', async (req, res) => {
    try {
      const { toolName, args, options } = req.body as {
        toolName: string
        args: Record<string, any>
        options?: JobOptions
      }

      if (!toolName) {
        res.status(400).json({ success: false, error: 'toolName is required' })
        return
      }

      const job = toolOrchestrator.submit(toolName, args || {}, options || {})
      res.json({ success: true, job })
    } catch (error) {
      console.error('[LocalServer] Error submitting job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs - List jobs with optional filters
  app.get('/api/jobs', (req, res) => {
    try {
      const filter: JobFilter = {}

      // Parse query parameters
      if (req.query.status) {
        const statuses = (req.query.status as string).split(',')
        filter.status = statuses.length === 1 ? (statuses[0] as any) : (statuses as any)
      }
      if (req.query.conversationId) {
        filter.conversationId = req.query.conversationId as string
      }
      if (req.query.toolName) {
        filter.toolName = req.query.toolName as string
      }
      if (req.query.limit) {
        filter.limit = parseInt(req.query.limit as string, 10)
      }
      if (req.query.offset) {
        filter.offset = parseInt(req.query.offset as string, 10)
      }
      if (req.query.orderBy) {
        filter.orderBy = req.query.orderBy as any
      }
      if (req.query.orderDir) {
        filter.orderDir = req.query.orderDir as any
      }

      const jobs = toolOrchestrator.listJobs(filter)
      res.json({ success: true, jobs })
    } catch (error) {
      console.error('[LocalServer] Error listing jobs:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs/stats - Get orchestrator statistics
  app.get('/api/jobs/stats', (_req, res) => {
    try {
      const stats = toolOrchestrator.getStats()
      res.json({ success: true, stats })
    } catch (error) {
      console.error('[LocalServer] Error getting job stats:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs/:id - Get a specific job
  app.get('/api/jobs/:id', (req, res) => {
    try {
      const job = toolOrchestrator.getJob(req.params.id)
      if (job) {
        res.json({ success: true, job })
      } else {
        res.status(404).json({ success: false, error: 'Job not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/jobs/:id/cancel - Cancel a job
  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      const cancelled = toolOrchestrator.cancel(req.params.id)
      if (cancelled) {
        res.json({ success: true, message: 'Job cancelled' })
      } else {
        res.status(400).json({ success: false, error: 'Job could not be cancelled (already completed or not found)' })
      }
    } catch (error) {
      console.error('[LocalServer] Error cancelling job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/jobs/execute-and-wait - Submit job and wait for completion
  // This is useful for stream integration where you want background execution
  // but still need to wait for the result before continuing
  app.post('/api/jobs/execute-and-wait', async (req, res) => {
    try {
      const {
        toolName,
        args,
        options,
        timeoutMs = 300000,
      } = req.body as {
        toolName: string
        args: Record<string, any>
        options?: JobOptions
        timeoutMs?: number
      }

      if (!toolName) {
        res.status(400).json({ success: false, error: 'toolName is required' })
        return
      }

      // Submit the job
      const job = toolOrchestrator.submit(toolName, args || {}, {
        ...options,
        timeoutMs: Math.min(timeoutMs, 600000), // Max 10 minutes
      })

      // Poll for completion
      const pollInterval = 100 // ms
      const startTime = Date.now()

      while (Date.now() - startTime < timeoutMs) {
        const currentJob = toolOrchestrator.getJob(job.id)

        if (!currentJob) {
          res.status(500).json({ success: false, error: 'Job disappeared unexpectedly' })
          return
        }

        if (currentJob.status === 'completed') {
          res.json({ success: true, job: currentJob, result: currentJob.result })
          return
        }

        if (currentJob.status === 'failed') {
          res.json({ success: false, job: currentJob, error: currentJob.error })
          return
        }

        if (currentJob.status === 'cancelled') {
          res.json({ success: false, job: currentJob, error: 'Job was cancelled' })
          return
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval))
      }

      // Timeout - cancel the job
      toolOrchestrator.cancel(job.id)
      res.status(408).json({ success: false, error: 'Job execution timed out', jobId: job.id })
    } catch (error) {
      console.error('[LocalServer] Error in execute-and-wait:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })
}
