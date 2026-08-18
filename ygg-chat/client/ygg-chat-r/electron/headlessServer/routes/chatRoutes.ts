import type { Express, Request, Response } from 'express'
import type { ChatErrorCode, ChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import type { HeadlessChatOperation, HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { classifyChatError } from '../providers/providerErrorFormatter.js'
import type { HeadlessChatOrchestrator } from '../services/chatOrchestrator.js'
import type { CompactionService } from '../services/compactionService.js'
import type { Decision, DecisionBroker } from '../services/decisionBroker.js'
import type { RunSessionRegistry, RunSubscriber } from '../services/runSessionRegistry.js'
import { initializeSse, startSseHeartbeat, writeSseEvent } from '../stream/sseWriter.js'

/**
 * Did the orchestrator ALREADY publish a classified terminal frame for this error?
 *
 * `chatOrchestrator` emits its own `{type:'error', envelope}` (and `reauth_required`,
 * and the ProviderErrorAssistantResponse `complete`) before rethrowing, so the route's
 * catch used to emit a SECOND, worse terminal frame for the same failure. The renderer
 * keeps the LAST frame, so the good envelope lost to the raw `Error.message` one.
 *
 * The orchestrator marks such an error; we only fall back for exceptions that never
 * reached its catch at all (request-parse failures, throws before `runMessage`).
 * Several spellings are tolerated so this stays correct regardless of which one the
 * orchestrator settles on — `chatErrorPublished` is the canonical name.
 */
function orchestratorAlreadyPublished(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as Record<string, unknown>
  return e.chatErrorPublished === true || e.__chatErrorPublished === true || e.terminalFramePublished === true
}

/**
 * Build the route's own terminal frame for an exception the orchestrator never
 * classified. `error` keeps the raw text (logs / `envelope.detail`); `envelope` is the
 * only thing a renderer may show.
 */
function buildRouteErrorEvent(error: unknown, body: Record<string, any>): HeadlessStreamEvent {
  const message = error instanceof Error ? error.message : String(error)
  const provider = typeof body.provider === 'string' ? body.provider : undefined
  const modelName =
    typeof body.modelName === 'string' ? body.modelName : typeof body.model_name === 'string' ? body.model_name : undefined
  const envelope = classifyChatError(error, { provider, modelName, phase: 'lifecycle' })
  if (!envelope.detail) envelope.detail = message
  return {
    type: 'error',
    error: message,
    lineageId: (error as any)?.lineageId ?? null,
    envelope,
  } as HeadlessStreamEvent
}

/**
 * A non-SSE JSON error body. `error` stays the raw/technical string (logs, existing
 * callers); `envelope` carries the user-facing prose + the single call to action.
 */
function sendJsonError(
  res: Response,
  status: number,
  detail: string,
  code: ChatErrorCode,
  overrides: Partial<Omit<ChatErrorEnvelope, 'code'>> = {},
  extra: Record<string, unknown> = {}
): void {
  res.status(status).json({
    error: detail,
    ...extra,
    envelope: buildChatErrorEnvelope(code, { status, detail, ...overrides }),
  })
}

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
    // contextLength is resolved again by ProviderRouter: ChatGPT always uses the global
    // provider override mirrored into the Electron process; other providers retain the
    // selected model value. Parsed undefined-safe for mobile/direct callers.
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
      if (operation === 'branch' || operation === 'edit-branch') {
        console.error('[LineageForkDebug][Main] request-failed', {
          error: message,
          operation,
          conversationId: req.params.id ?? null,
          streamId: body.streamId ?? body.stream_id ?? null,
          operationId: body.operationId ?? body.operation_id ?? null,
          requestedLineageId: body.lineageId ?? body.lineage_id ?? null,
          sourceMessageId: req.params.messageId ?? body.messageId ?? body.message_id ?? null,
          parentId: body.parentId ?? body.parent_id ?? null,
        })
      }
      // Only a genuine fallback: if the orchestrator already published a classified
      // terminal frame, a second one here would OVERWRITE it in the renderer.
      if (!orchestratorAlreadyPublished(error)) {
        writeSseEvent(res, buildRouteErrorEvent(error, body))
      }
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
  const normalizedStreamId = String(streamId)

  initializeSse(res)
  const stopHeartbeat = startSseHeartbeat(res)
  const baseSubscriber = makeSubscriber(res)
  const subscriber: RunSubscriber = {
    send: frame => baseSubscriber.send(frame),
    end: () => {
      stopHeartbeat()
      baseSubscriber.end()
    },
  }

  // A repeated POST for the same stream is an idempotent re-attach, not a second run.
  // Starting a replacement while the old run unwinds lets its broker cleanup reject the
  // replacement branch's decisions; deleting it instead makes the old run unreachable.
  const existingSession = registry.get(normalizedStreamId)
  if (existingSession) {
    res.on('close', () => {
      stopHeartbeat()
      existingSession.detach(subscriber)
    })
    existingSession.attach(subscriber)
    return
  }

  const session = registry.create(normalizedStreamId, conversationId || null)
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
    if (operation === 'branch' || operation === 'edit-branch') {
      console.error('[LineageForkDebug][Main] request-failed', {
        error: message,
        operation,
        conversationId: req.params.id ?? null,
        streamId: body.streamId ?? body.stream_id ?? null,
        operationId: body.operationId ?? body.operation_id ?? null,
        requestedLineageId: body.lineageId ?? body.lineage_id ?? null,
        sourceMessageId: req.params.messageId ?? body.messageId ?? body.message_id ?? null,
        parentId: body.parentId ?? body.parent_id ?? null,
      })
    }
    // Same rule as the legacy path: never publish a second terminal frame over the
    // orchestrator's classified one — the session buffer replays the LAST one too.
    if (!orchestratorAlreadyPublished(error)) {
      session.publish(buildRouteErrorEvent(error, body))
    }
  } finally {
    stopHeartbeat()
    // No res.end()/delete here: a terminal publish already released the live subscriber,
    // and the session lingers for a late reconnect until the reaper evicts it.
  }
}

/**
 * Why a reattach found no session. The 410 used to mean all of these at once, which
 * is why it could not be rendered: `completed` is a SUCCESS and must never surface as
 * a hard failure, while `cancelled` and `expired` are genuine (different) endings.
 * The renderer branches on `reason`; `envelope` is what it shows if it shows anything.
 */
export type StreamGoneReason = 'cancelled' | 'completed' | 'errored' | 'expired' | 'unknown'

/**
 * Optional, additive registry capability. Once a session is evicted the registry keeps
 * nothing, so today every eviction is indistinguishable — `lastOutcome` is the tombstone
 * lookup that makes the three cases separable. Duck-typed on purpose: this route is
 * correct (degrading to `unknown`) against a registry that does not implement it.
 */
interface RunOutcomeLookup {
  lastOutcome?: (streamId: string) => StreamGoneReason | undefined
}

const STREAM_GONE_ENVELOPES: Record<StreamGoneReason, () => ChatErrorEnvelope> = {
  // Ended on purpose. Retry is the honest affordance.
  cancelled: () => buildChatErrorEnvelope('cancelled', { status: 410 }),
  // SUCCESS that outlived its linger window. Not a failure: reload and it is all there.
  completed: () =>
    buildChatErrorEnvelope('run_expired', {
      status: 410,
      userMessage: 'This reply finished while you were away. Reload the conversation to see it.',
      recoverability: 'user_action',
    }),
  // The run failed and already delivered its own error frame; the saved copy has it.
  errored: () =>
    buildChatErrorEnvelope('run_expired', {
      status: 410,
      userMessage: 'This reply ended while you were away. Reload the conversation to see what happened.',
    }),
  // Still running when it was reaped for being abandoned — genuinely cut off.
  expired: () => buildChatErrorEnvelope('stream_interrupted', { status: 410 }),
  // No tombstone: it either finished or expired, and `run_expired` says exactly that.
  unknown: () => buildChatErrorEnvelope('run_expired', { status: 410 }),
}

/** 410 for `GET /api/streams/:streamId`: `gone` is kept for existing clients. */
function sendStreamGone(res: Response, registry: RunSessionRegistry, streamId: string | null): void {
  const lookup = registry as unknown as RunOutcomeLookup
  const reason: StreamGoneReason =
    (streamId && typeof lookup.lastOutcome === 'function' ? lookup.lastOutcome(streamId) : undefined) ?? 'unknown'
  const envelope = STREAM_GONE_ENVELOPES[reason]?.() ?? STREAM_GONE_ENVELOPES.unknown()
  envelope.detail = `No live run for that streamId (${reason})`
  res.status(410).json({ error: 'No live run for that streamId', gone: true, reason, envelope })
}

export function registerChatRoutes(app: Express, deps: RegisterChatRoutesDeps): void {
  const { orchestrator, compactionService, decisionBroker, runSessions, resumableRuns } = deps

  // Pause/resume: the renderer answers a permission_required / clarify_required
  // event by resolving the paused decision on the ALREADY-OPEN SSE stream. Plain
  // JSON (not SSE). Keyed by streamId+toolCallId (conversationId is not part of the
  // broker key), so this is a flat route.
  app.post('/api/resume', (req, res) => {
    if (!decisionBroker) {
      // The user answered a permission/clarify prompt and there is nowhere to deliver
      // it — retrying can never work on this server, so this is fatal, not retryable.
      sendJsonError(res, 501, 'Decision broker not configured', 'decision_not_delivered', { recoverability: 'fatal' })
      return
    }
    const body = req.body ?? {}
    const streamId = body.streamId ?? body.stream_id
    const toolCallId = body.toolCallId ?? body.tool_call_id
    if (!streamId || !toolCallId) {
      sendJsonError(res, 400, 'streamId and toolCallId are required', 'decision_not_delivered')
      return
    }
    let decision: Decision
    if (typeof body.decision === 'string') {
      const allowedDecisions = new Set(['allow_once', 'allow_always', 'deny', 'switch_to_execute'])
      if (!allowedDecisions.has(body.decision)) {
        sendJsonError(res, 400, 'Invalid decision value', 'decision_not_delivered')
        return
      }
      decision = body.decision as Decision // permission or operation-mode-upgrade decision
    } else if (body.answers !== undefined || body.cancelled !== undefined) {
      decision = { answers: body.answers, cancelled: body.cancelled } // plan_md clarify
    } else if (body.result !== undefined || body.error !== undefined) {
      decision = { result: body.result, error: body.error } // tool bridge (future)
    } else {
      sendJsonError(res, 400, 'decision, answers/cancelled, or result/error is required', 'decision_not_delivered')
      return
    }
    const matched = decisionBroker.resolve(String(streamId), String(toolCallId), decision)
    if (matched) {
      res.status(200).json({ success: true })
    } else {
      // 409: the run already moved on (resolved, aborted, or reaped). Resending the same
      // answer cannot help, so point at a reload rather than a retry.
      sendJsonError(
        res,
        409,
        'No pending decision for that stream/toolCall',
        'decision_not_delivered',
        { action: { kind: 'reload_conversation', label: 'Reload conversation' } },
        { success: false }
      )
    }
  })

  // Detach/reattach (gateway.resumableRuns). Reconnect to an in-flight run by streamId
  // and replay every buffered event after ?fromSeq. Any parked permission_required /
  // clarify_required event is in that buffer, so it re-surfaces on replay for free.
  // 410 => the run is gone (client should reload persisted messages). The body carries
  // a `reason` discriminator + an envelope, because "gone" covers a SUCCESS that simply
  // outlived its linger window as well as a cancel and an expiry — see sendStreamGone.
  app.get('/api/streams/:streamId', (req, res) => {
    if (!runSessions || !resumableRuns) {
      // Reattach is unavailable on this server: the stream really is cut off and the
      // only recovery is to reload the persisted copy.
      sendJsonError(res, 501, 'Resumable runs are not enabled', 'stream_interrupted')
      return
    }
    const streamIdParam = Array.isArray(req.params.streamId) ? req.params.streamId[0] : req.params.streamId
    const session = streamIdParam ? runSessions.get(String(streamIdParam)) : undefined
    if (!session) {
      sendStreamGone(res, runSessions, streamIdParam ? String(streamIdParam) : null)
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
      // `error` keeps the machine token for logs; the envelope is the user-facing form.
      writeSseEvent(res, {
        type: 'error',
        error: 'stream_buffer_truncated',
        envelope: buildChatErrorEnvelope('history_truncated', {
          action: { kind: 'reload_conversation', label: 'Reload conversation' },
          detail: 'stream_buffer_truncated',
        }),
      } as HeadlessStreamEvent)
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
      // The user pressed Stop and this server cannot honour it.
      sendJsonError(res, 501, 'Resumable runs are not enabled', 'stop_not_confirmed', { recoverability: 'fatal' }, { success: false })
      return
    }
    const streamIdParam = Array.isArray(req.params.streamId) ? req.params.streamId[0] : req.params.streamId
    const cancelled = streamIdParam ? runSessions.cancel(String(streamIdParam)) : false
    if (cancelled) {
      res.status(200).json({ success: true })
      return
    }
    // No session for that id: it already ended, or it is running somewhere we cannot see.
    sendJsonError(res, 404, 'No live run for that streamId', 'stop_not_confirmed', {}, { success: false })
  })

  app.post('/api/conversations/:id/compact', async (req, res) => {
    if (!compactionService) {
      sendJsonError(res, 501, 'Compaction service is not configured', 'compaction_failed', { recoverability: 'fatal' })
      return
    }

    try {
      const body = req.body ?? {}
      const conversationIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
      const parentMessageId = body.parentMessageId ?? body.parent_message_id ?? null
      const messages = Array.isArray(body.messages) ? body.messages : []

      if (!conversationIdParam) {
        sendJsonError(res, 400, 'conversation id is required', 'server_rejected_request')
        return
      }
      if (!parentMessageId) {
        sendJsonError(res, 400, 'parentMessageId is required', 'server_rejected_request')
        return
      }
      if (messages.length < 2) {
        sendJsonError(res, 400, 'At least two source messages are required', 'server_rejected_request')
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
      // Raw text goes to `detail` only; the classifier owns what the user reads.
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('not found') ? 404 : 500
      const envelope = classifyChatError(error, { phase: 'compaction' })
      envelope.status = status
      if (!envelope.detail) envelope.detail = message
      res.status(status).json({ error: message, envelope })
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
