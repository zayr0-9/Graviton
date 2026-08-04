import type { Express } from 'express'
import type { HeadlessSubagentStreamRequest } from '../contracts/headlessApi.js'
import type { SubagentRunService } from '../services/subagentRunService.js'
import { normalizeProviderRoute } from '../services/providerRouter.js'
import { initializeSse, startSseHeartbeat, writeSseEvent } from '../stream/sseWriter.js'

interface RegisterSubagentRoutesDeps {
  runService: SubagentRunService
  /** Optional synchronous existence check run before the SSE stream is opened. */
  validateTarget?: (conversationId: string, parentMessageId: string) => { status: number; error: string } | null
}

/** undefined => use the server default tool set; [] => explicitly no tools. */
function normalizeToolNames(raw: any): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .map((tool: any) => (typeof tool === 'string' ? tool.trim() : typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter((name: string) => Boolean(name))
}

function buildSubagentStreamRequest(body: any): HeadlessSubagentStreamRequest {
  return {
    conversationId: String(body?.conversationId ?? body?.conversation_id ?? '').trim(),
    parentMessageId: String(
      body?.parentMessageId ?? body?.parent_message_id ?? body?.messageId ?? body?.message_id ?? ''
    ).trim(),
    toolCallId: body?.toolCallId ?? body?.tool_call_id ?? null,
    streamId: body?.streamId ?? body?.stream_id ?? null,
    lineageId: body?.lineageId ?? body?.lineage_id ?? null,
    prompt: typeof body?.prompt === 'string' ? body.prompt : '',
    systemPrompt:
      typeof body?.systemPrompt === 'string'
        ? body.systemPrompt
        : typeof body?.system_prompt === 'string'
          ? body.system_prompt
          : null,
    provider: typeof body?.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'openaichatgpt',
    modelName:
      typeof body?.modelName === 'string' && body.modelName.trim()
        ? body.modelName.trim()
        : typeof body?.model === 'string' && body.model.trim()
          ? body.model.trim()
          : 'gpt-5.6-sol',
    tools: normalizeToolNames(body?.tools),
    maxTurns: typeof body?.maxTurns === 'number' ? body.maxTurns : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    reasoningEffort:
      body?.reasoningEffort === 'low' || body?.reasoningEffort === 'medium' || body?.reasoningEffort === 'high' || body?.reasoningEffort === 'xhigh'
        ? body.reasoningEffort
        : undefined,
    operationMode: body?.operationMode === 'plan' || body?.operation_mode === 'plan' ? 'plan' : 'execute',
    autoApprove: body?.autoApprove === true || body?.auto_approve === true,
    rootPath: typeof body?.rootPath === 'string' ? body.rootPath : typeof body?.root_path === 'string' ? body.root_path : null,
    userId: typeof body?.userId === 'string' ? body.userId : typeof body?.user_id === 'string' ? body.user_id : null,
    accessToken: typeof body?.accessToken === 'string' ? body.accessToken : null,
    accountId: typeof body?.accountId === 'string' ? body.accountId : null,
    toolTimeoutMs: typeof body?.toolTimeoutMs === 'number' ? body.toolTimeoutMs : undefined,
    autoCompactionEnabled: typeof body?.autoCompactionEnabled === 'boolean' ? body.autoCompactionEnabled : undefined,
    contextLength: typeof body?.contextLength === 'number' ? body.contextLength : undefined,
    compactionThresholdPercent:
      typeof body?.compactionThresholdPercent === 'number' ? body.compactionThresholdPercent : undefined,
  }
}

export function registerSubagentRoutes(app: Express, deps: RegisterSubagentRoutesDeps): void {
  // Persisted transcript viewer (Phase 5): resolve the run(s) a given provider tool
  // call spawned, WITH their transcripts, so the renderer can show the full subagent
  // conversation after the fact. One tool call maps to one run in practice, but the
  // repo returns an array (kept as-is here) so a multi-run tool call still renders.
  app.get('/api/subagents/by-tool-call/:toolCallId', (req, res) => {
    const toolCallId = String(req.params.toolCallId ?? '').trim()
    if (!toolCallId) {
      res.status(400).json({ error: 'toolCallId is required' })
      return
    }
    const runs = deps.runService.listByToolCall(toolCallId)
    res.json({ runs })
  })

  app.post('/api/headless/subagent/stream', async (req, res) => {
    const request = buildSubagentStreamRequest(req.body ?? {})

    // Validate before opening the SSE stream so we can return real HTTP statuses.
    if (!request.conversationId) {
      res.status(400).json({ error: 'conversationId is required' })
      return
    }
    if (!request.parentMessageId) {
      res.status(400).json({ error: 'parentMessageId is required' })
      return
    }
    if (!request.prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    if (normalizeProviderRoute(request.provider) === 'openrouter') {
      res.status(400).json({ error: 'OpenRouter subagents are not supported by the local engine.' })
      return
    }
    const validation = deps.validateTarget?.(request.conversationId, request.parentMessageId)
    if (validation) {
      res.status(validation.status).json({ error: validation.error })
      return
    }

    initializeSse(res)
    const stopHeartbeat = startSseHeartbeat(res)
    const abortController = new AbortController()
    let finished = false

    res.on('close', () => {
      if (!finished) abortController.abort()
    })

    try {
      await deps.runService.run(request, event => writeSseEvent(res, event), abortController.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeSseEvent(res, { type: 'error', error: message })
    } finally {
      finished = true
      stopHeartbeat()
      res.end()
    }
  })
}
