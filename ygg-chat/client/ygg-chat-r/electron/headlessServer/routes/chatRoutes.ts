import type { Express, Request, Response } from 'express'
import type { HeadlessChatOperation, HeadlessMessageRequest, HeadlessStreamEvent } from '../contracts/headlessApi.js'
import type { HeadlessChatOrchestrator } from '../services/chatOrchestrator.js'
import type { CompactionService } from '../services/compactionService.js'
import type { Decision, DecisionBroker } from '../services/decisionBroker.js'
import type { RunSessionRegistry, RunSubscriber } from '../services/runSessionRegistry.js'
import { initializeSse, startSseHeartbeat, writeSseEvent } from '../stream/sseWriter.js'

interface RegisterChatRoutesDeps {
  orchestrator: HeadlessChatOrchestrator
  compactionService?: CompactionService
  /** Shared pause/resume registry; also injected into the ChatOrchestrator. */
  decisionBroker?: DecisionBroker
  /**
   * Detach/reattach registry (gateway.resumableRuns). When present AND `resumableRuns`
   * is true, a run's lifetime is owned by its RunSession, not by the SSE socket.
   */
  runSessions?: RunSessionRegistry
  /** Master gate: when false the route keeps the legacy disconnect==abort behavior. */
  resumableRuns?: boolean
}

/** Adapt an Express SSE response to the registry's transport-agnostic sink. */
function makeSubscriber(res: Response): RunSubscriber {
  const r = res as unknown as { writableEnded?: boolean; destroyed?: boolean }
  return {
    send: frame => {
      if (r.writableEnded || r.destroyed) return
      // seq rides alongside the event so a reconnecting client can resume from a cursor.
      writeSseEvent(res, { ...(frame.event as Record<string, unknown>), seq: frame.seq })
    },
    end: () => {
      if (!r.writableEnded) res.end()
    },
  }
}

function buildHeadlessMessageRequest(req: Request, operation: HeadlessChatOperation): HeadlessMessageRequest {
  const body = req.body ?? {}

  const headerUserId = req.headers['x-user-id']
  const userIdFromHeader = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId

  const authorizationHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization

  const headerAccountId = req.headers['chatgpt-account-id']
  const accountIdFromHeader = Array.isArray(headerAccountId) ? headerAccountId[0] : headerAccountId

  const conversationIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const messageIdParam = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId

  return {
    operation,
    conversationId: conversationIdParam || '',
    parentId: body.parentId ?? body.parent_id ?? null,
    messageId: messageIdParam ?? body.messageId ?? body.message_id ?? null,
    content: body.content ?? '',
    provider: body.provider ?? 'openaichatgpt',
    modelName: body.modelName ?? body.model_name ?? 'gpt-5.6-sol',
    userId: body.userId ?? body.user_id ?? userIdFromHeader ?? null,
    accessToken: body.accessToken ?? body.access_token ?? (authorizationHeader?.replace(/^Bearer\s+/i, '') ?? null),
    accountId: body.accountId ?? body.account_id ?? accountIdFromHeader ?? null,
    systemPrompt: body.systemPrompt ?? body.system_prompt ?? null,
    conversationContext: body.conversationContext ?? body.conversation_context ?? null,
    projectContext: body.projectContext ?? body.project_context ?? null,
    think: typeof body.think === 'boolean' ? body.think : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    storageMode: body.storageMode ?? body.storage_mode ?? 'local',
    selectedFiles: body.selectedFiles ?? body.selected_files ?? [],
    attachmentsBase64: body.attachmentsBase64 ?? body.attachments_base64 ?? null,
    retrigger: typeof body.retrigger === 'boolean' ? body.retrigger : undefined,
    executionMode: body.executionMode ?? body.execution_mode ?? 'client',
    isBranch: typeof body.isBranch === 'boolean' ? body.isBranch : undefined,
    isElectron: typeof body.isElectron === 'boolean' ? body.isElectron : undefined,
    imageConfig: body.imageConfig ?? body.image_config,
    reasoningConfig: body.reasoningConfig ?? body.reasoning_config,
    subagentReasoningEffort:
      body.subagentReasoningEffort === 'low' || body.subagentReasoningEffort === 'medium' || body.subagentReasoningEffort === 'high' || body.subagentReasoningEffort === 'xhigh'
        ? body.subagentReasoningEffort
        : undefined,
    serviceTier: body.serviceTier ?? body.service_tier,
    promptCacheRetention: body.promptCacheRetention ?? body.prompt_cache_retention,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    rootPath: body.rootPath ?? body.root_path ?? body.cwd ?? null,
    operationMode: body.operationMode === 'plan' || body.operation_mode === 'plan' ? 'plan' : 'execute',
    includeOperationModePrompt:
      typeof body.includeOperationModePrompt === 'boolean'
        ? body.includeOperationModePrompt
        : typeof body.include_operation_mode_prompt === 'boolean'
          ? body.include_operation_mode_prompt
          : true,
    planModeVerbosity:
      body.planModeVerbosity === 'normal' ||
      body.planModeVerbosity === 'detailed' ||
      body.plan_mode_verbosity === 'normal' ||
      body.plan_mode_verbosity === 'detailed'
        ? (body.planModeVerbosity ?? body.plan_mode_verbosity)
        : 'concise',
    streamId: body.streamId ?? body.stream_id ?? null,
    lineageId: body.lineageId ?? body.lineage_id ?? null,
    operationId: body.operationId ?? body.operation_id ?? null,
    toolTimeoutMs:
      typeof body.toolTimeoutMs === 'number'
        ? body.toolTimeoutMs
        : typeof body.tool_timeout_ms === 'number'
          ? body.tool_timeout_ms
          : undefined,
    // CRITICAL: resolve to undefined when absent (NOT false). The mobile LAN UI never
    // sends this, and undefined must survive to the orchestrator's `!== false` test so
    // the loop defaults to auto-approve and only pauses when a caller EXPLICITLY sends false.
    toolAutoApprove:
      typeof body.toolAutoApprove === 'boolean'
        ? body.toolAutoApprove
        : typeof body.tool_auto_approve === 'boolean'
          ? body.tool_auto_approve
          : undefined,
    // Phase 3 hooks. Absent => undefined => the orchestrator's `=== true` gate leaves
    // hooks off, so the mobile LAN UI / any caller that omits it runs with no hooks.
    hooksEnabled:
      typeof body.hooksEnabled === 'boolean'
        ? body.hooksEnabled
        : typeof body.hooks_enabled === 'boolean'
          ? body.hooks_enabled
          : undefined,
    localApiBase: body.localApiBase ?? body.local_api_base ?? null,
    // Auto-compaction / context settings. Previously DROPPED here, so the orchestrator
    // received undefined and the server applied its defaults (autoCompactionEnabled ?? true;
    // contextLength ?? openAIModelContextLength(model); thresholdPercent ?? 85) — ignoring the
    // user's disable toggle, threshold, and the selected model's real window. Parsed
    // undefined-safe so the mobile LAN UI / subagents (which omit them) keep the defaults.
    autoCompactionEnabled:
      typeof body.autoCompactionEnabled === 'boolean'
        ? body.autoCompactionEnabled
        : typeof body.auto_compaction_enabled === 'boolean'
          ? body.auto_compaction_enabled
          : undefined,
    contextLength:
      typeof body.contextLength === 'number'
        ? body.contextLength
        : typeof body.context_length === 'number'
          ? body.context_length
          : undefined,
    compactionThresholdPercent:
      typeof body.compactionThresholdPercent === 'number'
        ? body.compactionThresholdPercent
        : typeof body.compaction_threshold_percent === 'number'
          ? body.compaction_threshold_percent
          : undefined,
    compactionProvider: body.compactionProvider ?? body.compaction_provider ?? null,
    compactionModelName: body.compactionModelName ?? body.compaction_model_name ?? null,
    compactionSystemPrompt: body.compactionSystemPrompt ?? body.compaction_system_prompt ?? null,
  }
}

async function runSseOrchestrator(
  orchestrator: HeadlessChatOrchestrator,
  req: Request,
  res: Response,
  operation: HeadlessChatOperation,
  opts: { runSessions?: RunSessionRegistry; resumableRuns?: boolean }
): Promise<void> {
  const body = req.body ?? {}
  const streamId = body.streamId ?? body.stream_id
  const useSession = Boolean(opts.resumableRuns && opts.runSessions && streamId)

  if (!useSession) {
    // ── Legacy path: run lifetime == connection lifetime (disconnect => abort). ──
    initializeSse(res)
    const stopHeartbeat = startSseHeartbeat(res)
    // Abort the run when the client disconnects. This both cancels in-flight
    // provider/tool work and unblocks a loop paused awaiting a permission/clarify
    // decision, so a dropped client never hangs the run.
    const abortController = new AbortController()
    let finished = false

    res.on('close', () => {
      if (!finished) abortController.abort()
    })

    try {
      const request = buildHeadlessMessageRequest(req, operation)
      await orchestrator.runMessage(
        request,
        event => {
          writeSseEvent(res, event)
        },
        abortController.signal
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeSseEvent(res, { type: 'error', error: message, lineageId: (error as any)?.lineageId ?? null })
    } finally {
      finished = true
      stopHeartbeat()
      res.end()
    }
    return
  }

  // ── Resumable path: the RunSession owns the run's lifetime. A bare client
  // disconnect DETACHES (the loop keeps running in the main process); only an explicit
  // POST /api/streams/:id/abort or the reaper cancels it. ──
  const registry = opts.runSessions!
  const conversationId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  // A fresh start supersedes any stale/lingering session for this id. streamIds are
  // unique per send, so this is virtually always a no-op.
  registry.delete(String(streamId))
  const session = registry.create(String(streamId), conversationId || null)

  initializeSse(res)
  const stopHeartbeat = startSseHeartbeat(res)
  const subscriber = makeSubscriber(res)
  res.on('close', () => {
    stopHeartbeat()
    session.detach(subscriber) // keep the run alive; only release this socket
  })
  session.attach(subscriber)

  try {
    const request = buildHeadlessMessageRequest(req, operation)
    await orchestrator.runMessage(request, event => session.publish(event), session.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    session.publish({ type: 'error', error: message, lineageId: (error as any)?.lineageId ?? null } as HeadlessStreamEvent)
  } finally {
    stopHeartbeat()
    // No res.end()/delete here: a terminal publish already released the live subscriber,
    // and the session lingers for a late reconnect until the reaper evicts it.
  }
}

export function registerChatRoutes(app: Express, deps: RegisterChatRoutesDeps): void {
  const { orchestrator, compactionService, decisionBroker, runSessions, resumableRuns } = deps

  // Pause/resume: the renderer answers a permission_required / clarify_required
  // event by resolving the paused decision on the ALREADY-OPEN SSE stream. Plain
  // JSON (not SSE). Keyed by streamId+toolCallId (conversationId is not part of the
  // broker key), so this is a flat route.
  app.post('/api/resume', (req, res) => {
    if (!decisionBroker) {
      res.status(501).json({ error: 'Decision broker not configured' })
      return
    }
    const body = req.body ?? {}
    const streamId = body.streamId ?? body.stream_id
    const toolCallId = body.toolCallId ?? body.tool_call_id
    if (!streamId || !toolCallId) {
      res.status(400).json({ error: 'streamId and toolCallId are required' })
      return
    }
    let decision: Decision
    if (typeof body.decision === 'string') {
      decision = body.decision as Decision // permission or operation-mode-upgrade decision
    } else if (body.answers !== undefined || body.cancelled !== undefined) {
      decision = { answers: body.answers, cancelled: body.cancelled } // plan_md clarify
    } else if (body.result !== undefined || body.error !== undefined) {
      decision = { result: body.result, error: body.error } // tool bridge (future)
    } else {
      res.status(400).json({ error: 'decision, answers/cancelled, or result/error is required' })
      return
    }
    const matched = decisionBroker.resolve(String(streamId), String(toolCallId), decision)
    if (matched) res.status(200).json({ success: true })
    else res.status(409).json({ success: false, error: 'No pending decision for that stream/toolCall' })
  })

  // Detach/reattach (gateway.resumableRuns). Reconnect to an in-flight run by streamId
  // and replay every buffered event after ?fromSeq. Any parked permission_required /
  // clarify_required event is in that buffer, so it re-surfaces on replay for free.
  // 410 => the run is gone (client should reload persisted messages).
  app.get('/api/streams/:streamId', (req, res) => {
    if (!runSessions || !resumableRuns) {
      res.status(501).json({ error: 'Resumable runs are not enabled' })
      return
    }
    const streamIdParam = Array.isArray(req.params.streamId) ? req.params.streamId[0] : req.params.streamId
    const session = streamIdParam ? runSessions.get(String(streamIdParam)) : undefined
    if (!session) {
      res.status(410).json({ error: 'No live run for that streamId', gone: true })
      return
    }
    const fromSeqRaw = req.query.fromSeq
    const fromSeqStr = Array.isArray(fromSeqRaw) ? fromSeqRaw[0] : fromSeqRaw
    const fromSeq = typeof fromSeqStr === 'string' ? Math.max(0, Number.parseInt(fromSeqStr, 10) || 0) : 0

    initializeSse(res)
    const stopHeartbeat = startSseHeartbeat(res)
    const subscriber = makeSubscriber(res)
    res.on('close', () => {
      stopHeartbeat()
      session.detach(subscriber)
    })

    const result = session.attach(subscriber, fromSeq)
    if (result.status === 'truncated') {
      // The client's cursor predates the retained buffer — it must reload from storage.
      writeSseEvent(res, { type: 'error', error: 'stream_buffer_truncated' })
      stopHeartbeat()
      res.end()
    } else if (result.status === 'replayed-terminal') {
      // attach() already flushed the tail and ended the subscriber.
      stopHeartbeat()
    }
    // 'attached-live': stays open; future frames + heartbeat continue.
  })

  // Explicit cancel — the ONLY thing that stops a resumable run (a bare disconnect only
  // detaches). Aborting the run signal also unblocks any paused permission/clarify wait.
  app.post('/api/streams/:streamId/abort', (req, res) => {
    if (!runSessions || !resumableRuns) {
      res.status(501).json({ error: 'Resumable runs are not enabled' })
      return
    }
    const streamIdParam = Array.isArray(req.params.streamId) ? req.params.streamId[0] : req.params.streamId
    const cancelled = streamIdParam ? runSessions.cancel(String(streamIdParam)) : false
    res.status(cancelled ? 200 : 404).json({ success: cancelled })
  })

  app.post('/api/conversations/:id/compact', async (req, res) => {
    if (!compactionService) {
      res.status(501).json({ error: 'Compaction service is not configured' })
      return
    }

    try {
      const body = req.body ?? {}
      const conversationIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
      const parentMessageId = body.parentMessageId ?? body.parent_message_id ?? null
      const messages = Array.isArray(body.messages) ? body.messages : []

      if (!conversationIdParam) {
        res.status(400).json({ error: 'conversation id is required' })
        return
      }
      if (!parentMessageId) {
        res.status(400).json({ error: 'parentMessageId is required' })
        return
      }
      if (messages.length < 2) {
        res.status(400).json({ error: 'At least two source messages are required' })
        return
      }

      const result = await compactionService.compactBranch({
        conversationId: conversationIdParam,
        parentMessageId: String(parentMessageId),
        messages,
        provider: body.provider ?? 'openaichatgpt',
        modelName: body.modelName ?? body.model_name ?? 'gpt-5.6-sol',
        userId: body.userId ?? body.user_id ?? null,
        accessToken: body.accessToken ?? body.access_token ?? null,
        accountId: body.accountId ?? body.account_id ?? null,
        systemPrompt: body.systemPrompt ?? body.system_prompt ?? null,
      })

      res.status(201).json({ success: true, message: result.message })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('not found') ? 404 : 500
      res.status(status).json({ error: message })
    }
  })

  const sseOpts = { runSessions, resumableRuns }

  app.post('/api/conversations/:id/messages', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'send', sseOpts)
  })

  app.post('/api/conversations/:id/messages/repeat', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'repeat', sseOpts)
  })

  app.post('/api/conversations/:id/messages/:messageId/branch', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'branch', sseOpts)
  })

  app.post('/api/conversations/:id/messages/:messageId/edit-branch', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'edit-branch', sseOpts)
  })
}
