import type {
  HeadlessStreamEvent,
  HeadlessSubagentStreamEvent,
  HeadlessSubagentStreamRequest,
} from '../../../../../shared/headlessApi.js'
import {
  SubagentRunRepo,
  type SubagentMessageRow,
  type SubagentRunRow,
  type SubagentRunStatus,
} from '../persistence/subagentRunRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import type { ProviderToolCall, ProviderToolDefinition } from '../providers/openRouterProvider.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import type { RunSession, RunSessionRegistry } from './runSessionRegistry.js'
import { ProviderRouter } from './providerRouter.js'
import type { GenerateCompactionSummaryInput } from './compactionService.js'
import { SubagentTranscriptSink } from './subagentTranscriptSink.js'
import {
  ProviderEmptyResponseError,
  ProviderErrorAssistantResponse,
  ToolLoopService,
  type ToolExecutor,
  type ToolLoopCompactor,
} from './toolLoopService.js'
import {
  assertToolAllowedWithoutAutoApprove,
  filterToolsForOperationMode,
} from '../../../../../shared/operationModeToolPolicy.js'

export interface ResolvedSubagentTools {
  tools: ProviderToolDefinition[]
  resolvedNames: string[]
  unknownNames: string[]
}

/** Minimal surface the engine needs from CompactionService (eases testing). */
export interface CompactionSummaryGenerator {
  generateCompactionSummary(input: GenerateCompactionSummaryInput): Promise<string>
}

interface SubagentRunServiceDeps {
  statements?: any
  runRepo?: SubagentRunRepo
  streamingRunRepo?: StreamingRunRepo
  tokenStore?: ProviderTokenStore
  providerRouter?: ProviderRouter
  toolExecutor: ToolExecutor
  resolveToolsByName: (names: string[] | undefined) => ResolvedSubagentTools
  compactionService: CompactionSummaryGenerator
  refreshProviderTokens?: (provider: string) => Promise<void> | void
  providerTurnTimeoutMs?: number
  /**
   * When provided, each run publishes its stream events into a RunSession keyed by
   * its child streamId, so the shared GET /api/streams/:streamId route can replay
   * a live/terminal run to the transcript viewer. Omitted (e.g. resumable runs off)
   * => background runs simply don't stream live; the persisted transcript still works.
   */
  runSessions?: RunSessionRegistry
}

const DEFAULT_MODEL = 'gpt-5.6-sol'
const DEFAULT_MAX_TURNS = 120
const MAX_MAX_TURNS = 400
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 180_000
/** Synthetic tool_result for a tool_use interrupted by a crash/suspension (never re-executed). */
const INTERRUPTED_TOOL_RESULT =
  '[interrupted: the sub-agent was suspended before this tool finished. Treat it as failed and continue.]'
/** Marks a run whose loop was lost to a process restart while still 'running'. */
const ORPHANED_RUN_ERROR = 'Interrupted by a server restart before completing. Resume to continue.'
const THINKING_WRAPPER_PATTERN = /<thinking>[\s\S]*?<\/thinking>\s*/gi

function stripThinkingWrapper(text: string): string {
  if (!text) return ''
  return text.replace(THINKING_WRAPPER_PATTERN, '').trim()
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as any).name === 'AbortError'
}

function createAbortError(message = 'Subagent wait aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function clampMaxTurns(value: number | undefined): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_TURNS
  return Math.max(1, Math.min(requested, MAX_MAX_TURNS))
}

/** Persisted run context produced before the loop drives; carries the ids the manager needs. */
interface PreparedSubagentRun {
  runId: string
  handle: string | null
  subStreamId: string
  userMessage: SubagentMessageRow
  provider: string
  modelName: string
  operationMode: 'plan' | 'execute'
  maxTurns: number
  tools: ProviderToolDefinition[]
  resolvedToolNames: string[]
}

/** A detached (async) attempt tracked in-process for cancel and event-driven wait. */
interface ActiveSubagentRun {
  runId: string
  controller: AbortController
  completion: Promise<void>
}

/**
 * Overrides driveRun uses to continue an existing run instead of starting fresh:
 * the rebuilt transcript as the loop history, no new user turn, the tail message as
 * the assistant parent, and the count of turns already spent (so the remaining
 * budget and the persisted turns_used stay correct across the resume).
 */
interface ResumeState {
  history: any[]
  userContent: string
  assistantParentId: string | null
  priorTurns: number
}

const NOOP_EMIT = (_event: HeadlessSubagentStreamEvent): void => {}

export class SubagentRunService {
  private readonly runRepo: SubagentRunRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly providerRouter: ProviderRouter
  private readonly toolExecutor: ToolExecutor
  private readonly resolveToolsByName: (names: string[] | undefined) => ResolvedSubagentTools
  private readonly compactionService: CompactionSummaryGenerator
  private readonly refreshProviderTokens?: (provider: string) => Promise<void> | void
  private readonly providerTurnTimeoutMs: number
  private readonly runSessions?: RunSessionRegistry
  /** handle -> live detached attempt, shared by cancel(handle) and waitForTerminal(handle). */
  private readonly activeRuns = new Map<string, ActiveSubagentRun>()

  constructor(deps: SubagentRunServiceDeps) {
    this.runRepo = deps.runRepo ?? new SubagentRunRepo({ statements: deps.statements })
    this.streamingRunRepo = deps.streamingRunRepo ?? new StreamingRunRepo({ statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.toolExecutor = deps.toolExecutor
    this.resolveToolsByName = deps.resolveToolsByName
    this.compactionService = deps.compactionService
    this.refreshProviderTokens = deps.refreshProviderTokens
    this.providerTurnTimeoutMs = Math.max(5_000, deps.providerTurnTimeoutMs ?? DEFAULT_PROVIDER_TURN_TIMEOUT_MS)
    this.runSessions = deps.runSessions
  }

  /**
   * Run a subagent from another server-owned tool loop and return its final text.
   * The normal lifecycle events are still produced internally, so persistence and
   * terminal-state handling stay identical to the SSE route.
   */
  async runForTool(request: HeadlessSubagentStreamRequest, signal: AbortSignal): Promise<string> {
    let result: string | null = null
    let terminalError: string | null = null

    await this.run(
      request,
      event => {
        if (event.type === 'complete' && 'result' in event) {
          result = event.result
        } else if (event.type === 'error') {
          terminalError = event.error
        }
      },
      signal
    )

    if (signal.aborted) {
      const abortError = new Error(terminalError || 'Subagent aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (terminalError) throw new Error(terminalError)
    if (result === null) throw new Error('Subagent ended without a terminal result')
    return result
  }

  async run(
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const prepared = await this.prepareRun(request, emit)
    await this.driveRun(prepared, request, emit, signal)
  }

  /**
   * Fire-and-forget spawn for the subagent manager. Persists the run far enough to
   * return its handle immediately, then drives the loop in the BACKGROUND under an
   * owned AbortController (registered by handle so cancel(handle) works). The run
   * outlives the spawning tool call. driveRun persists all terminal state; the
   * .catch is a backstop for an unexpected throw outside driveRun's own try.
   */
  async spawnDetached(
    request: HeadlessSubagentStreamRequest
  ): Promise<{ handle: string | null; runId: string; streamId: string }> {
    const prepared = await this.prepareRun(request, NOOP_EMIT)
    this.startDetachedAttempt(prepared, request)
    return { handle: prepared.handle, runId: prepared.runId, streamId: prepared.subStreamId }
  }

  /**
   * Cancel a detached run by handle. Returns true if a live run was found and
   * signalled to abort (driveRun then marks it 'aborted'); false if no live run
   * maps to the handle (already terminal, unknown, or blocking).
   */
  cancel(handle: string): boolean {
    const active = this.activeRuns.get(handle)
    if (!active) return false
    active.controller.abort()
    return true
  }

  /** True if the handle maps to a run currently executing in THIS process. */
  isActive(handle: string): boolean {
    return this.activeRuns.has(handle)
  }

  /**
   * Wait for one detached handle to reach a persisted terminal state without
   * polling. Aborting the supplied signal releases only this waiter; it never
   * aborts the detached child (cancel(handle) owns that behavior).
   */
  async waitForTerminal(handle: string, signal?: AbortSignal): Promise<SubagentRunRow | null> {
    for (;;) {
      const run = this.runRepo.getRunByHandle(handle)
      if (!run || run.status !== 'running') return run

      const active = this.activeRuns.get(handle)
      if (!active || active.runId !== run.id) {
        // Close the completion/cleanup race before declaring a broken lifecycle.
        const latest = this.runRepo.getRunByHandle(handle)
        if (!latest || latest.status !== 'running') return latest
        throw new Error(`Sub-agent ${handle} is marked running but has no active runtime in this process.`)
      }

      await awaitWithAbort(active.completion, signal)
      // Re-read persistence after the attempt settles. If another caller resumed
      // the same handle concurrently, loop and wait for that newer attempt too.
    }
  }

  /**
   * Blocking spawn for the subagent manager. Uses the SAME prepareRun/driveRun
   * engine and persistence as spawnDetached — the only difference is that it
   * awaits the loop and returns the terminal outcome inline (handle + result +
   * status). Unlike runForTool it does NOT throw on a subagent-level error: the
   * manager surfaces error/aborted structurally so the model can choose to
   * resume or spawn anew. driveRun still persists every terminal state.
   */
  async spawnBlocking(
    request: HeadlessSubagentStreamRequest,
    signal: AbortSignal
  ): Promise<{
    handle: string | null
    runId: string
    streamId: string
    status: SubagentRunStatus
    result: string
    error: string | null
  }> {
    let result = ''
    let terminalError: string | null = null
    let aborted = false
    const emit = (event: HeadlessSubagentStreamEvent): void => {
      if (event.type === 'complete' && 'result' in event) {
        result = event.result
      } else if (event.type === 'error') {
        terminalError = event.error
        if ((event as { aborted?: boolean }).aborted) aborted = true
      }
    }
    const prepared = await this.prepareRun(request, emit)
    await this.driveRun(prepared, request, emit, signal)
    const status: SubagentRunStatus = aborted || signal.aborted ? 'aborted' : terminalError ? 'error' : 'completed'
    return {
      handle: prepared.handle,
      runId: prepared.runId,
      streamId: prepared.subStreamId,
      status,
      result,
      error: terminalError,
    }
  }

  /**
   * Resume a previously-terminated run (error|aborted) IN THE BACKGROUND under an
   * owned AbortController, reusing the SAME runId + handle but a NEW streamId. The
   * status gate is the atomic reopenRun CAS: if it does not transition (the run is
   * already running or completed), this returns null and drives nothing — the
   * caller reports "not resumable". Otherwise the persisted transcript is repaired
   * (dangling tool_use) and replayed as history, and driveRun continues from there.
   */
  async resumeDetached(
    runId: string,
    request: HeadlessSubagentStreamRequest
  ): Promise<{ handle: string | null; runId: string; streamId: string } | null> {
    // Reopen first, then immediately reserve the handle's lifecycle entry before
    // any asynchronous preparation. A concurrent waiter can now attach during
    // token refresh/tool resolution instead of observing a running row with no
    // local runtime owner.
    if (!this.runRepo.reopenRun(runId)) return null
    const reopened = this.runRepo.getRunById(runId)
    const handle = reopened?.handle ?? null
    const controller = new AbortController()
    let settleCompletion!: () => void
    const completion = new Promise<void>(resolve => {
      settleCompletion = resolve
    })
    const entry: ActiveSubagentRun = { runId, controller, completion }
    if (handle) this.activeRuns.set(handle, entry)

    let prepared: { prepared: PreparedSubagentRun; resumeState: ResumeState }
    try {
      prepared = await this.prepareResume(runId, request, NOOP_EMIT)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runRepo.updateRun(runId, { status: 'error', error: message })
      settleCompletion()
      if (handle && this.activeRuns.get(handle) === entry) this.activeRuns.delete(handle)
      throw error
    }

    void this.driveRun(prepared.prepared, request, NOOP_EMIT, controller.signal, prepared.resumeState)
      .catch(error => this.persistUnexpectedFailure(prepared.prepared, error))
      .finally(() => {
        settleCompletion()
        if (handle && this.activeRuns.get(handle) === entry) this.activeRuns.delete(handle)
      })
    return { handle: prepared.prepared.handle, runId, streamId: prepared.prepared.subStreamId }
  }

  /** Register and drive one detached attempt. Cleanup is identity-safe so an old
   * attempt cannot delete a newer resumed attempt stored under the same handle. */
  private startDetachedAttempt(
    prepared: PreparedSubagentRun,
    request: HeadlessSubagentStreamRequest,
    resumeState?: ResumeState
  ): void {
    const controller = new AbortController()
    let entry!: ActiveSubagentRun
    const completion = this.driveRun(prepared, request, NOOP_EMIT, controller.signal, resumeState)
      .catch(error => this.persistUnexpectedFailure(prepared, error))
      .finally(() => {
        if (prepared.handle && this.activeRuns.get(prepared.handle) === entry) {
          this.activeRuns.delete(prepared.handle)
        }
      })
    entry = { runId: prepared.runId, controller, completion }
    if (prepared.handle) this.activeRuns.set(prepared.handle, entry)
  }

  /**
   * Startup reconciler: any run still marked 'running' at process start is a crash
   * orphan (a fresh process owns no live loop), so flip it to a resumable 'error'.
   * driveRun has no finally that could have done this on crash. Returns the count
   * reconciled. Idempotent — a second call finds nothing left running.
   */
  reconcileOrphanedRuns(): number {
    const orphans = this.runRepo.listRunning()
    for (const run of orphans) {
      this.runRepo.updateRun(run.id, { status: 'error', error: ORPHANED_RUN_ERROR })
    }
    return orphans.length
  }

  /**
   * Publish one stream event into the run's RunSession (when sessions are enabled)
   * so GET /api/streams/:streamId can replay it to the transcript viewer. Best
   * effort — a publish failure never disrupts the run.
   */
  private publishToSession(streamId: string, event: HeadlessSubagentStreamEvent): void {
    const session: RunSession | undefined = this.runSessions?.get(streamId)
    if (!session) return
    try {
      session.publish(event as unknown as HeadlessStreamEvent)
    } catch (error) {
      console.warn('[subagent] session publish failed (continuing):', error)
    }
  }

  /** Resolve a run by its 6-digit handle (manager status/cancel/resume ownership checks). */
  getRunByHandle(handle: string): SubagentRunRow | null {
    return this.runRepo.getRunByHandle(handle)
  }

  /** Runs owned by a content lineage (+ optional status) — backs the manager's branch-scoped list. */
  listByLineage(lineageId: string, status?: SubagentRunStatus): SubagentRunRow[] {
    return this.runRepo.listByLineage(lineageId, status)
  }

  /** All runs spawned by a given provider tool call, WITH transcripts — backs the UI viewer route. */
  listByToolCall(toolCallId: string): SubagentRunRow[] {
    return this.runRepo.listByToolCall(toolCallId)
  }

  /**
   * The current (latest) child streamId for a tool call, so the transcript viewer
   * can subscribe to GET /api/streams/:streamId for live progress. Resolves the
   * resumed attempt's stream after a resume. Null when there's no subagent stream.
   */
  latestStreamIdForToolCall(toolCallId: string): string | null {
    return this.streamingRunRepo.latestSubagentStreamIdByToolCall(toolCallId)
  }

  private async prepareRun(
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void
  ): Promise<PreparedSubagentRun> {
    const provider =
      typeof request.provider === 'string' && request.provider.trim() ? request.provider.trim() : 'openaichatgpt'
    const modelName =
      typeof request.modelName === 'string' && request.modelName.trim() ? request.modelName.trim() : DEFAULT_MODEL
    const operationMode = request.operationMode === 'plan' ? 'plan' : 'execute'
    const maxTurns = clampMaxTurns(request.maxTurns)

    // Refresh provider auth from the Electron store in case the user signed in
    // or tokens rotated after the server started.
    try {
      await this.refreshProviderTokens?.(provider)
    } catch (error) {
      console.warn('[subagent] provider token refresh failed (continuing):', error)
    }

    const resolved = this.resolveToolsByName(request.tools)
    let tools = resolved.tools
    if (operationMode === 'plan') {
      tools = filterToolsForOperationMode(
        tools.map(tool => ({ ...tool, isMcp: tool.name.startsWith('mcp__') })),
        'plan'
      )
    }
    const resolvedToolNames = tools.map(tool => tool.name)

    const run = this.runRepo.createRun({
      conversationId: request.conversationId,
      lineageId: request.lineageId ?? null,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      prompt: request.prompt,
      provider,
      modelName,
      systemPrompt: request.systemPrompt ?? null,
      status: 'running',
    })
    const runId = run.id

    // Child streaming_runs row uses a fresh run id while retaining content ownership.
    const subStreamId = this.streamingRunRepo.upsert({
      lineageId: request.lineageId ?? null,
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      streamType: 'subagent',
      source: 'subagent',
      operation: 'subagent',
      provider,
      modelName,
      toolCallId: request.toolCallId ?? null,
      parentStreamId: request.streamId ?? null,
      metadata: { subagent_run_id: runId },
    })

    // Session keyed by the child streamId so GET /api/streams/:streamId can replay
    // this run live to the transcript viewer (created before the first publish).
    this.runSessions?.create(subStreamId, request.conversationId)

    const startedEvent: HeadlessSubagentStreamEvent = {
      type: 'started',
      operation: 'subagent',
      subagentRunId: runId,
      streamId: subStreamId,
      lineageId: request.lineageId ?? null,
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      provider,
      modelName,
      maxTurns,
      resolvedToolNames,
    }
    this.publishToSession(subStreamId, startedEvent)
    emit(startedEvent)

    // Persist the user prompt as the first transcript row (renderer parity).
    const userMessage = this.runRepo.appendMessage(runId, {
      role: 'user',
      content: request.prompt,
      contentBlocks: [{ type: 'text', content: request.prompt, subagent_role: 'user_prompt' }],
    })

    return {
      runId,
      handle: run.handle,
      subStreamId,
      userMessage,
      provider,
      modelName,
      operationMode,
      maxTurns,
      tools,
      resolvedToolNames,
    }
  }

  /**
   * Repair any assistant turn whose tool_calls lack a matching tool_result — the
   * shape a crash leaves when the loop persisted an assistant with tool calls but
   * never merged their results. OpenAI Responses rejects a function_call with no
   * function_call_output (see codexRequestItems pairing), so for each dangling
   * call we synthesize an is_error tool_result block (NEVER re-execute the tool)
   * and mark the call errored, via updateMessageToolState (content/thinking/
   * sequence preserved). Returns the number of tool results synthesized.
   */
  private repairDanglingToolUse(runId: string): number {
    const messages = this.runRepo.getMessages(runId)
    let repaired = 0
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (toolCalls.length === 0) continue
      const blocks = Array.isArray(message.content_blocks) ? [...message.content_blocks] : []
      const resultIds = new Set(
        blocks
          .filter((block: any) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
          .map((block: any) => block.tool_use_id as string)
      )
      const dangling = toolCalls.filter((call: any) => call?.id && !resultIds.has(call.id))
      if (dangling.length === 0) continue

      for (const call of dangling) {
        blocks.push({ type: 'tool_result', tool_use_id: call.id, content: INTERRUPTED_TOOL_RESULT, is_error: true })
      }
      const danglingIds = new Set(dangling.map((call: any) => call.id))
      const updatedToolCalls = toolCalls.map((call: any) =>
        danglingIds.has(call?.id) ? { ...call, status: 'error', result: INTERRUPTED_TOOL_RESULT } : call
      )
      this.runRepo.updateMessageToolState(runId, message.id, { contentBlocks: blocks, toolCalls: updatedToolCalls })
      repaired += dangling.length
    }
    return repaired
  }

  /**
   * Prepare a resume: atomically reopen the run (CAS gate), repair dangling
   * tool_use, rebuild the loop history from the persisted transcript, re-resolve
   * tools, and open a NEW streaming row (new streamId, same runId + handle). Null
   * when the run was not in a resumable state (reopen CAS did not transition).
   */
  private async prepareResume(
    runId: string,
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void
  ): Promise<{ prepared: PreparedSubagentRun; resumeState: ResumeState }> {
    // resumeDetached already performed the atomic reopen and reserved the active
    // lifecycle entry before entering this asynchronous preparation phase.
    this.repairDanglingToolUse(runId)
    const run = this.runRepo.getRunById(runId)
    const messages = this.runRepo.getMessages(runId)
    const priorTurns = messages.filter(message => message.role === 'assistant').length

    const provider =
      typeof request.provider === 'string' && request.provider.trim() ? request.provider.trim() : 'openaichatgpt'
    const modelName =
      typeof request.modelName === 'string' && request.modelName.trim() ? request.modelName.trim() : DEFAULT_MODEL
    const operationMode = request.operationMode === 'plan' ? 'plan' : 'execute'
    const maxTurns = clampMaxTurns(request.maxTurns)

    try {
      await this.refreshProviderTokens?.(provider)
    } catch (error) {
      console.warn('[subagent] provider token refresh failed (continuing):', error)
    }

    const resolved = this.resolveToolsByName(request.tools)
    let tools = resolved.tools
    if (operationMode === 'plan') {
      tools = filterToolsForOperationMode(
        tools.map(tool => ({ ...tool, isMcp: tool.name.startsWith('mcp__') })),
        'plan'
      )
    }
    const resolvedToolNames = tools.map(tool => tool.name)

    // Fresh streaming row for this attempt: new streamId, same content ownership.
    const subStreamId = this.streamingRunRepo.upsert({
      lineageId: request.lineageId ?? null,
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      streamType: 'subagent',
      source: 'subagent',
      operation: 'subagent',
      provider,
      modelName,
      toolCallId: request.toolCallId ?? null,
      parentStreamId: request.streamId ?? null,
      metadata: { subagent_run_id: runId, resumed: true },
    })

    // Fresh session for the resumed attempt's NEW streamId. The renderer re-targets
    // by re-reading the run's latest streamId (see the by-tool-call route).
    this.runSessions?.create(subStreamId, request.conversationId)

    const startedEvent: HeadlessSubagentStreamEvent = {
      type: 'started',
      operation: 'subagent',
      subagentRunId: runId,
      streamId: subStreamId,
      lineageId: request.lineageId ?? null,
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      provider,
      modelName,
      maxTurns,
      resolvedToolNames,
    }
    this.publishToSession(subStreamId, startedEvent)
    emit(startedEvent)

    const tailMessage = messages.length > 0 ? messages[messages.length - 1] : null
    const prepared: PreparedSubagentRun = {
      runId,
      handle: run?.handle ?? null,
      subStreamId,
      // Only assistantParentId is read from this in driveRun, and resume overrides it.
      userMessage: (tailMessage ?? messages[0]) as SubagentMessageRow,
      provider,
      modelName,
      operationMode,
      maxTurns,
      tools,
      resolvedToolNames,
    }
    const resumeState: ResumeState = {
      history: messages,
      userContent: '',
      assistantParentId: tailMessage?.id ?? null,
      priorTurns,
    }
    return { prepared, resumeState }
  }

  private async driveRun(
    prepared: PreparedSubagentRun,
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void,
    signal: AbortSignal,
    resume?: ResumeState
  ): Promise<void> {
    const { runId, subStreamId, userMessage, provider, modelName, operationMode, maxTurns, tools } = prepared

    // On resume we continue the persisted transcript instead of starting a fresh
    // single user turn, and the remaining turn budget excludes turns already spent.
    const priorTurns = resume?.priorTurns ?? 0
    const history = resume ? resume.history : [{ role: 'user', content: request.prompt }]
    const loopUserContent = resume ? resume.userContent : request.prompt
    const assistantParentId = resume ? resume.assistantParentId : userMessage.id
    const effectiveMaxTurns = Math.max(1, maxTurns - priorTurns)

    // Mirror every stream event into the run's RunSession (when enabled) so the
    // transcript viewer can watch live via GET /api/streams/:subStreamId, then emit
    // to the direct caller (SSE route res / blocking capture / NOOP for detached).
    const publishAndEmit = (event: HeadlessSubagentStreamEvent): void => {
      this.publishToSession(subStreamId, event)
      emit(event)
    }

    let turnsUsed = priorTurns
    let toolCallsUsed = 0
    const toolsExecuted: Array<{ name: string; success: boolean }> = []

    const countingExecutor: ToolExecutor = async (toolCall: ProviderToolCall, context) => {
      if (!request.autoApprove) {
        try {
          assertToolAllowedWithoutAutoApprove(toolCall)
        } catch (error) {
          toolsExecuted.push({ name: toolCall.name, success: false })
          throw error
        }
      }
      toolCallsUsed += 1
      try {
        const result = await this.toolExecutor(toolCall, { ...context, nestedExecutor: countingExecutor })
        toolsExecuted.push({ name: toolCall.name, success: true })
        return result
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) throw error
        toolsExecuted.push({ name: toolCall.name, success: false })
        throw error
      }
    }

    const transcriptCompactor: ToolLoopCompactor = async input => {
      const summaryText = await this.compactionService.generateCompactionSummary({
        messages: input.messages,
        provider: input.provider,
        modelName: input.modelName,
        userId: input.userId,
        accessToken: input.accessToken,
        accountId: input.accountId,
        systemPrompt: input.systemPrompt,
      })
      const row = this.runRepo.appendMessage(runId, {
        role: 'system',
        content: summaryText,
        contentBlocks: [],
      })
      return {
        message: {
          ...row,
          role: 'system',
          note: '__auto_compaction_summary__',
          parent_id: input.parentMessageId,
          conversation_id: input.conversationId,
        },
      }
    }

    const loop = new ToolLoopService({
      sink: new SubagentTranscriptSink({ runRepo: this.runRepo, runId }),
      providerRouter: this.providerRouter,
      executeTool: countingExecutor,
      compactBranch: transcriptCompactor,
      providerTurnTimeoutMs: this.providerTurnTimeoutMs,
    })

    try {
      const result = await loop.run(
        {
          provider,
          modelName,
          conversationId: request.conversationId,
          assistantParentId,
          history,
          userContent: loopUserContent,
          systemPrompt: request.systemPrompt ?? null,
          temperature: request.temperature,
          reasoningConfig: request.reasoningEffort ? { effort: request.reasoningEffort } : undefined,
          userId: request.userId ?? null,
          accessToken: request.accessToken ?? null,
          accountId: request.accountId ?? null,
          tools,
          streamId: subStreamId,
          rootPath: request.rootPath ?? null,
          operationMode,
          toolTimeoutMs: request.toolTimeoutMs,
          maxTurns: effectiveMaxTurns,
          signal,
          railwaySessionId: `subagent:${runId}`,
          allowCommentaryFallbackText: true,
          autoCompactionEnabled: request.autoCompactionEnabled ?? true,
          contextLength: request.contextLength,
          compactionThresholdPercent: request.compactionThresholdPercent,
          compactionProvider: provider,
          compactionModelName: modelName,
          robustness: { retryEmptyTurn: true, finalizeOnSilentToolEnd: true, retryProviderError: true },
        },
        (event: HeadlessStreamEvent) => publishAndEmit(event)
      )

      turnsUsed = priorTurns + result.turnsUsed
      const finalText = stripThinkingWrapper(result.finalAssistantMessage?.content ?? '')

      this.runRepo.updateRun(runId, {
        status: 'completed',
        finalResponse: finalText,
        turnsUsed,
        toolCallsUsed,
      })
      this.streamingRunRepo.finish(subStreamId, {
        status: 'completed',
        endReason: 'completed',
        metadata: { subagent_run_id: runId },
      })

      publishAndEmit({
        type: 'complete',
        subagentRunId: runId,
        lineageId: request.lineageId ?? null,
        message: result.finalAssistantMessage,
        result: finalText,
        stats: { turnsUsed, maxTurns, toolCallsUsed, toolsExecuted },
      })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        this.runRepo.updateRun(runId, {
          status: 'aborted',
          error: 'Subagent aborted',
          turnsUsed,
          toolCallsUsed,
        })
        this.streamingRunRepo.finish(subStreamId, {
          status: 'aborted',
          endReason: 'aborted',
          error: 'Subagent aborted',
          metadata: { subagent_run_id: runId },
        })
        // The client has usually disconnected; emit best-effort.
        publishAndEmit({
          type: 'error',
          subagentRunId: runId,
          lineageId: request.lineageId ?? null,
          error: 'Subagent aborted',
          aborted: true,
        })
        return
      }

      if (error instanceof ProviderErrorAssistantResponse) {
        const providerError = error.providerError
        this.runRepo.updateRun(runId, {
          status: 'error',
          error: providerError.originalMessage,
          finalResponse: providerError.message,
          turnsUsed,
          toolCallsUsed,
        })
        this.streamingRunRepo.finish(subStreamId, {
          status: 'error',
          endReason: 'provider_error',
          error: providerError.originalMessage,
          metadata: {
            subagent_run_id: runId,
            provider,
            status: providerError.status,
            errorType: providerError.errorType,
            retryExhausted: providerError.retryExhausted,
          },
        })
        publishAndEmit({
          type: 'error',
          subagentRunId: runId,
          lineageId: request.lineageId ?? null,
          error: providerError.message,
          provider,
          status: providerError.status,
          errorType: providerError.errorType,
          resetAt: providerError.resetAt,
          retryExhausted: providerError.retryExhausted,
        })
        return
      }

      const message =
        error instanceof ProviderEmptyResponseError
          ? 'Provider returned an empty response after retry'
          : error instanceof Error
            ? error.message
            : String(error)

      this.runRepo.updateRun(runId, { status: 'error', error: message, turnsUsed, toolCallsUsed })
      this.streamingRunRepo.finish(subStreamId, {
        status: 'error',
        endReason: 'error',
        error: message,
        metadata: { subagent_run_id: runId },
      })
      publishAndEmit({
        type: 'error',
        subagentRunId: runId,
        lineageId: request.lineageId ?? null,
        error: message,
        provider,
      })
    }
  }

  /**
   * Backstop for a detached run that throws OUTSIDE driveRun's own try/catch
   * (driveRun already persists completed/error/aborted for the normal paths).
   */
  private persistUnexpectedFailure(prepared: PreparedSubagentRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      this.runRepo.updateRun(prepared.runId, { status: 'error', error: message })
      this.streamingRunRepo.finish(prepared.subStreamId, {
        status: 'error',
        endReason: 'error',
        error: message,
        metadata: { subagent_run_id: prepared.runId },
      })
    } catch (persistError) {
      console.warn('[subagent] failed to persist unexpected detached failure:', persistError)
    }
  }
}
