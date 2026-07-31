import type { Express, Request, Response } from 'express'
import type { HeadlessChatOperation, HeadlessMessageRequest } from '../contracts/headlessApi.js'
import type { HeadlessChatOrchestrator } from '../services/chatOrchestrator.js'
import type { CompactionService } from '../services/compactionService.js'
import type { Decision, DecisionBroker } from '../services/decisionBroker.js'
import { initializeSse, startSseHeartbeat, writeSseEvent } from '../stream/sseWriter.js'

interface RegisterChatRoutesDeps {
  orchestrator: HeadlessChatOrchestrator
  compactionService?: CompactionService
  /** Shared pause/resume registry; also injected into the ChatOrchestrator. */
  decisionBroker?: DecisionBroker
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
  }
}

async function runSseOrchestrator(
  orchestrator: HeadlessChatOrchestrator,
  req: Request,
  res: Response,
  operation: HeadlessChatOperation
): Promise<void> {
  initializeSse(res)
  const stopHeartbeat = startSseHeartbeat(res)
  // Abort the run when the client disconnects. This both cancels in-flight
  // provider/tool work and (Phase 2+) unblocks a loop paused awaiting a
  // permission/clarify decision, so a dropped client never hangs the run.
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
    writeSseEvent(res, { type: 'error', error: message })
  } finally {
    finished = true
    stopHeartbeat()
    res.end()
  }
}

export function registerChatRoutes(app: Express, deps: RegisterChatRoutesDeps): void {
  const { orchestrator, compactionService, decisionBroker } = deps

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
      decision = body.decision as Decision // permission: allow_once | allow_always | deny
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

  app.post('/api/conversations/:id/messages', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'send')
  })

  app.post('/api/conversations/:id/messages/repeat', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'repeat')
  })

  app.post('/api/conversations/:id/messages/:messageId/branch', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'branch')
  })

  app.post('/api/conversations/:id/messages/:messageId/edit-branch', async (req, res) => {
    await runSseOrchestrator(orchestrator, req, res, 'edit-branch')
  })
}
