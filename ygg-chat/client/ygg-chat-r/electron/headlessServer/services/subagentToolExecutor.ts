import type { HeadlessSubagentStreamRequest } from '../contracts/headlessApi.js'
import type { ProviderToolCall } from '../providers/openRouterProvider.js'
import type { SubagentRunRow, SubagentRunStatus } from '../persistence/subagentRunRepo.js'
import type { ToolExecutionContext, ToolExecutor } from './toolLoopService.js'
import { getHeadlessSubagentModePrompt } from './headlessSystemPrompt.js'

const DEFAULT_SUBAGENT_MODEL = 'gpt-5.6-sol'

export interface ProgrammaticSubagentRunner {
  runForTool(request: HeadlessSubagentStreamRequest, signal: AbortSignal): Promise<string>
}

/**
 * Everything the subagent_manager interceptor needs from the run service. The
 * SubagentRunService implements it; tests provide a fake. spawn/cancel/isActive
 * come from the Phase 1 engine; getRunByHandle/listByLineage are the read side
 * that enforces branch ownership.
 */
export interface SubagentManagerRunner {
  spawnDetached(
    request: HeadlessSubagentStreamRequest
  ): Promise<{ handle: string | null; runId: string; streamId: string }>
  spawnBlocking(
    request: HeadlessSubagentStreamRequest,
    signal: AbortSignal
  ): Promise<{
    handle: string | null
    runId: string
    streamId: string
    status: SubagentRunStatus
    result: string
    error: string | null
  }>
  resumeDetached(
    runId: string,
    request: HeadlessSubagentStreamRequest
  ): Promise<{ handle: string | null; runId: string; streamId: string } | null>
  cancel(handle: string): boolean
  isActive(handle: string): boolean
  getRunByHandle(handle: string): SubagentRunRow | null
  listByLineage(lineageId: string, status?: SubagentRunStatus): SubagentRunRow[]
}

function parseArguments(toolCall: ProviderToolCall): Record<string, any> {
  if (typeof toolCall.arguments !== 'string') return toolCall.arguments ?? {}
  try {
    const parsed = JSON.parse(toolCall.arguments)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function buildSubagentRequest(toolCall: ProviderToolCall, context: ToolExecutionContext): HeadlessSubagentStreamRequest {
  const args = parseArguments(toolCall)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) throw new Error('Subagent requires a prompt')

  const inheritedProvider = context.provider || 'openaichatgpt'
  const provider = inheritedProvider === 'openrouter' ? 'openaichatgpt' : inheritedProvider
  const modelName = inheritedProvider === 'openrouter' ? DEFAULT_SUBAGENT_MODEL : context.modelName || DEFAULT_SUBAGENT_MODEL
  const useRequestedTools = args.orchestratorMode === true && Array.isArray(args.tools)
  const tools = useRequestedTools
    ? [
        ...new Set(
          [...args.tools, 'multi_call'].filter(
            (name: unknown): name is string =>
              typeof name === 'string' && name.trim() !== 'subagent' && name.trim() !== 'subagent_manager'
          )
        ),
      ]
    : undefined
  const requestedSystemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt.trim() : ''
  const systemPrompt = [getHeadlessSubagentModePrompt(), requestedSystemPrompt].filter(Boolean).join('\n\n')

  return {
    conversationId: context.conversationId,
    parentMessageId: context.messageId,
    toolCallId: toolCall.id,
    streamId: context.streamId ?? null,
    // ToolExecutionContext gains lineage at the parent loop boundary. Keep the
    // structural intersection compatible while that additive type lands.
    lineageId: (context as ToolExecutionContext & { lineageId?: string | null }).lineageId ?? null,
    prompt,
    systemPrompt: systemPrompt || null,
    provider,
    modelName,
    tools,
    temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
    reasoningEffort: context.subagentReasoningEffort,
    operationMode: context.operationMode ?? 'execute',
    autoApprove: args.inheritAutoApprove !== false && context.autoApprove !== false,
    rootPath: context.rootPath ?? null,
    userId: null,
    toolTimeoutMs: context.timeoutMs,
  }
}

/**
 * Build the request that continues an EXISTING run. Identity (conversation,
 * parent, tool call, lineage, provider, model, system prompt, prompt) comes from
 * the persisted run row so the resume targets the same content ownership; the
 * live execution context supplies rootPath / autoApprove / reasoning / timeout and
 * (via the service's token refresh) auth. Tools are left undefined so the resumed
 * run gets the standard subagent tool set — the original per-run tool list is not
 * persisted.
 */
function buildResumeRequest(run: SubagentRunRow, context: ToolExecutionContext): HeadlessSubagentStreamRequest {
  const inheritedProvider = run.provider || context.provider || 'openaichatgpt'
  const provider = inheritedProvider === 'openrouter' ? 'openaichatgpt' : inheritedProvider
  return {
    conversationId: run.conversation_id,
    parentMessageId: run.parent_message_id,
    toolCallId: run.tool_call_id,
    streamId: context.streamId ?? null,
    lineageId: run.lineage_id,
    prompt: run.prompt ?? '',
    systemPrompt: run.system_prompt ?? null,
    provider,
    modelName: run.model_name || context.modelName || DEFAULT_SUBAGENT_MODEL,
    tools: undefined,
    reasoningEffort: context.subagentReasoningEffort,
    operationMode: context.operationMode ?? 'execute',
    autoApprove: context.autoApprove !== false,
    rootPath: context.rootPath ?? null,
    userId: null,
    toolTimeoutMs: context.timeoutMs,
  }
}

/**
 * Intercept the model-visible `subagent` tool before ordinary calls enter the
 * ToolOrchestrator registry. Child runs receive only the leaf executor, which
 * preserves the no-nested-subagents invariant.
 */
export function createSubagentDispatchExecutor(deps: {
  leafExecutor: ToolExecutor
  subagentRunner: ProgrammaticSubagentRunner
}): ToolExecutor {
  return async (toolCall, context) => {
    if (toolCall.name !== 'subagent') return deps.leafExecutor(toolCall, context)

    const signal = context.signal ?? new AbortController().signal
    const request = buildSubagentRequest(toolCall, context)
    return deps.subagentRunner.runForTool(request, signal)
  }
}

const VALID_STATUSES: ReadonlySet<SubagentRunStatus> = new Set<SubagentRunStatus>([
  'running',
  'completed',
  'error',
  'aborted',
])

function normalizeStatusFilter(value: unknown): SubagentRunStatus | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim() as SubagentRunStatus
  return VALID_STATUSES.has(trimmed) ? trimmed : undefined
}

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() || null
}

function isResumable(status: string): boolean {
  return status === 'error' || status === 'aborted'
}

/**
 * Branch ownership check. lineage_id is the anchor (distinct per parallel branch,
 * stable across turns/sends/resume); conversation_id is a defensive second gate.
 * A null owner lineage can never own a run — the anchor must be a real branch id,
 * so a legacy/unlineaged caller sees nothing rather than matching null==null.
 */
function ownsRun(run: SubagentRunRow, context: ToolExecutionContext): boolean {
  const owner = context.lineageId ?? null
  return !!owner && run.lineage_id === owner && run.conversation_id === context.conversationId
}

/** Concise, transcript-free view returned to the model for list/status/spawn. */
function toRunView(run: SubagentRunRow, live: boolean): Record<string, any> {
  const view: Record<string, any> = {
    handle: run.handle,
    runId: run.id,
    status: run.status,
    live,
    resumable: isResumable(run.status),
    promptPreview: (run.prompt ?? '').slice(0, 200),
    toolCallId: run.tool_call_id,
    turnsUsed: run.turns_used,
    toolCallsUsed: run.tool_calls_used,
    attempt: run.attempt,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }
  if (run.error) view.error = run.error
  if (run.status === 'completed' && run.final_response) view.result = run.final_response
  return view
}

function notOwnedResult(action: string, handle: string): Record<string, any> {
  // Deliberately identical whether the handle is unknown or owned by another
  // branch — a branch must not be able to probe another branch's handles.
  return {
    action,
    handle,
    found: false,
    message: `No sub-agent with handle ${handle} is owned by this branch.`,
  }
}

async function managerSpawn(
  runner: SubagentManagerRunner,
  toolCall: ProviderToolCall,
  context: ToolExecutionContext,
  args: Record<string, any>
): Promise<Record<string, any>> {
  const request = buildSubagentRequest(toolCall, context)
  if (args.blocking === true) {
    const signal = context.signal ?? new AbortController().signal
    const outcome = await runner.spawnBlocking(request, signal)
    const result: Record<string, any> = {
      action: 'spawn',
      blocking: true,
      handle: outcome.handle,
      runId: outcome.runId,
      status: outcome.status,
      resumable: isResumable(outcome.status),
    }
    if (outcome.status === 'completed') result.result = outcome.result
    if (outcome.error) result.error = outcome.error
    return result
  }

  const { handle, runId, streamId } = await runner.spawnDetached(request)
  return {
    action: 'spawn',
    blocking: false,
    handle,
    runId,
    streamId,
    status: 'running',
    message:
      `Sub-agent started in the background with handle ${handle}. ` +
      `Keep working; poll subagent_manager {action:"status", handle:"${handle}"} for progress, ` +
      `or {action:"list"} to see all sub-agents owned by this branch.`,
  }
}

function managerList(
  runner: SubagentManagerRunner,
  context: ToolExecutionContext,
  args: Record<string, any>
): Record<string, any> {
  const owner = context.lineageId ?? null
  if (!owner) {
    return { action: 'list', count: 0, subagents: [], note: 'No branch lineage in context; nothing to list.' }
  }
  const statusFilter = normalizeStatusFilter(args.status)
  const runs = runner
    .listByLineage(owner, statusFilter)
    // Defense in depth: lineage is already per-branch, but re-scope by conversation.
    .filter(run => run.conversation_id === context.conversationId)
  return {
    action: 'list',
    count: runs.length,
    ...(statusFilter ? { statusFilter } : {}),
    subagents: runs.map(run => toRunView(run, run.handle ? runner.isActive(run.handle) : false)),
  }
}

function managerStatus(
  runner: SubagentManagerRunner,
  context: ToolExecutionContext,
  args: Record<string, any>
): Record<string, any> {
  const handle = normalizeHandle(args.handle)
  if (!handle) throw new Error('subagent_manager status: a handle is required.')
  const run = runner.getRunByHandle(handle)
  if (!run || !ownsRun(run, context)) return notOwnedResult('status', handle)
  return { action: 'status', found: true, subagent: toRunView(run, runner.isActive(handle)) }
}

function managerCancel(
  runner: SubagentManagerRunner,
  context: ToolExecutionContext,
  args: Record<string, any>
): Record<string, any> {
  const handle = normalizeHandle(args.handle)
  if (!handle) throw new Error('subagent_manager cancel: a handle is required.')
  const run = runner.getRunByHandle(handle)
  if (!run || !ownsRun(run, context)) return { ...notOwnedResult('cancel', handle), cancelled: false }
  const cancelled = runner.cancel(handle)
  return {
    action: 'cancel',
    handle,
    cancelled,
    status: cancelled ? 'aborting' : run.status,
    message: cancelled
      ? `Sub-agent ${handle} is being aborted.`
      : `Sub-agent ${handle} is not currently running (status: ${run.status}); nothing to cancel.`,
  }
}

async function managerResume(
  runner: SubagentManagerRunner,
  context: ToolExecutionContext,
  args: Record<string, any>
): Promise<Record<string, any>> {
  const handle = normalizeHandle(args.handle)
  if (!handle) throw new Error('subagent_manager resume: a handle is required.')
  const run = runner.getRunByHandle(handle)
  if (!run || !ownsRun(run, context)) return { ...notOwnedResult('resume', handle), resumed: false }

  // Only a terminated run can resume. running -> already going; completed -> done.
  if (!isResumable(run.status)) {
    return {
      action: 'resume',
      handle,
      resumed: false,
      status: run.status,
      message:
        run.status === 'running'
          ? `Sub-agent ${handle} is already running; poll status instead of resuming.`
          : `Sub-agent ${handle} already completed; there is nothing to resume.`,
    }
  }

  const request = buildResumeRequest(run, context)
  const outcome = await runner.resumeDetached(run.id, request)
  if (!outcome) {
    // Lost the reopen CAS race (another caller resumed it, or it is no longer terminal).
    const latest = runner.getRunByHandle(handle)
    return {
      action: 'resume',
      handle,
      resumed: false,
      status: latest?.status ?? run.status,
      message: `Sub-agent ${handle} could not be resumed (its status changed); poll status.`,
    }
  }
  return {
    action: 'resume',
    handle,
    runId: outcome.runId,
    streamId: outcome.streamId,
    resumed: true,
    status: 'running',
    message:
      `Sub-agent ${handle} resumed in the background from its saved transcript. ` +
      `Poll subagent_manager {action:"status", handle:"${handle}"} for progress.`,
  }
}

/**
 * Intercept the global `subagent_manager` tool before ordinary calls reach the
 * registry. Every action reads the full ToolExecutionContext (crucially
 * `lineageId`, which an orchestrator-registered handler would drop) so list /
 * status / cancel / resume can enforce branch ownership. Non-manager tools —
 * including the legacy `subagent` tool — fall through to the leaf executor
 * (compose this over createSubagentDispatchExecutor). This never runs for a
 * child, so no-nested-subagents holds.
 */
export function createSubagentManagerExecutor(deps: {
  leafExecutor: ToolExecutor
  runner: SubagentManagerRunner
}): ToolExecutor {
  return async (toolCall, context) => {
    if (toolCall.name !== 'subagent_manager') return deps.leafExecutor(toolCall, context)

    const args = parseArguments(toolCall)
    const action = typeof args.action === 'string' ? args.action.trim() : ''
    switch (action) {
      case 'spawn':
        return managerSpawn(deps.runner, toolCall, context, args)
      case 'list':
        return managerList(deps.runner, context, args)
      case 'status':
        return managerStatus(deps.runner, context, args)
      case 'cancel':
        return managerCancel(deps.runner, context, args)
      case 'resume':
        return managerResume(deps.runner, context, args)
      default:
        throw new Error(
          `subagent_manager: unknown action "${action || '(missing)'}". Use spawn | list | status | cancel | resume.`
        )
    }
  }
}
