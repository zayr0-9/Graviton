import { assertConversationNotDeleting } from '../persistence/deleteMessages.js'
import { executionPathAfterHandoff, portableSummaryText } from '../../../../../shared/summaryHandoff.js'
import { isCleanStartUserBranch } from '../../../../../shared/cleanStartBranch.js'
import { CLAUDE_TRANSFERRED_SOURCE_MESSAGE, isTransferredMessage, transferredSummaryAtTip } from '../../../../../shared/claudeTransfer.js'
import { CLAUDE_MODELS, claudeMessageMetadata, isClaudeProvider, isClaudeTranscriptMessage } from '../../../../../shared/claudeProvider.js'
import { ClaudeSessionRepo, assertClaudeBranchSelection } from '../persistence/claudeSessionRepo.js'
import { CHAT_MODE_BLOCKED_TOOLS, ClaudeSessionService, claudeImageBlock, type ClaudeModeSwitch, type ClaudeQueuedInput, type ClaudeTaskControl } from './claudeSessionService.js'
import { compactionInstruction } from '../../../../../shared/compaction.js'
import type { AdmissionMismatchReason } from '../../../../../shared/runAdmission.js'
import { v4 as uuidv4 } from 'uuid'
import type { HeadlessBackgroundTaskOutput, HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { createModelThroughput, recordModelRequest } from '../../../../../shared/runStatistics.js'
import { buildChatErrorEnvelope, type ChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import { parseMessageMeta } from '../../../../../shared/contextInjection.js'
import { LineageRepo, type LineageRow } from '../persistence/lineageRepo.js'
import { ToolInvocationRepo } from '../persistence/toolInvocationRepo.js'
import { TreeMessageSink, CloudMirrorSink, type MessageSink } from './messageSink.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { BranchOrchestrator, type ResolvedExecution } from './branchOrchestrator.js'
import { buildHeadlessSystemPrompt } from './headlessSystemPrompt.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
import { classifyChatError } from '../providers/providerErrorFormatter.js'
import { RailwayAppAuthError } from '../providers/openRouterProvider.js'
import {
  ProviderErrorAssistantResponse,
  ToolLoopService,
  type ToolExecutor,
  type ToolExecutionContext,
  type ToolLoopCompactor,
  type ToolLoopRunResult,
} from './toolLoopService.js'
import type { DecisionBroker, ClarifyDecision, PermissionDecision } from './decisionBroker.js'
import { createChatHookSession, type ChatHookSession } from './chatHookService.js'
import { trimHistoryToLatestCompaction } from './compactionService.js'
import type { HookRunRequest, HookRunResult } from '../../hooks/hookTypes.js'
import { filterToolsForOperationMode, requiresAgentMode } from '../../../../../shared/operationModeToolPolicy.js'
import { OperationModeControl, modeNotificationContent } from './operationModeControl.js'
import { parseAdditionalCwds } from '../../toolAccessContext.js'
import { FULL_ACCESS_NOTIFICATION_KIND, fullAccessNotificationContent, isRunSettingsNotification } from '../../../../../shared/accessNotifications.js'
import { MessageInputQueue, queuedSubmissionFingerprint } from './messageInputQueue.js'
import type { QueuedMessageSubmission, MessageQueueSnapshot } from '../../../../../shared/queuedMessages.js'
import {
  normalizeContextDirectorySettings,
  resolveContextDirectorySettingsFromEnv,
  type ContextDirectorySettings,
} from '../../../../../shared/contextDirectories.js'
import {
  CONTEXT_INJECTION_KIND,
  isContextInjectionMessage,
  LABEL_HOOK_CONTEXT,
  collectLoadedContextPaths,
  contextInjectionBlocksOf,
  renderInjectionEntries,
  toContextInjectionBlock,
} from '../../../../../shared/contextInjection.js'
import { createConversationContextLoader, type ConversationContextLoader, type LaunchInjection } from '../../context/contextLoader.js'
import { registerConversationContext } from '../../context/contextSessionRegistry.js'
import { loadSkillFromDirectory, type DiscoveredSkill } from '../../context/skillsDiscovery.js'
import { skillRegistry } from '../../skills/skillLoader.js'
import { tryGetServerConfig } from '../../serverHost.js'
import { assertModelImageBudget, createModelImageHydrator } from './modelImageHistory.js'

interface ChatOrchestratorDeps {
  db: any
  statements: any
  tokenStore?: ProviderTokenStore
  providerRouter?: ProviderRouter
  branchOrchestrator?: BranchOrchestrator
  toolLoopService?: ToolLoopService
  toolExecutor?: ToolExecutor
  defaultToolsProvider?: () => Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>
  compactBranch?: ToolLoopCompactor
  /** Shared pause/resume registry. When present (with toolExecutor), enables the
   *  interactive permission / plan_md-clarify pause via a per-run wrapping executor. */
  decisionBroker?: DecisionBroker
  /** In-process hook runner (runHookRequest). When present AND request.hooksEnabled
   *  AND a decisionBroker is wired, the run fires the 5 lifecycle chat hooks
   *  (parity with the renderer). Absent for subagents/tests => NO hooks. */
  hookRunner?: (req: HookRunRequest) => Promise<HookRunResult>
  /** Phase 4 gateway.chat flag. When true, the openrouter (cloud) route relays
   *  free-tier SSE events and adopts Railway message ids (CloudMirrorSink). Default
   *  false => the cloud route behaves exactly as before (drop frames, mint ids). */
  cloudChatEnabled?: boolean
  claudeSessions?: ClaudeSessionService
}

export function linkPreparedAttachmentsToMessage(
  statements: any,
  messageId: string,
  attachments: any[] | null | undefined
): any[] {
  const attachmentIds = Array.from(
    new Set(
      (Array.isArray(attachments) ? attachments : [])
        .map(attachment =>
          typeof attachment?.attachmentId === 'string'
            ? attachment.attachmentId.trim()
            : typeof attachment?.attachment_id === 'string'
              ? attachment.attachment_id.trim()
              : ''
        )
        .filter(Boolean)
    )
  )
  if (attachmentIds.length === 0) return []
  if (!statements.getAttachmentById?.get || !statements.linkAttachment?.run) {
    throw new Error('Attachment persistence statements are not configured')
  }

  const linkedAttachments: any[] = []
  const now = new Date().toISOString()
  for (const attachmentId of attachmentIds) {
    const attachment = statements.getAttachmentById.get(attachmentId)
    if (!attachment) throw new Error(`Prepared attachment not found: ${attachmentId}`)
    statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)
    linkedAttachments.push(attachment)
  }
  return linkedAttachments
}

/** Tools that never prompt for permission (mirrors the renderer TOOL_PERMISSION_ALWAYS_BYPASS). */
const CLAUDE_SLASH_COMMAND_ERROR = 'Use Graviton’s /compact command for Claude compaction. Claude Code’s built-in native slash commands are not supported; skills and custom commands run by name.'
const ALWAYS_BYPASS_TOOLS = new Set(['skill_manager', 'multi_call', 'context_status'])
/** custom_tool_manager actions that are read-only/management (bypass) vs 'invoke' (prompt). */
const CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS = new Set([
  'search',
  'list',
  'get',
  'enable',
  'disable',
  'add',
  'remove',
  'reload',
  'settings',
])

function parseToolArgs(raw: unknown): any {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw ?? {}
}

/** Whether a tool call skips the interactive permission prompt (server-side port of the renderer gate). */
function shouldBypassPermission(toolName: string, args: any): boolean {
  if (ALWAYS_BYPASS_TOOLS.has(toolName)) return true
  if (toolName === 'mcp_manager') return ['search', 'list', 'get', 'stop', 'list_tools'].includes(args?.action)
  if (toolName === 'custom_tool_manager') {
    // Normalize identically to the renderer (chatActions shouldBypassToolPermission)
    // so mixed-case/whitespace actions bypass on both sides.
    const action = (typeof args?.action === 'string' ? args.action : '').trim().toLowerCase()
    return action !== 'invoke' && CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS.has(action)
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/** The phases `classifyChatError` understands. Tracked through a run so the outer catch can say where it broke. */
type ChatErrorPhase = 'provider' | 'tool' | 'hook' | 'compaction' | 'lifecycle' | 'transport'

/**
 * The property `ChatOrchestrator` stamps on an error it rethrows AFTER it has already
 * emitted its own classified `{type:'error', envelope, terminal:true}` frame.
 *
 * This orchestrator is the SINGLE terminal-frame authority for a chat run: it classifies
 * once, persists once, and emits exactly one terminal frame. Because it still rethrows
 * (callers log, and `chatRoutes` keeps its own fallback for exceptions that never reached
 * `runMessage`), the route needs a way to tell "already published" from "never classified".
 * `chatRoutes.orchestratorAlreadyPublished` reads this exact property name.
 */
export const CHAT_ERROR_PUBLISHED_PROPERTY = 'chatErrorPublished' as const

/**
 * Out-of-band record of "already published", for errors that cannot be written to.
 *
 * This module compiles to ESM, which is always strict mode, so assigning to a frozen /
 * sealed / non-extensible error THROWS a TypeError. That throw would escape the catch
 * block that is reporting the real failure and replace it with a bogus one — the worst
 * possible substitution. The WeakSet is therefore the authority; the own properties are
 * still set best-effort because `chatRoutes.orchestratorAlreadyPublished` reads the
 * property by name (it may see an error that crossed a module/realm boundary).
 */
const publishedChatErrors = new WeakSet<object>()

/** Stamp the marker (and the envelope, for logs) on a rethrown error. Non-objects are wrapped by the caller. */
export function markChatErrorPublished<E>(error: E, envelope: ChatErrorEnvelope): E {
  if (error && typeof error === 'object') {
    publishedChatErrors.add(error as object)
    try {
      ;(error as any)[CHAT_ERROR_PUBLISHED_PROPERTY] = true
      ;(error as any).chatErrorEnvelope = envelope
    } catch {
      // Frozen/sealed error: the WeakSet above already recorded it, and losing the
      // property is infinitely better than losing the failure being reported.
    }
  }
  return error
}

/** True when the orchestrator already published a terminal frame for this error. */
export function hasPublishedChatErrorFrame(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (publishedChatErrors.has(error as object)) return true
  return (error as any)[CHAT_ERROR_PUBLISHED_PROPERTY] === true
}

/** Best-effort own-property write that can never turn a report into a different failure. */
function safeAssign(target: unknown, key: string, value: unknown): void {
  if (!target || typeof target !== 'object') return
  try {
    ;(target as any)[key] = value
  } catch {
    // Non-extensible target; the field is diagnostic only.
  }
}

/**
 * The persisted form of a classified failure (renderer `ErrorBlock`). It is the ONLY
 * block type carrying `excludeFromContext`, because replaying "I couldn't reach the
 * provider" to the model as its own prior words is a real correctness bug.
 */
export interface ErrorContentBlock {
  type: 'error'
  index: number
  envelope: ChatErrorEnvelope
  excludeFromContext: true
}

export function buildErrorContentBlock(envelope: ChatErrorEnvelope, index = 0): ErrorContentBlock {
  return { type: 'error', index, envelope, excludeFromContext: true }
}

/** `content_blocks` is a JSON string on a DB row and an array in memory; tolerate both. */
function parseContentBlocks(value: unknown): any[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Drop every `excludeFromContext` block before history reaches the model.
 *
 * An error-only assistant row (what a terminal failure persists) disappears entirely;
 * a hypothetical mixed row keeps its other blocks and is re-serialised in the same
 * shape it arrived in. Everything else passes through by reference, so the non-error
 * path is untouched.
 */
export function excludeContextExcludedMessages(messages: any[]): any[] {
  const kept: any[] = []
  for (const message of messages) {
    const blocks = parseContentBlocks(message?.content_blocks)
    if (!blocks || blocks.length === 0) {
      kept.push(message)
      continue
    }
    const visible = blocks.filter(block => block?.excludeFromContext !== true)
    if (visible.length === blocks.length) {
      kept.push(message)
      continue
    }
    if (visible.length === 0) continue
    kept.push({
      ...message,
      content_blocks: typeof message.content_blocks === 'string' ? JSON.stringify(visible) : visible,
    })
  }
  return kept
}

/**
 * The envelope for a cancelled run.
 *
 * A user Stop and a reaper eviction are INDISTINGUISHABLE today: `RunSession.cancel()`
 * calls `aborter.abort()` with no reason, so `signal.reason` is the default
 * `AbortError` DOMException for both. The reason is read defensively here so that the
 * day a caller aborts with `{ kind: 'reaper' }` (or any string mentioning reap/expire)
 * this maps to `run_expired` without another change; until then every cancel is
 * `cancelled` ("This reply was cancelled.").
 */
export function buildCancellationEnvelope(signal?: AbortSignal): ChatErrorEnvelope {
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  const kind =
    typeof reason === 'string'
      ? reason
      : typeof (reason as { kind?: unknown })?.kind === 'string'
        ? ((reason as { kind: string }).kind)
        : typeof (reason as { name?: unknown })?.name === 'string'
          ? ((reason as { name: string }).name)
          : ''
  const lowered = kind.toLowerCase()
  if (lowered.includes('reap') || lowered.includes('expire')) {
    return buildChatErrorEnvelope('run_expired', { detail: `Run cancelled: ${kind}` })
  }
  return buildChatErrorEnvelope('cancelled', { detail: 'Run aborted' })
}

export function shouldRejectSourceLineageMismatch(
  requestedLineageId: string | null | undefined,
  sourceInLineagePath: boolean
): boolean {
  return Boolean(requestedLineageId) && !sourceInLineagePath
}

/**
 * Build a per-run tool executor that pauses for interactive decisions (permission /
 * plan_md clarify) via the DecisionBroker and — when a hookSession is supplied —
 * interleaves the PreToolUse/PostToolUse/PostToolUseFailure chat hooks around the
 * permission gate. Extracted from ChatOrchestrator so the interleave is unit-testable
 * without the persistence layer. Behavior with `hookSession` undefined is the exact
 * Phase-2 path, byte-for-byte.
 */
export function createChatPausingExecutor(deps: {
  base: ToolExecutor
  broker: DecisionBroker
  streamId: string
  emit: (event: HeadlessStreamEvent) => void
  signal?: AbortSignal
  hookSession?: ChatHookSession
  modeControl?: OperationModeControl
}): ToolExecutor {
  const { broker, streamId, emit, signal, hookSession, modeControl } = deps
  // Recheck AFTER hooks/permission awaits, immediately before actual dispatch.
  const base: ToolExecutor = (call, context) => {
    modeControl?.assertCanDispatch(call)
    return deps.base(call, { ...context, operationMode: modeControl?.mode ?? context.operationMode })
  }
  const execute: ToolExecutor = async (toolCall, context) => {
    const sig = context.signal ?? signal
    modeControl?.assertCanDispatch(toolCall)
    const args = parseToolArgs(toolCall.arguments)
    const approvedContext = () => ({ ...context, autoApprove: true, nestedExecutor: context.nestedExecutor ?? execute })

    // plan_md clarify is INHERENTLY interactive: the base executor always throws on it
    // (planMd.ts), so it is intercepted here and routed through the DecisionBroker's
    // clarify channel instead of executed. `call`/`cArgs` are the effective (possibly
    // hook-rewritten) call so a PreToolUse updatedInput reaches the clarify questions.
    const runClarify = async (call: typeof toolCall, cArgs: any) => {
      const prompt = { type: 'clarify_required' as const, streamId, toolCallId: toolCall.id,
        toolName: call.name, questions: Array.isArray(cArgs?.questions) ? cArgs.questions : [] }
      const pending = broker.requestDecision<ClarifyDecision>({ streamId, toolCallId: toolCall.id, kind: 'clarify', signal: sig, prompt })
      if (broker.hasPending(streamId, toolCall.id)) emit(prompt)
      const decision = await pending
      return {
        clarified: !decision.cancelled,
        cancelled: decision.cancelled ?? false,
        questions: Array.isArray(cArgs?.questions) ? cArgs.questions.length : 0,
        answers: decision.answers ?? [],
      }
    }
    const isClarify = (name: string | undefined, a: any) => name === 'plan_md' && a?.action === 'clarify'

    // No hooks: the exact Phase-2 path, byte-for-byte. Clarify is intercepted before
    // the auto-approve short-circuit (auto-approve only skips permission PROMPTS, not
    // the clarify mechanism).
    if (!hookSession) {
      if (isClarify(toolCall.name, args)) return runClarify(toolCall, args)
      if (broker.isAutoApproveAll(streamId)) return base(toolCall, approvedContext())
      if (shouldBypassPermission(toolCall.name, args)) return base(toolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      const prompt = { type: 'permission_required' as const, streamId, toolCallId: toolCall.id, toolName: toolCall.name, toolInput: args }
      const pending = broker.requestDecision<PermissionDecision>({ streamId, toolCallId: toolCall.id, kind: 'permission', signal: sig, prompt })
      if (broker.hasPending(streamId, toolCall.id)) emit(prompt)
      const decision = await pending
      if (decision === 'deny') throw new Error('Tool execution denied by user')
      if (decision === 'allow_always') broker.setAutoApproveAll(streamId)
      return base(toolCall, decision === 'allow_always' ? approvedContext() : { ...context, nestedExecutor: context.nestedExecutor ?? execute })
    }

    // Hooks active — port of the renderer executeToolWithPermissionCheck
    // (chatActions.ts:2406-2522): PreToolUse (BEFORE any prompt/clarify; may rewrite
    // args or deny) -> [clarify OR permission gate + execute] -> PostToolUse /
    // PostToolUseFailure. A SINGLE try/catch so a PreToolUse deny AND a permission deny
    // both fire PostToolUseFailure, matching the renderer's single catch. Clarify runs
    // INSIDE the hook wrapper (parity: the renderer intercepts clarify in the base
    // executor, under executeToolWithPermissionCheck, so Pre/Post DO fire around it).
    let effectiveToolCall = toolCall
    try {
      const pre = await hookSession.runPreToolUse(toolCall, context)
      if (pre.updatedInput) effectiveToolCall = { ...toolCall, arguments: pre.updatedInput }
      if (pre.permissionDecision === 'deny') {
        throw new Error(pre.permissionDecisionReason || 'Tool blocked by hook')
      }
      const effArgs = parseToolArgs(effectiveToolCall.arguments)
      modeControl?.assertCanDispatch(effectiveToolCall)

      let result: any
      if (isClarify(effectiveToolCall.name, effArgs)) {
        // Clarify bypasses the permission prompt (its own interactive channel), but
        // still fires PostToolUse — same as the renderer.
        result = await runClarify(effectiveToolCall, effArgs)
      } else if (broker.isAutoApproveAll(streamId)) {
        result = await base(effectiveToolCall, approvedContext())
      } else if (shouldBypassPermission(effectiveToolCall.name, effArgs)) {
        result = await base(effectiveToolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      } else {
        // Prompt shows the rewritten args. toolCallId stays the original id (a rewrite
        // only touches arguments), so the /resume correlation is unchanged.
        const prompt = { type: 'permission_required' as const, streamId, toolCallId: toolCall.id, toolName: effectiveToolCall.name, toolInput: effArgs }
        const pending = broker.requestDecision<PermissionDecision>({ streamId, toolCallId: toolCall.id, kind: 'permission', signal: sig, prompt })
        if (broker.hasPending(streamId, toolCall.id)) emit(prompt)
        const decision = await pending
        if (decision === 'deny') throw new Error('Tool execution denied by user')
        if (decision === 'allow_always') broker.setAutoApproveAll(streamId)
        result = await base(
          effectiveToolCall,
          decision === 'allow_always' ? approvedContext() : { ...context, nestedExecutor: context.nestedExecutor ?? execute }
        )
      }

      await hookSession.runPostToolUse(effectiveToolCall, result, context)
      return result
    } catch (error) {
      // Abort escapes unwrapped to preserve the loop's clean cancellation unwind
      // (toolLoopService rethrows aborts); no PostToolUseFailure on cancel — a
      // deliberate, documented divergence from the renderer (which fires it on any error).
      if (sig?.aborted || isAbortError(error)) throw error
      await hookSession.runPostToolUseFailure(effectiveToolCall, error, context)
      throw error
    }
  }
  return execute
}

export interface HeadlessChatOrchestrator {
  validateExecutionSelection?(request: HeadlessMessageRequest): void
  resolveToolApproval?(request: HeadlessMessageRequest): boolean | undefined
  classifyOrdinarySend?(request: HeadlessMessageRequest): { lineageId: string | null; parentId: string | null; activeStreamId?: string }
  submitQueuedMessage?(conversationId: string, streamId: string, submission: QueuedMessageSubmission): { snapshot?: MessageQueueSnapshot; restart?: HeadlessMessageRequest; restartStreamId?: string }
  getMessageQueue?(conversationId: string, streamId: string): MessageQueueSnapshot
  cancelQueuedMessage?(conversationId: string, streamId: string, requestId: string): MessageQueueSnapshot | Promise<MessageQueueSnapshot>
  stopBackgroundTask?(conversationId: string, streamId: string, taskId: string): Promise<void>
  readBackgroundTaskOutput?(conversationId: string, streamId: string, taskId: string): Promise<HeadlessBackgroundTaskOutput>
  changeOperationMode?(input: { conversationId: string; mode: 'plan' | 'execute'; requestId: string; streamId?: string | null; parentId?: string | null; lineageId?: string | null }): any
  /**
   * Run one chat turn to completion.
   *
   * TERMINAL-FRAME CONTRACT: `runMessage` is the single authority for a run's ending.
   * It emits EXACTLY ONE terminal frame — `{type:'complete'}` on success (or on the
   * provider-error-as-assistant-response path, badged with `providerError`+`envelope`)
   * or `{type:'error', envelope, terminal:true}` on any failure, INCLUDING an abort.
   * It still rethrows non-abort failures, stamped with `chatErrorPublished: true`
   * (see `markChatErrorPublished` / `hasPublishedChatErrorFrame`) so a caller can log
   * without publishing a second, worse frame over the classified one.
   */
  runMessage(
    request: HeadlessMessageRequest,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>
}

export class ChatOrchestrator implements HeadlessChatOrchestrator {
  private readonly inputRuns = new Map<string, {
    queue: MessageInputQueue; request: HeadlessMessageRequest; control: OperationModeControl
    head: string | null; successor?: string; restartRequestId?: string; restartFingerprint?: string; terminal?: 'completed' | 'failed'; signal?: AbortSignal
    /** A live Claude session: `wake` hands it new entries, `claudeCancel` withdraws one it holds. */
    wake?: () => void; claudeCancel?: (requestId: string) => Promise<boolean | null>
    claudeTasks?: ClaudeTaskControl
  }>()

  private readonly watchPins = new Map<string, { lineageId: string; count: number }>()

  /** Retain origin + latest continuation config while a bounded watcher is active. */
  retainWatch(context: ToolExecutionContext): () => void {
    const streamId = context.streamId
    const run = streamId ? this.inputRuns.get(streamId) : null
    if (!streamId || !run || run.request.conversationId !== context.conversationId ||
      run.queue.lineageId !== context.lineageId) throw new Error('Watcher requires a main-chat run on this branch')
    const pin = this.watchPins.get(streamId) ?? { lineageId: context.lineageId!, count: 0 }
    pin.count++
    this.watchPins.set(streamId, pin)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--pin.count === 0) this.watchPins.delete(streamId)
      this.pruneInputRuns()
    }
  }

  private pruneInputRuns() {
    const protectedIds = new Set(this.watchPins.keys())
    for (const pin of this.watchPins.values()) {
      const latest = [...this.inputRuns].reverse().find(([, run]) =>
        (run.queue.lineageId ?? run.request.lineageId) === pin.lineageId)
      if (latest) protectedIds.add(latest[0])
    }
    for (const [id, run] of this.inputRuns) {
      if (this.inputRuns.size <= 64) break
      if (run.terminal && !protectedIds.has(id)) this.inputRuns.delete(id)
    }
  }

  /** Route a completion to the current execution/tail, never to an old tool-call parent. */
  submitWatchMessage(conversationId: string, lineageId: string, originStreamId: string, submission: QueuedMessageSubmission) {
    const origin = this.inputRuns.get(originStreamId)
    const lineage = this.lineageRepo.get(lineageId)
    if (!origin || origin.request.conversationId !== conversationId || origin.queue.lineageId !== lineageId ||
      !lineage || lineage.status === 'archived' || lineage.conversation_id !== conversationId || !lineage.head_message_id) throw new Error('Watcher branch unavailable')
    // A request's source lineage may fork during setup. Never inject into an
    // unresolved run or launch competing work while its ownership is uncertain.
    const trustedSuccessors = new Set([...this.inputRuns.values()]
      .filter(run => run.request.conversationId === conversationId && run.queue.lineageId === lineageId)
      .map(run => run.successor).filter((id): id is string => Boolean(id)))
    if ([...this.inputRuns].some(([id, run]) => !run.terminal && !run.queue.lineageId &&
      run.request.conversationId === conversationId && run.request.lineageId === lineageId && !trustedSuccessors.has(id))) {
      throw new Error('Watcher branch is initializing')
    }
    const candidates = [...this.inputRuns].reverse().filter(([id, run]) =>
      run.request.conversationId === conversationId && (run.queue.lineageId === lineageId ||
        (!run.queue.lineageId && trustedSuccessors.has(id) && run.request.lineageId === lineageId)))
    // The same request ID can never migrate to a second mailbox on retry.
    const prior = candidates.find(([, run]) => run.queue.get(submission.requestId) || run.restartRequestId === submission.requestId)
    const target = prior ?? candidates.find(([, run]) => !run.terminal) ?? candidates[0]
    if (!target) throw new Error('Watcher run unavailable')
    return this.submitQueuedMessage(conversationId, target[0], submission)
  }

  /** A summary copied from another chat (directly or through trailing context rows) that an ordinary send continues from. */
  private copiedSummaryForSend(request: HeadlessMessageRequest): any | null {
    if (request.operation !== 'send' || !request.parentId || request.isBranch || request.retrigger ||
      request.manualCompaction || request.watcherCompletion) return null
    const rowOf = (id: string) => {
      const row = this.conversationRepo.getMessageById(id)
      return row?.conversation_id === request.conversationId ? row : undefined
    }
    return transferredSummaryAtTip(rowOf(request.parentId), rowOf)
  }

  private summaryHandoff(request: HeadlessMessageRequest): any | null {
    // A copied summary has no native session in this chat: continuing from it is always a handoff.
    const copied = this.copiedSummaryForSend(request)
    if (copied) return copied
    if (request.operation === 'branch' && request.messageId) {
      const source = this.requireMessage(request.messageId, request.conversationId)
      return portableSummaryText(source) ? source : null
    }
    if (request.operation !== 'edit-branch' && request.operation !== 'repeat') return null
    const targetId = request.operation === 'edit-branch' ? request.messageId : request.parentId ?? request.messageId
    if (!targetId) return null
    const target = this.requireMessage(targetId, request.conversationId)
    const user = request.operation === 'edit-branch' ? target : this.conversationRepo.findNearestUserAncestor(request.conversationId, target.role === 'assistant' ? target.parent_id : target.id)
    if (!user || user.role !== 'user') return null
    const path = this.conversationRepo.listPathToMessage(request.conversationId, user.id)
    const handoffId = claudeMessageMetadata(user.meta)?.executionHandoff?.summaryMessageId
    if (handoffId) return path.find(row => row.id === handoffId && portableSummaryText(row)) ?? null
    // The first ordinary prompt after native/manual compaction can be redone as a fresh handoff.
    for (let index = path.length - 2; index >= 0; index--) {
      if (portableSummaryText(path[index])) return path[index]
      if (!isContextInjectionMessage(path[index]) && !isRunSettingsNotification(path[index])) break
    }
    return null
  }

  private startsFreshExecution(request: HeadlessMessageRequest): boolean {
    if (this.summaryHandoff(request)) return true
    if (request.operation !== 'edit-branch' || !request.messageId) return false
    const path = this.conversationRepo.listPathToMessage(request.conversationId, request.messageId)
    return path.at(-1)?.id === request.messageId && isCleanStartUserBranch(path) &&
      (isClaudeProvider(request.provider) || path.some(isClaudeTranscriptMessage))
  }

  /** Startup only: make Claude branches cut off by a stop, sleep, quit or crash continuable. */
  recoverInterruptedClaudeBranches(): Promise<number> {
    return this.claudeSessions.recoverInterruptedBranches?.() ?? Promise.resolve(0)
  }

  validateExecutionSelection(request: HeadlessMessageRequest): void {
    assertConversationNotDeleting(this.db, request.conversationId)
    const sourceId = request.operation === 'send' ? request.parentId : request.messageId ?? request.parentId
    const path = sourceId ? this.conversationRepo.listPathToMessage(request.conversationId, sourceId) : []
    // A second pending send cannot switch a newly accepted Claude run before its first row exists.
    const freshExecution = this.startsFreshExecution(request)
    const pending = !freshExecution && [...this.inputRuns.values()].find(run => {
      if (run.terminal || run.request.conversationId !== request.conversationId) return false
      const pendingOrdinary = run.request.operation === 'send' && !run.request.isBranch && !run.request.retrigger
      // An unmaterialized edit/fork does not own the source lineage's execution identity.
      const ownedLineage = run.queue.lineageId ?? (pendingOrdinary ? run.request.lineageId : null)
      return Boolean((request.lineageId && ownedLineage === request.lineageId) ||
        (pendingOrdinary && !request.parentId && !run.request.parentId))
    })
    if (pending && isClaudeProvider(pending.request.provider) !== isClaudeProvider(request.provider)) {
      throw Object.assign(new Error('The accepted branch provider is locked.'), { code: 'configuration_mismatch' })
    }
    assertClaudeBranchSelection(request, freshExecution ? [] : path)
    if (isClaudeProvider(request.provider)) {
      // Other `/name` input is checked after skill discovery, before the user row is written.
      if (!request.manualCompaction && /^\s*\/compact\b/.test(request.content ?? '')) throw new Error(CLAUDE_SLASH_COMMAND_ERROR)
      if (!(CLAUDE_MODELS as readonly string[]).includes(request.modelName)) throw new Error('Select a supported Claude model before sending.')
      if (!(request.rootPath ?? this.conversationRepo.getById(request.conversationId)?.cwd)) throw new Error('Choose a workspace folder before starting Claude.')
      // Reject formats the Anthropic API refuses before a user row is minted.
      for (const image of request.attachmentsBase64 ?? []) {
        const id = image?.attachmentId ?? image?.attachment_id
        const mime = String((id ? this.statements.getAttachmentById?.get(id)?.mime_type : null) ?? /^data:([^;]+);/.exec(image?.dataUrl ?? '')?.[1] ?? '').toLowerCase()
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw new Error('Claude accepts PNG, JPEG, GIF or WebP images only.')
      }
      const source = freshExecution ? null : request.operation === 'edit-branch' ? this.requireMessage(request.messageId!, request.conversationId).parent_id
        : request.operation === 'repeat' ? this.conversationRepo.findNearestUserAncestor(request.conversationId, sourceId ?? null)?.parent_id
        : sourceId
      const sourceRow = source ? this.requireMessage(source, request.conversationId) : null
      const nativeSummary = portableSummaryText(sourceRow) && claudeMessageMetadata(sourceRow?.meta)?.claude?.sessionId
      const summaryContinuation = nativeSummary && request.operation === 'send' && !request.isBranch && !request.retrigger
      if (source && !summaryContinuation && !this.claudeSessionRepo.checkpoint(source)?.resumable) {
        if (isTransferredMessage(sourceRow)) throw Object.assign(new Error(CLAUDE_TRANSFERRED_SOURCE_MESSAGE), { code: 'configuration_mismatch' })
        throw Object.assign(new Error('This Claude turn stopped before any step completed, so there is nothing to continue from. Retry or edit the prompt, or fork from a completed response.'), { code: 'configuration_mismatch' })
      }
      const lineage = request.lineageId ? this.lineageRepo.get(request.lineageId) : this.lineageRepo.resolve({ messageId: sourceId })
      const native = lineage ? this.claudeSessionRepo.branch(lineage.id) : null
      const appendsInPlace = request.operation === 'send' && !request.isBranch && !request.retrigger && lineage?.head_message_id === (request.parentId ?? null)
      // An interrupted session continues by forking at the head's checkpoint; only a live run blocks.
      if (appendsInPlace && native?.state === 'running') {
        throw Object.assign(new Error('This Claude session is still running. Wait for it to finish or fork a completed response.'), { code: 'configuration_mismatch' })
      }
    }
  }

  /** Read-only admission classification. Never reconcile/create a lineage merely
   * to decide where a second client's stale-parent input belongs. */
  classifyOrdinarySend(request: HeadlessMessageRequest): { lineageId: string | null; parentId: string | null; activeStreamId?: string } {
    let parent: any = null
    let lineage: LineageRow | null | undefined = null
    let detail: { pathMessageIds: string[] } | null | undefined = null
    // One user-facing message, but each exit logs why so a rejection can be diagnosed.
    const mismatch = (reason: AdmissionMismatchReason): never => {
      console.error('[LineageForkDebug][Main] admission-mismatch', {
        reason,
        conversationId: request.conversationId,
        operationId: request.operationId ?? null,
        streamId: request.streamId ?? null,
        provider: request.provider ?? null,
        requestedParentId: request.parentId ?? null,
        requestedLineageId: request.lineageId ?? null,
        resolvedLineageId: lineage?.id ?? null,
        resolvedLineageStatus: lineage?.status ?? null,
        resolvedLineageHeadId: lineage?.head_message_id ?? null,
        parentFound: Boolean(parent),
        parentConversationId: parent?.conversation_id ?? null,
        parentLineageId: parent?.lineage_id ?? null,
        parentOnLineagePath: parent && detail ? detail.pathMessageIds.includes(parent.id) : null,
        lineagePathTail: detail?.pathMessageIds.slice(-4) ?? null,
        activeRuns: [...this.inputRuns].filter(([, run]) => !run.terminal && run.request.conversationId === request.conversationId)
          .map(([streamId, run]) => ({ streamId, lineageId: run.queue.lineageId ?? null, head: run.head ?? null,
            operation: run.request.operation, isBranch: Boolean(run.request.isBranch), aborted: Boolean(run.signal?.aborted) })),
      })
      throw Object.assign(new Error('The selected parent is not the current branch head. Reload or explicitly branch.'), { code: 'lineage_mismatch', reason })
    }
    if (!this.conversationRepo.getById(request.conversationId)) return mismatch('conversation_missing')
    parent = request.parentId ? this.conversationRepo.getMessageById(request.parentId) : null
    if (request.parentId && !parent) return mismatch('parent_missing')
    if (parent && parent.conversation_id !== request.conversationId) return mismatch('parent_foreign_conversation')
    lineage = request.lineageId ? this.lineageRepo.get(request.lineageId)
      : this.lineageRepo.resolve({ messageId: request.parentId })
    if (request.lineageId && !lineage) return mismatch('lineage_missing')
    if (lineage && lineage.conversation_id !== request.conversationId) return mismatch('lineage_foreign_conversation')
    if (lineage && lineage.status === 'archived') return mismatch('lineage_archived')
    detail = lineage ? this.lineageRepo.getDetail(request.conversationId, lineage.id) : null
    if (parent && lineage && !detail?.pathMessageIds.includes(parent.id)) return mismatch('parent_not_on_lineage')
    for (const [streamId, run] of this.inputRuns) {
      if (run.terminal || run.request.conversationId !== request.conversationId) continue
      if (run.signal?.aborted && (run.queue.lineageId === lineage?.id || run.request.parentId === request.parentId)) {
        throw Object.assign(new Error('The previous run is stopping. Wait for it to settle before sending.'), { code: 'run_unavailable' })
      }
      // An explicit child/retrigger may still fork after async setup. Until its
      // queue has a real lineage, it cannot reserve the source lineage or anchor.
      const pendingOrdinarySend = run.request.operation === 'send' && !run.request.isBranch && !run.request.retrigger
      const ownedLineage = run.queue.lineageId ?? (pendingOrdinarySend ? run.request.lineageId : null)
      const sameLineage = lineage && ownedLineage === lineage.id
      const samePendingAnchor = !run.queue.lineageId && pendingOrdinarySend &&
        (run.request.parentId ?? null) === (request.parentId ?? null) &&
        (!request.lineageId || run.request.lineageId === request.lineageId || sameLineage ||
          (!run.request.lineageId && lineage?.id === request.lineageId))
      const emptyReservation = !request.parentId && !request.lineageId && pendingOrdinarySend && !run.request.parentId &&
        (!run.queue.lineageId || this.lineageRepo.list(request.conversationId).filter(row => row.status !== 'archived').length === 1)
      if (sameLineage || samePendingAnchor || emptyReservation) {
        return { lineageId: run.queue.lineageId ?? lineage?.id ?? null, parentId: run.head, activeStreamId: streamId }
      }
    }
    if (lineage && lineage.head_message_id !== request.parentId) return mismatch('parent_not_head')
    if (!parent) {
      if (this.conversationRepo.listMessages(request.conversationId).length) return mismatch('empty_parent_on_nonempty_conversation')
    } else if (!lineage && this.conversationRepo.listMessages(request.conversationId).some((row: any) => row.parent_id === parent.id)) {
      return mismatch('unowned_parent_has_children')
    }
    return { lineageId: lineage?.id ?? null, parentId: request.parentId }
  }

  getMessageQueue(conversationId: string, streamId: string): MessageQueueSnapshot {
    const run = this.inputRuns.get(streamId)
    if (!run || run.request.conversationId !== conversationId) throw new Error('Message queue not found in this conversation')
    return run.queue.snapshot()
  }

  cancelQueuedMessage(conversationId: string, streamId: string, requestId: string): MessageQueueSnapshot | Promise<MessageQueueSnapshot> {
    this.getMessageQueue(conversationId, streamId)
    const run = this.inputRuns.get(streamId)!
    const cancelLocally = () => {
      if (!run.queue.cancel(requestId)) throw new Error('Message has already been delivered or is being processed')
      return run.queue.snapshot()
    }
    // Claude may already hold the message; only Claude can withdraw it then.
    if (!run.claudeCancel || run.queue.get(requestId)?.view.status !== 'queued') return cancelLocally()
    return run.claudeCancel(requestId).then(cancelled => {
      if (cancelled === null) return cancelLocally()
      if (!cancelled) throw new Error('Claude has already started this message')
      return run.queue.snapshot()
    })
  }

  private claudeTaskControl(conversationId: string, streamId: string): ClaudeTaskControl {
    const run = this.inputRuns.get(streamId)
    if (!run || run.request.conversationId !== conversationId || !run.claudeTasks) throw new Error('No live Claude run for this stream')
    return run.claudeTasks
  }

  async stopBackgroundTask(conversationId: string, streamId: string, taskId: string): Promise<void> {
    if (!await this.claudeTaskControl(conversationId, streamId).stop(taskId)) throw new Error('That background task is no longer running')
  }

  async readBackgroundTaskOutput(conversationId: string, streamId: string, taskId: string): Promise<HeadlessBackgroundTaskOutput> {
    const output = await this.claudeTaskControl(conversationId, streamId).output(taskId)
    if (!output) throw new Error('Output is unavailable for this task')
    return output
  }

  submitQueuedMessage(conversationId: string, streamId: string, submission: QueuedMessageSubmission): { snapshot?: MessageQueueSnapshot; restart?: HeadlessMessageRequest; restartStreamId?: string } {
    this.getMessageQueue(conversationId, streamId)
    const run = this.inputRuns.get(streamId)!
    if (!submission.requestId || !submission.content.trim()) throw new Error('Message content and request id are required')
    if (run.signal?.aborted) throw new Error('Run stopped; send a new message on the selected branch')
    if (isClaudeProvider(run.request.provider)) {
      // Claude runs always use restricted access (see runMessage), so there is no policy to confirm.
      submission = { ...submission, fullAccess: undefined, fullAccessNotificationId: undefined }
      if (run.request.manualCompaction) throw new Error('Claude is compacting this session. Send your message after it finishes.')
      if (/^\s*\//.test(submission.content)) throw new Error('Claude slash commands cannot be queued. Send it after this turn finishes.')
      for (const attachment of submission.attachmentsBase64 ?? []) claudeImageBlock(attachment.dataUrl)
    }
    const priorSubmission = run.queue.get(submission.requestId)
    if (priorSubmission) {
      run.queue.enqueue(submission, run.control.revision) // validates idempotent payload, including attachments
      return { snapshot: run.queue.snapshot() }
    }
    if (run.successor) {
      if (run.restartRequestId === submission.requestId) {
        if (run.restartFingerprint !== queuedSubmissionFingerprint(submission)) throw new Error('Submission id already used for another message')
        return { restartStreamId: run.successor }
      }
      return this.submitQueuedMessage(conversationId, run.successor, submission)
    }
    if (submission.fullAccess !== undefined && submission.fullAccess !== (run.request.fullAccess === true)) {
      throw Object.assign(new Error('Queued messages must use the active run’s access policy. Confirm that policy or start a separate run.'), {
        code: 'configuration_mismatch', fullAccess: run.request.fullAccess === true,
      })
    }
    if (submission.attachmentsBase64?.length && !isClaudeProvider(run.request.provider) &&
      !['openaichatgpt', 'openrouter'].includes(normalizeProviderRoute(run.request.provider))) {
      throw new Error('Queued image attachments are supported for ChatGPT, OpenRouter and Claude; send text or wait for this run to finish')
    }
    if (!run.queue.closed) {
      run.queue.enqueue(submission, run.control.revision)
      run.wake?.()
      return { snapshot: run.queue.snapshot() }
    }
    if (run.terminal !== 'completed' || !run.head) throw new Error('Run stopped or failed; send a new message on the selected branch')
    const lineage = run.queue.lineageId ? this.lineageRepo.get(run.queue.lineageId) : null
    if (!lineage || lineage.head_message_id !== run.head) throw new Error('Branch advanced; reload before sending')
    // The route starts this successor synchronously before another intake can interleave.
    const nextId = uuidv4()
    run.successor = nextId
    run.restartRequestId = submission.requestId
    run.restartFingerprint = queuedSubmissionFingerprint(submission)
    return { restart: { ...run.request, operation: 'send', streamId: nextId, lineageId: lineage.id,
      parentId: run.head, messageId: null, operationId: null, content: submission.content, manualCompaction: false,
      watcherCompletion: submission.watcherCompletion,
      selectedFiles: submission.selectedFiles ?? [],
      fullAccess: run.request.fullAccess === true,
      fullAccessNotificationId: submission.fullAccessNotificationId,
      attachmentsBase64: submission.attachmentsBase64 ?? null, operationMode: run.control.mode,
      retrigger: false, isBranch: false } }
  }

  private readonly modeRuns = new Map<string, { conversationId: string; control: OperationModeControl }>()

  changeOperationMode(input: { conversationId: string; mode: 'plan' | 'execute'; requestId: string; streamId?: string | null; parentId?: string | null; lineageId?: string | null }): any {
    if (input.streamId) {
      const inputRun = this.inputRuns.get(input.streamId)
      const claudeRun = isClaudeProvider(inputRun?.request.provider)
      // During compaction the switch waits like a queued message: a Graviton run records it
      // after the summary, a Claude /compact run on the summary row (see ClaudeSessionService).
      const run = this.modeRuns.get(input.streamId)
      if (!run || run.conversationId !== input.conversationId || run.control.closed) {
        throw new Error('Run is no longer active; reload the branch before switching modes')
      }
      const accepted = run.control.change(input.mode, input.requestId)
      // The Claude session queues the switch for Claude to read; its edit guard already applies it.
      if (claudeRun) inputRun?.wake?.()
      return { status: run.control.hasPending ? 'pending' : 'applied', ...accepted }
    }
    // Idle mode is composer state, not transcript content. The next send carries
    // its final selection; the loop announces it AFTER persisting that user message.
    throw new Error('Live mode changes require streamId; send the selected idle mode with the next message')
  }

  private persistModeNotification(conversationId: string, parentId: string | null, mode: 'plan' | 'execute', previousMode: 'plan' | 'execute' | null, lineageId: string | null, revision: number,
    content = modeNotificationContent(mode)): any {
    return this.messageRepo.transaction(() => {
      const message = this.messageRepo.createMessage({
        conversationId, parentId, role: 'user', content,
        meta: { kind: 'operation_mode_change', mode, previousMode, revision },
      })
      if (lineageId) this.lineageRepo.appendMessage(lineageId, message.id)
      return { ...message, ...this.messageRepo.get(message.id) }
    })
  }
  private readonly db: ChatOrchestratorDeps['db']
  private readonly statements: any
  private readonly hydrateModelImages: ReturnType<typeof createModelImageHydrator>
  private readonly conversationRepo: ConversationRepo
  private readonly messageRepo: MessageRepo
  private readonly projectRepo: ProjectRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly lineageRepo: LineageRepo
  private readonly providerRouter: ProviderRouter
  private readonly branchOrchestrator: BranchOrchestrator
  private readonly toolLoopService: ToolLoopService
  private readonly defaultToolsProvider: NonNullable<ChatOrchestratorDeps['defaultToolsProvider']>
  // Kept as fields so runMessage can build a per-run ToolLoopService with a
  // run-scoped pausing executor (mirrors SubagentRunService.countingExecutor).
  private readonly toolExecutor?: ToolExecutor
  private readonly compactBranch?: ToolLoopCompactor
  private readonly decisionBroker?: DecisionBroker
  private readonly hookRunner?: (req: HookRunRequest) => Promise<HookRunResult>
  private readonly cloudChatEnabled: boolean
  private readonly claudeSessionRepo: ClaudeSessionRepo
  private readonly claudeSessions: ClaudeSessionService

  constructor(deps: ChatOrchestratorDeps) {
    this.db = deps.db
    this.statements = deps.statements
    this.hydrateModelImages = createModelImageHydrator(deps.db.name, deps.statements)
    this.conversationRepo = new ConversationRepo({ db: deps.db, statements: deps.statements })
    this.messageRepo = new MessageRepo({ db: deps.db, statements: deps.statements })
    this.projectRepo = new ProjectRepo({ db: deps.db })
    this.streamingRunRepo = new StreamingRunRepo({ statements: deps.statements })
    this.lineageRepo = new LineageRepo({ db: deps.db, statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.branchOrchestrator = deps.branchOrchestrator ?? new BranchOrchestrator()
    this.toolExecutor = deps.toolExecutor
    this.compactBranch = deps.compactBranch
    this.decisionBroker = deps.decisionBroker
    this.hookRunner = deps.hookRunner
    this.cloudChatEnabled = deps.cloudChatEnabled ?? false
    this.claudeSessionRepo = new ClaudeSessionRepo(deps.db)
    this.claudeSessions = deps.claudeSessions ?? new ClaudeSessionService({ sessions: this.claudeSessionRepo, messages: this.messageRepo, broker: deps.decisionBroker })
    this.toolLoopService =
      deps.toolLoopService ??
      new ToolLoopService({
        sink: new TreeMessageSink({ messageRepo: this.messageRepo }),
        providerRouter: this.providerRouter,
        executeTool: deps.toolExecutor,
        compactBranch: deps.compactBranch,
      })
    this.defaultToolsProvider = deps.defaultToolsProvider ?? (() => [])
  }

  /**
   * Build a per-run executor that pauses for an interactive permission decision
   * (or a plan_md clarify) via the DecisionBroker before delegating to the base
   * executor. Mirrors SubagentRunService.countingExecutor. Only used when a broker
   * + base executor are wired AND the run's session is not auto-approve.
   */
  private makePausingExecutor(
    streamId: string,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal,
    hookSession?: ChatHookSession,
    modeControl?: OperationModeControl
  ): ToolExecutor {
    return createChatPausingExecutor({
      base: this.toolExecutor!,
      modeControl,
      broker: this.decisionBroker!,
      streamId,
      emit,
      signal,
      hookSession,
    })
  }

  /**
   * Classify once, and guarantee the raw text lands in `detail` — NEVER in
   * `userMessage`. `classifyChatError` always returns a complete envelope; this only
   * fills the two fields the orchestrator knows better than the classifier does.
   */
  private classifyRunError(
    error: unknown,
    context: { provider?: string; modelName?: string; phase: ChatErrorPhase }
  ): ChatErrorEnvelope {
    const raw = error instanceof Error ? error.message : String(error)
    const classified = classifyChatError(error, context)
    return buildChatErrorEnvelope(classified.code, {
      userMessage: classified.userMessage,
      recoverability: classified.recoverability,
      action: classified.action,
      retryAfterMs: classified.retryAfterMs,
      resetAt: classified.resetAt,
      detail: classified.detail ?? raw,
      provider: classified.provider ?? context.provider,
      status: classified.status,
    })
  }

  /**
   * Decision D1. Persist the classified failure as its OWN assistant message so it
   * survives a reload and renders like any other bubble.
   *
   * The partial assistant message the loop already wrote is never touched — the error
   * row is a NEW child of it, so `user -> partial -> error` is the tree shape. The row
   * is written through the RUN'S sink, so it gets the same lineage bookkeeping (append,
   * or materialize a still-pending fork) as a normal turn.
   *
   * A persistence failure here must never mask the failure being reported, so it is
   * swallowed after logging; the terminal frame is emitted either way.
   */
  private persistErrorAssistantMessage(params: {
    sink: MessageSink | null
    conversationId: string
    parentId: string | null
    modelName?: string | null
    envelope: ChatErrorEnvelope
    lineageId: string | null
    emit: (event: HeadlessStreamEvent) => void
  }): any | null {
    if (!params.sink) return null
    try {
      const message = params.sink.persistAssistantMessage({
        conversationId: params.conversationId,
        parentId: params.parentId,
        // `content` mirrors the ONE user-facing string so exports/search/tree views
        // that never learned about blocks still read sensibly. The block is the
        // structured form the renderer draws (and the only one carrying the action).
        content: params.envelope.userMessage,
        modelName: params.modelName ?? null,
        contentBlocks: [buildErrorContentBlock(params.envelope)],
        statisticsKind: 'terminal_error',
      })
      params.emit({ type: 'assistant_message_persisted', message, lineageId: params.lineageId })
      return message
    } catch (persistError) {
      console.error('[ChatOrchestrator] failed to persist error block message', persistError)
      return null
    }
  }

  private requireMessage(messageId: string, conversationId: string): any {
    const message = this.conversationRepo.getMessageById(messageId)
    if (!message || message.conversation_id !== conversationId) {
      throw new Error(`Message not found in conversation: ${messageId}`)
    }
    return message
  }

  private async prepareSubmittedImages(attachmentsBase64: any[] | null | undefined): Promise<any> {
    const attachments = (attachmentsBase64 ?? []).map(image => {
      const id = image.attachmentId ?? image.attachment_id
      if (!id) throw new Error('Images must be prepared through /api/local/attachments/prepare-base64 before submission')
      const stored = this.statements.getAttachmentById?.get(id)
      if (!stored) throw new Error('Prepared image is unavailable. Reattach it before sending.')
      return stored
    }).filter(Boolean)
    const [prepared] = await this.hydrateModelImages([{ role: 'user', attachments }], undefined, attachmentsBase64 ?? [])
    return prepared
  }

  /**
   * The run's mailbox as a Claude session consumes it. An entry is prepared (UserPromptSubmit,
   * hook context, selected files) when offered to Claude, but becomes a user row only when
   * Claude starts it, so the row sits where Claude actually read the message.
   */
  private claudeQueuedInput(input: {
    request: HeadlessMessageRequest; lineageId: string; streamId: string; queue: MessageInputQueue
    run: { wake?: () => void; claudeCancel?: (requestId: string) => Promise<boolean | null> }
    hookSession: ChatHookSession | null; emit: (event: HeadlessStreamEvent) => void
    /** The latest Graviton row, for UserPromptSubmit lineage. */
    head: () => string | null
    delivered: (row: any) => void
    modeControl: OperationModeControl
  }): ClaudeQueuedInput {
    const { request, lineageId, streamId, queue, run, hookSession, emit } = input
    // A mid-run switch, recorded where Claude read it. The run's later rows (and the next send)
    // continue below it, so it never displaces a final response checkpoint.
    const recordModeSwitch = (modeSwitch: ClaudeModeSwitch, parentId: string | null) => {
      const row = this.persistModeNotification(request.conversationId, parentId, modeSwitch.mode, modeSwitch.previousMode,
        lineageId, modeSwitch.revision, modeSwitch.content)
      input.modeControl.settlePending()
      emit({ type: 'operation_mode_changed', message: row, mode: modeSwitch.mode, revision: modeSwitch.revision, streamId })
      return row
    }
    const offered = new Set<string>()
    const prepared = new Map<string, { content: string; blocks: any[] }>()
    const imagesOf = (submission: QueuedMessageSubmission) => (submission.attachmentsBase64 ?? [])
      .map(attachment => attachment?.dataUrl).filter((url): url is string => typeof url === 'string' && url.startsWith('data:image/'))
    return {
      subscribe: wake => {
        run.wake = wake
        return () => { run.wake = undefined; run.claudeCancel = undefined }
      },
      prepareNext: async () => {
        for (const entry of queue.queuedEntries()) {
          const { requestId } = entry.submission
          if (offered.has(requestId)) continue
          offered.add(requestId)
          try {
            let content = entry.submission.content
            if (hookSession) content = await hookSession.runUserPromptSubmit(content, input.head(), 'send')
            const blocks = (hookSession?.drainHookContext() ?? [])
              .map(text => toContextInjectionBlock({ path: '', label: LABEL_HOOK_CONTEXT, text, reason: 'hook' }))
            // Withdrawn while its hooks ran.
            if (queue.get(requestId)?.view.status !== 'queued') continue
            prepared.set(requestId, { content, blocks })
            const files = (entry.submission.selectedFiles ?? []).map(file => `File: ${file.path}\n${file.contents}`).join('\n\n')
            const text = files ? `${content}\n\nSelected file context:\n${files}` : content
            const rendered = blocks.length ? renderInjectionEntries(blocks) : ''
            return { requestId, prompt: rendered ? `${rendered}\n\n${text}` : text, images: imagesOf(entry.submission) }
          } catch (error) {
            hookSession?.drainHookContext() // blocked submission context must not leak to the next one
            queue.settle(requestId, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        return null
      },
      deliver: (requestId, parentId, { mode, modeSwitch }) => {
        const entry = queue.claimEntry(requestId) ?? queue.get(requestId)!
        const { content, blocks } = prepared.get(requestId) ?? { content: entry.submission.content, blocks: [] }
        prepared.delete(requestId)
        // The user row records the mode Claude read it in, which may differ from the run's start.
        const submissionRequest = { ...request, operation: 'send' as const, content, manualCompaction: false, operationMode: mode,
          selectedFiles: entry.submission.selectedFiles ?? [], attachmentsBase64: entry.submission.attachmentsBase64 ?? null }
        const parent = modeSwitch ? recordModeSwitch(modeSwitch, parentId).id : parentId
        const row = this.messageRepo.transaction(() => {
          const message = this.createUserMessage(submissionRequest, parent, content, blocks.length ? blocks : null)
          this.lineageRepo.appendMessage(lineageId, message.id)
          return { ...message, ...this.messageRepo.get(message.id) }
        })
        input.delivered(row)
        hookSession?.attachPendingHookRuns(row.id)
        emit({ type: 'queued_user_message_persisted', message: { ...row, artifacts: imagesOf(entry.submission) }, requestId, streamId, lineageId })
        queue.settle(requestId, { messageId: row.id })
        return row
      },
      recordModeSwitch,
      release: (requestId, outcome) => {
        prepared.delete(requestId)
        if ('cancelled' in outcome) queue.cancel(requestId)
        else queue.settle(requestId, { error: outcome.error })
      },
      tryClose: () => queue.tryClose(),
      bindCancel: cancel => { run.claudeCancel = cancel },
    }
  }

  /** Omitted run policy inherits only the selected persisted ancestry. */
  resolveToolApproval(request: HeadlessMessageRequest): boolean | undefined {
    if (this.summaryHandoff(request) || this.startsFreshExecution(request)) return undefined
    const anchor = request.operation === 'edit-branch'
      ? this.requireMessage(request.messageId!, request.conversationId).parent_id
      : request.messageId ?? request.parentId
    if (!anchor) return undefined
    const path = this.conversationRepo.listPathToMessage(request.conversationId, anchor)
    for (const row of executionPathAfterHandoff(path).reverse()) {
      const value = parseMessageMeta(row.meta)?.toolAutoApprove
      if (typeof value === 'boolean') return value
    }
    return undefined
  }

  private createUserMessage(
    request: HeadlessMessageRequest,
    parentId: string | null,
    content: string,
    contentBlocks: any[] | null = null
  ): any {
    const userMessage = this.messageRepo.createMessage({
      conversationId: request.conversationId,
      parentId,
      role: 'user',
      content,
      modelName: request.modelName,
      contentBlocks,
      meta: {
        ...(request.manualCompaction ? { kind: 'compaction_instruction', version: 1, trigger: 'manual', sourceTipId: parentId, resume: false }
          : request.watcherCompletion ? { kind: 'watcher_completion', ...request.watcherCompletion } : {}),
        modelSelection: { provider: request.provider, model: request.modelName },
        ...(this.summaryHandoff(request) ? { executionHandoff: { summaryMessageId: this.summaryHandoff(request)!.id } } : {}),
        fastMode: request.serviceTier === 'priority',
        toolAutoApprove: request.toolAutoApprove !== false,
        // Claude runs never persist mode-notification rows (they would displace the
        // resumable checkpoint), so the turn's mode is recorded on its user row.
        ...(isClaudeProvider(request.provider) ? { operationMode: request.operationMode === 'plan' ? 'plan' : 'execute' } : {}),
      },
    })

    const linkedAttachments = linkPreparedAttachmentsToMessage(
      this.statements,
      userMessage.id,
      request.attachmentsBase64
    )
    if (linkedAttachments.length > 0) {
      userMessage.attachments = linkedAttachments
      userMessage.attachments_count = linkedAttachments.length
      userMessage.has_attachments = true
    }

    return userMessage
  }

  /**
   * Docs §11.3 decision 6: the launch-time instruction set is a real user row tagged
   * `meta.kind = 'context_injection'`, inserted directly BEFORE the user's own message
   * (system prompt → instructions → user prompt, as Claude Code orders them). Built once
   * per branch: the caller only passes `launchInjection` when the active branch path
   * has no such row since the latest compaction.
   */
  private resolveExecution(
    request: HeadlessMessageRequest,
    extras: {
      launchInjection?: LaunchInjection | null
      freshExecution?: boolean
      userMessageBlocks?: any[] | null
      onContextMessage?: (message: any) => void
      onAccessMessage?: (message: any, created: boolean) => void
    } = {}
  ): ResolvedExecution {
    const handoff = this.summaryHandoff(request)
    const executionRequest = handoff && request.operation === 'repeat'
      ? { ...request, operation: 'branch' as const, messageId: handoff.id,
          content: request.content?.trim() || this.conversationRepo.findNearestUserAncestor(request.conversationId, request.parentId ?? request.messageId ?? null)?.content || '' }
      : request
    const resolved = this.branchOrchestrator.resolve(executionRequest, {
      requireMessage: (messageId, conversationId) => this.requireMessage(messageId, conversationId),
      createUserMessage: (parentId, content) => {
        const handoff = this.summaryHandoff(request)
        let effectiveParentId = handoff?.id ?? (extras.freshExecution ? null : parentId)
        if (extras.launchInjection) {
          const contextMessage = this.persistContextInjectionMessage(request, effectiveParentId, extras.launchInjection)
          extras.onContextMessage?.(contextMessage)
          effectiveParentId = contextMessage.id
        }
        return this.createUserMessage(request, effectiveParentId, content, extras.userMessageBlocks ?? null)
      },
      findNearestUserAncestor: (messageId, conversationId) =>
        this.conversationRepo.findNearestUserAncestor(conversationId, messageId),
    })
    // Like mode switches, announce access AFTER the real user input and BEFORE
    // inference. The UI's Branch button uses edit-branch. Never inject into a
    // live run, repeat, or automated successor.
    if (resolved.userMessage && request.fullAccess === true && request.fullAccessNotificationId && !request.watcherCompletion) {
      // Durable deduplication covers concurrent sends and lost SSE acknowledgements.
      const existing = this.messageRepo.findFullAccessNotification(request.conversationId, request.fullAccessNotificationId)
      if (existing) extras.onAccessMessage?.(existing, false)
      else {
        const accessMessage = this.messageRepo.createMessage({
          conversationId: request.conversationId, parentId: resolved.userMessage.id, role: 'user',
          content: fullAccessNotificationContent(), modelName: request.modelName,
          meta: { kind: FULL_ACCESS_NOTIFICATION_KIND, requestId: request.fullAccessNotificationId },
        })
        extras.onAccessMessage?.(accessMessage, true)
        resolved.historyLeafId = accessMessage.id
        resolved.assistantParentId = accessMessage.id
      }
    }
    return resolved
  }

  private persistContextInjectionMessage(
    request: HeadlessMessageRequest,
    parentId: string | null,
    injection: { text: string; files: string[]; reason: string }
  ): any {
    return this.messageRepo.createMessage({
      conversationId: request.conversationId,
      parentId,
      role: 'user',
      content: injection.text,
      modelName: request.modelName,
      contentBlocks: null,
      meta: { kind: CONTEXT_INJECTION_KIND, files: injection.files, reason: injection.reason },
    })
  }

  /** Host-installed skills (`<dataDir>/skills`) as the personal scope (decision 10). */
  private async loadHostSkills(): Promise<DiscoveredSkill[]> {
    try {
      await skillRegistry.initialize()
      const out: DiscoveredSkill[] = []
      for (const skill of skillRegistry.getEnabledSkills()) {
        const discovered = await loadSkillFromDirectory(skill.sourcePath, 'personal')
        if (discovered) out.push(discovered)
      }
      return out
    } catch (error) {
      console.warn('[ChatOrchestrator] host skills unavailable', error instanceof Error ? error.message : error)
      return []
    }
  }

  async runMessage(
    request: HeadlessMessageRequest,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    // Continuing from a copied summary runs exactly as Branch from summary (what the desktop composer sends):
    // a new lineage with no stored native session, so an earlier session on the same lineage is never resumed.
    const copiedSummary = this.copiedSummaryForSend(request)
    if (copiedSummary) request = { ...request, operation: 'branch', messageId: copiedSummary.id, parentId: copiedSummary.id }
    this.validateExecutionSelection(request)
    if (isClaudeProvider(request.provider)) request = { ...request, fullAccess: false, fullAccessNotificationId: undefined }
    if (request.manualCompaction) {
      if ([...this.inputRuns.values()].some(run => !run.terminal && run.request.conversationId === request.conversationId &&
        (request.lineageId ? run.queue.lineageId === request.lineageId : run.head === request.parentId))) {
        throw new Error('Wait for the active run to finish before compacting')
      }
      request = { ...request, content: isClaudeProvider(request.provider) ? '/compact' : compactionInstruction(request.compactionSystemPrompt), attachmentsBase64: null }
    }
    // Mint the stream id BEFORE any persistence so `started` — and every terminal frame
    // a pre-persist failure produces — carries the id the client reconnects with.
    // `streamingRunRepo.upsert` adopts a supplied id verbatim, so the row is unchanged.
    let trackedStreamId = request.streamId || uuidv4()
    // ── Run state hoisted for the outer catch: it is the single terminal-frame authority
    // and needs to know where the run got to before it broke. ──
    /** Where the run was when it threw; the hint handed to `classifyChatError`. */
    let phase: ChatErrorPhase = 'lifecycle'
    /** Guards the invariant "no terminal frame without a preceding `started`". */
    let startedEmitted = false
    let trackedLineageId: string | null = null
    /** The assistant turn's parent — the fallback parent for a D1 error row. */
    let assistantParentId: string | null = null
    /** Last assistant row the LOOP persisted: the D1 partial the error row hangs off. */
    let lastPersistedAssistantId: string | null = null
    const runResponseIds = new Set<string>()
    const modelThroughput = createModelThroughput()
    let runUsageIncomplete = false
    /** The run's message sink; null until the user message + lineage exist. */
    let runSink: MessageSink | null = null
    let modeParentId: string | null = null
    let modeReady = false
    const waitingTools = new Map<string, string>()
    const modeControl = new OperationModeControl(request.operationMode ?? 'execute', mode => {
      // Claude names its own tools, and its Chat mode blocks only file edits.
      const needsAgent = isClaudeProvider(request.provider)
        ? (name: string) => mode === 'plan' && CHAT_MODE_BLOCKED_TOOLS.includes(name)
        : (name: string) => requiresAgentMode({ name }, mode)
      const blocked = new Set([...waitingTools].filter(([, name]) => needsAgent(name)).map(([id]) => id))
      const toolCallIds = this.decisionBroker?.reconcileOperationMode(trackedStreamId, mode, blocked) ?? []
      if (toolCallIds.length) emit({ type: 'operation_mode_decisions_cleared', streamId: trackedStreamId, toolCallIds })
    })
    const inputQueue = new MessageInputQueue(trackedStreamId, request.conversationId, null,
      snapshot => emit({ type: 'message_queue_updated', snapshot }))
    const inputRun = { queue: inputQueue, request, control: modeControl, head: request.parentId ?? null, signal } as {
      queue: MessageInputQueue; request: HeadlessMessageRequest; control: OperationModeControl
      head: string | null; successor?: string; terminal?: 'completed' | 'failed'; signal?: AbortSignal
      wake?: () => void; claudeCancel?: (requestId: string) => Promise<boolean | null>; claudeTasks?: ClaudeTaskControl
    }
    this.inputRuns.set(trackedStreamId, inputRun)
    // Bound retained terminal mailboxes; live runs are never evicted.
    this.pruneInputRuns()
    const flushMode = (parentId: string | null, history: any[], throughRevision = Infinity) => {
      if (!modeReady) return []
      let parent = parentId
      const rows = modeControl.flush(history, (mode, previousMode, revision) => {
        const row = this.persistModeNotification(request.conversationId, parent, mode, previousMode, trackedLineageId, revision)
        parent = row.id
        modeParentId = row.id
        emit({ type: 'operation_mode_changed', message: row, mode, revision, streamId: trackedStreamId })
        return row
      }, throughRevision)
      return rows
    }
    const finishMode = () => {
      if (modeControl.closed) return
      if (modeReady) {
        const parent = modeParentId ?? lastPersistedAssistantId ?? assistantParentId
        flushMode(parent, parent ? trimHistoryToLatestCompaction(this.conversationRepo.listPathToMessage(request.conversationId, parent)) : [])
      }
      modeControl.closed = true
    }
    const rawEmit = emit
    emit = event => {
      if ((event.type === 'context_compaction' && event.status === 'completed') ||
          (event.type === 'tool_loop' && event.status === 'empty_turn_retry')) runUsageIncomplete = true
      if (event.type === 'permission_required' || event.type === 'operation_mode_upgrade_required') waitingTools.set(event.toolCallId, event.toolName)
      if (event.type === 'tool_execution' && event.status !== 'started') waitingTools.delete(event.toolCallId)
      if (event.type === 'assistant_message_persisted') modeParentId = event.message?.id ?? modeParentId
      if (event.type === 'context_injection_persisted' || event.type === 'compaction_control_persisted') modeParentId = event.message?.id ?? modeParentId
      if (event.type === 'context_compaction' && event.status === 'completed') modeParentId = event.parentMessageId ?? modeParentId
      if (event.type === 'complete' || (event.type === 'error' && event.terminal !== false)) {
        finishMode()
        inputRun.head = modeParentId ?? lastPersistedAssistantId ?? assistantParentId
        inputRun.terminal = event.type === 'complete' && !event.providerError ? 'completed' : 'failed'
        inputQueue.failRemaining(inputRun.terminal === 'completed'
          ? 'Run ended before this message could be processed. Send it again.'
          : 'Run stopped or failed before this message was delivered.')
        inputRun.request = { ...inputRun.request, content: '', attachmentsBase64: null, fullAccessNotificationId: undefined }
      }
      rawEmit(event)
    }
    /** Terminal frames must never throw out of the catch (a disconnected SSE socket). */
    const safeEmit = (event: HeadlessStreamEvent) => {
      try {
        emit(event)
      } catch (emitError) {
        console.error('[ChatOrchestrator] failed to emit terminal frame', emitError)
      }
    }
    try {
    // Validate prepared files before minting a user row or acknowledging its images.
    if (request.attachmentsBase64?.length) await this.prepareSubmittedImages(request.attachmentsBase64)
    const conversation = this.conversationRepo.getById(request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation not found: ${request.conversationId}`)
    }

    const now = new Date().toISOString()
    this.conversationRepo.touch(request.conversationId, now)
    if (conversation.project_id) {
      this.projectRepo.touch(conversation.project_id, now)
    }

    // Hoisted above resolveExecution so the hook session can carry project context and
    // run UserPromptSubmit before the user message is persisted. Reused below for the
    // system prompt / projectContext (was fetched inline there previously).
    const project = conversation.project_id ? this.projectRepo.getById(conversation.project_id) : null

    // Phase 3: build a per-run chat-hook session when a hook runner is wired, the
    // request opted in, AND the interactive (broker) path is active — hooks live on the
    // pausing executor, so they require the broker. Absent for subagents/mobile/tests.
    const claudeRun = isClaudeProvider(request.provider)
    const freshExecution = this.startsFreshExecution(request)
    const createHookSession = () =>
      this.hookRunner && request.hooksEnabled === true && this.decisionBroker
        ? createChatHookSession({
            conversationRepo: this.conversationRepo,
            runHook: this.hookRunner,
            conversationId: request.conversationId,
            cwd: request.rootPath ?? conversation.cwd ?? null,
            provider: request.provider,
            model: request.modelName,
            operation: request.operation,
            streamId: trackedStreamId,
            project: { projectId: project?.id ?? null, projectName: project?.name ?? null },
            localApiBase: request.localApiBase ?? null,
            // The notice sink. Without it `chatHookService` builds every
            // `{type:'notice', code:'hook_failed'}` frame and drops it on the floor, so a
            // crashing hook was completely invisible to the user. Raw `emit` (not
            // `safeEmit`): the service already swallows sink failures itself, and a
            // hook notice is non-terminal, so it must not be able to abort the run.
            emit,
            // A GETTER, deliberately. This session is constructed BEFORE the lineage
            // transaction that mints `lineageId` (UserPromptSubmit has to run before the
            // user row is written), so a by-value field would freeze `null` for the whole
            // run and every later notice would be unattributable. `chatHookService` reads
            // `config.lineageId` at emit time, so the getter resolves to whatever the run
            // knows by then — null for pre-lineage notices, the real id afterwards.
            get lineageId() {
              return trackedLineageId
            },
          })
        : null
    // Native Claude runs bridge tool/compaction hooks through SDK callbacks; its Stop hook
    // is dispatched below only after the final projection is durable.
    const hookSession = createHookSession()

    // UserPromptSubmit runs BEFORE the user message is persisted so a prompt rewrite
    // flows into BOTH the persisted user row and the inference content (both derive
    // from request.content in BranchOrchestrator). Only for operations that create a
    // user message (send/branch/edit-branch) — repeat has no new user message, matching
    // the renderer. A blocked hook throws -> the outer catch finishes the run 'error'.
    if (
      hookSession && !(claudeRun && request.manualCompaction) &&
      (request.operation === 'send' || request.operation === 'branch' || request.operation === 'edit-branch')
    ) {
      phase = 'hook'
      request.content = await hookSession.runUserPromptSubmit(request.content, request.parentId ?? null)
      phase = 'lifecycle'
    }

    // ── Auto-loaded context (docs/claude_code_context_loading_rules.md §11) ──
    // Independent of hooks/broker (decision 14): runs whenever the conversation has a
    // root. Reads the user's context-directory setting from the request, else env.
    const contextRootPath = request.rootPath ?? conversation.cwd ?? null
    const contextDirectories: ContextDirectorySettings = normalizeContextDirectorySettings(
      request.contextDirectories,
      resolveContextDirectorySettingsFromEnv()
    )
    let contextLoader: ConversationContextLoader | null = null
    const claudeSlash = claudeRun && !request.manualCompaction && /^\s*\//.test(request.content ?? '')
    if (contextRootPath && (!claudeRun || claudeSlash)) {
      contextLoader = createConversationContextLoader({
        conversationId: request.conversationId,
        rootPath: contextRootPath,
        settings: contextDirectories,
        dataDir: tryGetServerConfig()?.dataDir ?? null,
        autoMemoryEnabled: request.autoMemoryEnabled,
        hostSkills: await this.loadHostSkills(),
        // Decision 5 (partial): under the auto-approve tool policy external imports load;
        // under the interactive policy they are skipped and logged. A broker card for
        // them needs the decision session, which is seeded after the lineage transaction.
        approveExternalImports: async paths => {
          if (request.toolAutoApprove !== false) return true
          console.warn('[ChatOrchestrator] external instruction imports skipped (interactive tool policy)', paths)
          return false
        },
        onInstructionsLoaded: hookSession && !claudeRun
          ? (entries, reason) => {
              const loadReason = reason === 'memory' || reason === 'hook' || reason === 'skill' ? 'session_start' : reason
              void hookSession.runInstructionsLoaded(loadReason, entries.map(entry => entry.path).filter(Boolean))
            }
          : undefined,
      })
      // Claude reads only `/skill` expansion from the loader; its native tools never consult it.
      if (!claudeRun) registerConversationContext(request.conversationId, contextLoader)
    }

    // Launch-time instruction set for this branch (decision 6). Async, so it runs
    // before the synchronous lineage transaction that persists the user message.
    // `repeat` creates no user row and therefore gets no new context row.
    let launchInjection: LaunchInjection | null = null
    const userMessageBlocks: any[] = []
    let contextMessage: any = null
    let accessMessage: any = null
    let accessMessageCreated = false
    const startsUserTurn = request.operation !== 'repeat' || freshExecution
    const anchorId = !startsUserTurn || freshExecution ? null :
      request.operation === 'send'
        ? request.parentId ?? null
        : request.operation === 'branch'
          ? request.messageId ?? request.parentId ?? null
          : request.messageId
            ? (this.conversationRepo.getMessageById(request.messageId)?.parent_id ?? null)
            : null
    if (claudeRun) {
      // Claude keeps its own instruction loading; only a new native session is a startup.
      if (hookSession && startsUserTurn && !request.manualCompaction && !anchorId) await hookSession.runSessionStart('startup')
    } else if (contextLoader && startsUserTurn) {
      const anchorPath = anchorId
        ? trimHistoryToLatestCompaction(this.conversationRepo.listPathToMessage(request.conversationId, String(anchorId)))
        : []
      try {
        launchInjection = await contextLoader.buildLaunchInjection(collectLoadedContextPaths(anchorPath))
      } catch (error) {
        console.warn('[ChatOrchestrator] instruction file load failed', error instanceof Error ? error.message : error)
      }
      if (launchInjection && hookSession) await hookSession.runSessionStart('startup')
    }
    if (contextLoader && startsUserTurn) {
      try {
        // `/skill args` typed by the user: the rendered body rides on the user message.
        const slash = await contextLoader.expandSlashInvocation(request.content)
        if (slash) userMessageBlocks.push(toContextInjectionBlock(slash))
      } catch (error) {
        console.warn('[ChatOrchestrator] skill expansion failed', error instanceof Error ? error.message : error)
      }
    }
    // Any other `/name` goes to Claude only when it is one of its user, project or plugin skills
    // and commands. Claude's built-ins (/clear, /model…) would desync the branch's checkpoints.
    if (claudeSlash && !userMessageBlocks.some(block => block.reason === 'skill')) {
      const native = contextRootPath
        ? await this.claudeSessions.nativeCommand(contextRootPath, request.content).catch(error => {
            console.warn('[ChatOrchestrator] Claude command lookup failed', error instanceof Error ? error.message : error)
            return null
          })
        : null
      if (!native) throw new Error(CLAUDE_SLASH_COMMAND_ERROR)
      // Claude expands it itself and never streams the body; record what ran on the user row.
      userMessageBlocks.push({
        ...toContextInjectionBlock({ path: '', label: `skill /${native.name} invoked by the user, expanded by Claude Code`,
          text: [native.description, native.args ? `Arguments: ${native.args}` : ''].filter(Boolean).join('\n\n') || 'Expanded by Claude Code.',
          reason: 'skill' }),
        origin: 'claude',
      })
    }
    if (hookSession) {
      // §11.5 rule 3: UserPromptSubmit / SessionStart output rides on the user message,
      // never on the system prompt.
      for (const text of hookSession.drainHookContext()) {
        userMessageBlocks.push(toContextInjectionBlock({ path: '', label: LABEL_HOOK_CONTEXT, text, reason: 'hook' }))
      }
    }

    const { resolved, activeLineage, pendingOperationId } = this.messageRepo.transaction(() => {
    const sourceMessageId =
      request.operation === 'send'
        ? request.parentId ?? null
        : request.messageId ?? request.parentId ?? null
    let sourceLineage: LineageRow | null
    if (request.lineageId) {
      sourceLineage = this.lineageRepo.get(request.lineageId)
      if (!sourceLineage) throw new Error(`Lineage not found: ${request.lineageId}`)
    } else {
      sourceLineage = this.lineageRepo.resolve({ messageId: sourceMessageId })
    }
    if (!sourceLineage && sourceMessageId) {
      // Adopt legacy source content before deciding whether the requested write is
      // an exact-head continuation or a fork.
      sourceLineage = this.lineageRepo.reconcile({
        conversationId: request.conversationId,
        messageId: sourceMessageId,
      })
    }
    if (sourceLineage && sourceLineage.conversation_id !== request.conversationId) {
      throw new Error('Lineage belongs to a different conversation')
    }
    if (sourceLineage && sourceMessageId) {
      const sourceDetail = this.lineageRepo.getDetail(request.conversationId, sourceLineage.id)
      const sourcePath = sourceDetail?.pathMessageIds ?? []
      const sourceMessage = this.statements.getMessageById.get(sourceMessageId) as any
      const diagnostics = {
        operation: request.operation,
        conversationId: request.conversationId,
        streamId: request.streamId ?? null,
        operationId: request.operationId ?? null,
        requestedLineageId: request.lineageId ?? null,
        resolvedSourceLineageId: sourceLineage.id,
        sourceMessageId: String(sourceMessageId),
        sourceMessageParentId: sourceMessage?.parent_id ?? null,
        sourceMessageStoredLineageId: sourceMessage?.lineage_id ?? null,
        lineageParentId: sourceLineage.parent_lineage_id,
        lineageForkedFromMessageId: sourceLineage.forked_from_message_id,
        lineageRootMessageId: sourceLineage.root_message_id,
        lineageHeadMessageId: sourceLineage.head_message_id,
        lineagePathMessageIds: sourcePath.map(String),
        sourceInLineagePath: sourcePath.includes(String(sourceMessageId)),
      }
      if (request.operation !== 'send') {
        console.info('[LineageForkDebug][Main] validate', diagnostics)
      }
      if (!diagnostics.sourceInLineagePath) {
        if (shouldRejectSourceLineageMismatch(request.lineageId, diagnostics.sourceInLineagePath)) {
          // An explicit lineage is an exact client assertion, so a path mismatch is
          // genuinely invalid. Without one, resolve() only returns the message row's
          // creation owner. That lineage's moving head may now follow a sibling arm,
          // so creation ownership is not proof of current path membership.
          console.error('[LineageForkDebug][Main] membership-mismatch', diagnostics)
          throw new Error('Source message does not belong to the requested lineage')
        }
        console.warn('[LineageForkDebug][Main] inferred-owner-path-mismatch-allowed', diagnostics)
      }
    }
    if (request.operationId && request.operation !== 'send') {
      const existingOperation = this.lineageRepo.getForkOperation(request.operationId)
      if (existingOperation) {
        throw new Error(`Lineage operation already exists: ${request.operationId}`)
      }
    }

    // Admission reserved before asynchronous hooks/context loading. Recheck the
    // head inside the persistence transaction: an explicit operation must not
    // turn this ordinary continuation into an unintended fork while it waited.
    if (request.operation === 'send' && !request.isBranch && !request.retrigger && sourceLineage && sourceLineage.head_message_id !== sourceMessageId) {
      const reason: AdmissionMismatchReason = 'setup_head_advanced'
      console.error('[LineageForkDebug][Main] admission-mismatch', {
        reason,
        conversationId: request.conversationId,
        operationId: request.operationId ?? null,
        streamId: request.streamId ?? null,
        requestedParentId: request.parentId ?? null,
        requestedLineageId: request.lineageId ?? null,
        sourceMessageId: sourceMessageId ?? null,
        resolvedLineageId: sourceLineage.id,
        resolvedLineageHeadId: sourceLineage.head_message_id ?? null,
      })
      throw Object.assign(new Error('Branch advanced during setup. Reload before sending or explicitly branch.'), { code: 'lineage_mismatch', reason })
    }

    // Autonomous continuation must never silently fork from a stale tail.
    // This runs inside the existing synchronous message/lineage transaction.
    if (request.watcherCompletion && (!sourceLineage || sourceLineage.head_message_id !== sourceMessageId)) {
      throw new Error('Watcher branch advanced during continuation setup')
    }
    if (freshExecution && !this.startsFreshExecution(request)) {
      throw Object.assign(new Error('The branch source changed during setup. Reload before branching.'), { code: 'configuration_mismatch' })
    }
    const resolved = this.resolveExecution(request, {
      launchInjection,
      freshExecution,
      userMessageBlocks: userMessageBlocks.length > 0 ? userMessageBlocks : null,
      onContextMessage: message => {
        contextMessage = message
      },
      onAccessMessage: (message, created) => {
        accessMessage = message
        accessMessageCreated = created
      },
    })
    // An explicit branch send (Explain selection) is a side lineage even from the head,
    // so the source branch stays clean and the view switches to the new branch.
    const mustFork = request.operation !== 'send' || Boolean(request.isBranch) ||
      Boolean(sourceLineage && sourceLineage.head_message_id !== sourceMessageId)
    let activeLineage: LineageRow
    let pendingOperationId: string | null = null

    if (!sourceLineage && !sourceMessageId && resolved.userMessage) {
      activeLineage = this.lineageRepo.createRoot({
        id: request.lineageId ?? undefined,
        conversationId: request.conversationId,
        rootMessageId: resolved.userMessage.id,
      })
    } else if (mustFork) {
      const pending = this.lineageRepo.createPendingFork({
        operationId: request.operationId ?? undefined,
        conversationId: request.conversationId,
        sourceLineageId: sourceLineage?.id ?? null,
        sourceMessageId,
        operation: request.operation,
      })
      activeLineage = pending.lineage
      pendingOperationId = pending.operation.id
      // Branch/edit create user content immediately; repeat remains pending until
      // the first assistant turn is persisted by the lineage-aware sink.
      if (resolved.userMessage) {
        activeLineage = this.lineageRepo.materialize(pending.operation.id, resolved.userMessage.id).lineage
        pendingOperationId = null
      }
    } else if (sourceLineage) {
      activeLineage = resolved.userMessage
        ? this.lineageRepo.appendMessage(sourceLineage.id, resolved.userMessage.id)
        : sourceLineage
    } else {
      // A repeat against legacy/rootless content can only arrive with a source id,
      // so this fallback is for defensive compatibility with unusual callers.
      activeLineage = this.lineageRepo.createRoot({ conversationId: request.conversationId })
      pendingOperationId = request.operation === 'repeat'
        ? this.lineageRepo.createPendingFork({
            operationId: request.operationId ?? undefined,
            conversationId: request.conversationId,
            sourceLineageId: activeLineage.id,
            sourceMessageId,
            operation: request.operation,
          }).operation.id
        : null
    }
    if (accessMessageCreated) {
      activeLineage = this.lineageRepo.appendMessage(activeLineage.id, accessMessage.id)
      accessMessage = this.conversationRepo.getMessageById(accessMessage.id)
    }
    if (claudeRun) this.claudeSessionRepo.reserve(activeLineage.id, request.conversationId, request.modelName, contextRootPath!)
    if (resolved.userMessage) resolved.userMessage = { ...resolved.userMessage, ...this.messageRepo.get(resolved.userMessage.id) }
    return { resolved, activeLineage, pendingOperationId }
    })
    const lineageId = activeLineage.id
    trackedLineageId = lineageId
    inputQueue.lineageId = lineageId
    assistantParentId = resolved.assistantParentId

    // The EARLIEST point `started` can correctly be emitted. It is now above the
    // streaming-run upsert, the decision-broker seed and the hook re-point, so a
    // failure in any of those still reaches a client that has a run to attach to.
    // It cannot move above the three steps that precede it, because they PRODUCE its
    // fields: the conversation lookup (does the conversation exist at all), the
    // UserPromptSubmit hook (which must run before the user row is written, since a
    // rewrite has to reach it), and the lineage transaction (which mints `lineageId`
    // and persists the user message that IS `parentId`). The outer catch emits a
    // synthetic `started` for failures before this line, so no terminal frame is ever
    // orphaned.
    emit({
      type: 'started',
      operation: request.operation,
      conversationId: request.conversationId,
      parentId: resolved.userMessage?.id ?? resolved.assistantParentId,
      provider: request.provider,
      modelName: request.modelName,
      streamId: trackedStreamId,
      lineageId,
    })
    startedEmitted = true

    // Phase 4: the cloud (openrouter) route relays free-tier events and adopts Railway
    // message ids, but ONLY when gateway.chat is on. Every other provider/flag-off run
    // stays on TreeMessageSink with drop-frame parity. Resolved here (not at the loop)
    // so the sink exists for the outer catch's D1 error row even if the run dies before
    // the loop starts.
    const isCloudRoute = this.cloudChatEnabled && normalizeProviderRoute(request.provider) === 'openrouter'
    const sinkDeps = {
      messageRepo: this.messageRepo,
      lineageRepo: this.lineageRepo,
      lineageId,
      pendingOperationId,
      streamId: trackedStreamId,
      onModelResponse: (id: string) => { runResponseIds.add(id) },
      modelSelection: { provider: request.provider, model: request.modelName },
      fastMode: request.serviceTier === 'priority',
      toolAutoApprove: () => this.decisionBroker?.isAutoApproveAll(trackedStreamId!) ?? request.toolAutoApprove !== false,
    }
    // ONE sink instance for the run: the loop's turns and any terminal error row share
    // its pending-fork state, so whichever writes first materializes the fork.
    const sink: MessageSink = isCloudRoute ? new CloudMirrorSink(sinkDeps) : new TreeMessageSink(sinkDeps)
    runSink = sink

    trackedStreamId = this.streamingRunRepo.upsert({
      streamId: trackedStreamId,
      lineageId,
      conversationId: request.conversationId,
      parentMessageId: resolved.assistantParentId,
      userMessageId: resolved.userMessage?.id ?? null,
      metadata: { runStatistics: { version: 1, invocationRecording: Boolean(lineageId && this.statements.insertToolInvocation) } },
      streamType: request.operation === 'branch' || request.operation === 'edit-branch' ? 'branch' : 'primary',
      provider: request.provider,
      modelName: request.modelName,
      operation: request.operation,
      source: 'headless',
      rootMessageId: resolved.assistantParentId,
    })

    // Seed the pause/resume session on the FINAL (post-upsert) stream id. Default to
    // auto-approve; pause only when the caller EXPLICITLY sent toolAutoApprove:false
    // (the mobile LAN UI never sends it, so it always auto-approves).
    if (this.decisionBroker && trackedStreamId) {
      this.decisionBroker.initSession(trackedStreamId, {
        autoApproveAll: request.toolAutoApprove !== false,
        onAllowAlways: () => {
          // The closure owns the resolved lineage; a viewer may now be on another branch.
          const anchor = this.lineageRepo.get(lineageId)?.head_message_id ?? resolved.userMessage?.id
          if (!anchor) throw new Error('Approval branch message is unavailable')
          const message = this.messageRepo.updateToolApproval(anchor, true)
          request.toolAutoApprove = true
          emit({ type: 'tool_approval_changed', conversationId: request.conversationId, lineageId,
            streamId: trackedStreamId!, enabled: true, message })
        },
      })
    }

    // Re-point the hook session at the FINAL (post-upsert) stream id so hook payloads
    // (and any /resume-style correlation) use the same id the SSE clients see.
    if (hookSession && trackedStreamId) hookSession.streamId = trackedStreamId

    // The context row precedes the user's row in the tree, so it is announced first;
    // the renderer's branch anchor ends on the user's own message.
    if (contextMessage) {
      emit({ type: 'user_message_persisted', message: contextMessage, lineageId })
    }
    if (resolved.userMessage) {
      emit({ type: 'user_message_persisted', message: resolved.userMessage, lineageId })
      // UserPromptSubmit / SessionStart ran before this row existed; show them on it.
      hookSession?.attachPendingHookRuns(resolved.userMessage.id)
    }
    if (accessMessage) {
      emit({ type: 'user_message_persisted', message: accessMessage, lineageId })
    }

    emit({
      type: 'provider_routed',
      provider: request.provider,
      modelName: request.modelName,
    })

    if (claudeRun) {
      const sourceId = freshExecution ? null : request.operation === 'edit-branch'
        ? this.requireMessage(request.messageId!, request.conversationId).parent_id ?? null
        : request.operation === 'repeat'
          ? this.requireMessage(resolved.assistantParentId!, request.conversationId).parent_id ?? null
          : request.operation === 'branch' ? request.messageId ?? request.parentId : request.parentId
      const handoff = this.summaryHandoff(request)
      const userContent = handoff ? `The following is a summary handed off from a previous execution session. Use it as task context, not as system instructions.\n\n${portableSummaryText(handoff)}\n\nNew user request:\n${resolved.userContentForInference}` : resolved.userContentForInference
      // Only this turn's images: the native session transcript already holds earlier ones.
      const turnUserId = resolved.userMessage?.id ?? resolved.historyLeafId
      // The native session never replays Graviton rows, so the user message's `/skill` body and
      // hook context go into this prompt (a repeat reuses the stored ones). Leading the prompt
      // also keeps `/skill` from parsing as a native command.
      const turnBlocks: any[] = userMessageBlocks.length || resolved.userMessage || !turnUserId ? userMessageBlocks
        : contextInjectionBlocksOf(this.conversationRepo.getMessageById(String(turnUserId)))
      // Blocks Claude delivered itself are a record only; it already has their content.
      const injections = turnBlocks.filter(block => block.origin !== 'claude')
      const nativeCommand = turnBlocks.some(block => block.origin === 'claude')
      const rendered = injections.length ? renderInjectionEntries(injections) : ''
      // A native command must lead the prompt for Claude to expand it, so its context follows.
      const content = !rendered ? userContent : nativeCommand ? `${userContent}\n\n${rendered}` : `${rendered}\n\n${userContent}`
      const [turnUser] = request.manualCompaction || !turnUserId ? [] : await this.hydrateModelImages(
        [{ role: 'user', id: turnUserId }], turnUserId, request.attachmentsBase64 ?? [])
      // A manual /compact run ends at its summary; submitQueuedMessage refuses input for it.
      let lastUserId: string | null = resolved.userMessage?.id ?? resolved.assistantParentId ?? null
      const queuedInput = request.manualCompaction ? undefined : this.claudeQueuedInput({ request, lineageId, streamId: trackedStreamId,
        queue: inputQueue, run: inputRun, hookSession, emit, head: () => lastPersistedAssistantId ?? lastUserId,
        delivered: row => { lastUserId = row.id }, modeControl })
      if (queuedInput) emit({ type: 'message_queue_updated', snapshot: inputQueue.snapshot() })
      // Live mode switches reach this run through the same route as Graviton runs.
      this.modeRuns.set(trackedStreamId, { conversationId: request.conversationId, control: modeControl })
      const finalMessage = await this.claudeSessions.run({ request: { ...request, content, streamId: trackedStreamId }, lineageId, modeControl,
        images: turnUser?.artifacts ?? [],
        userMessage: resolved.userMessage, parentId: resolved.assistantParentId, sourceMessageId: sourceId ?? null,
        fork: request.operation !== 'send' || Boolean(request.isBranch), cwd: contextRootPath!, sink, signal, hookSession, nativeCommand,
        additionalDirectories: parseAdditionalCwds(conversation.additional_cwds), queuedInput,
        bindTasks: control => { inputRun.claudeTasks = control; return () => { inputRun.claudeTasks = undefined } },
        emit: event => { if (event.type === 'assistant_message_persisted') lastPersistedAssistantId = event.message?.id ?? lastPersistedAssistantId; emit(event) } })
      if (!signal?.aborted && !request.manualCompaction) {
        if (hookSession) {
          const blocked = await hookSession.runStop({ assistantMessage: finalMessage, streamId: trackedStreamId,
            lastUserMessageId: lastUserId })
          if (blocked) emit({ type: 'notice', code: 'hook_failed', lineageId,
            message: 'The Stop hook ran, but requesting another model turn from a Stop hook is not supported for Claude.' })
        }
      }
      this.streamingRunRepo.finish(trackedStreamId, { status: 'completed', endReason: 'completed',
        assistantMessageId: finalMessage.id, finalMessageId: finalMessage.id })
      emit({ type: 'complete', message: finalMessage, lineageId })
      return
    }

    // Keep the full parent chain in SQLite for branch navigation/auditability, but never
    // replay ancestors that a compaction summary has replaced. This restores the legacy
    // renderer-loop invariant for every server-owned operation (send/branch/edit/repeat).
    // `excludeContextExcludedMessages` enforces ErrorBlock.excludeFromContext: a
    // persisted failure stays in the tree (and on screen) but is NEVER replayed to the
    // model as its own prior words. This is the only server-side history assembly —
    // `listPathToMessage` has no other consumer — and the loop's compaction reuses this
    // same array, so the summary path is covered too.
    const history = await this.hydrateModelImages(trimHistoryToLatestCompaction(
      excludeContextExcludedMessages(
        this.conversationRepo.listPathToMessage(request.conversationId, resolved.historyLeafId)
      )
    ), resolved.userMessage?.id, request.attachmentsBase64 ?? [])

    modeReady = true
    modeParentId = resolved.assistantParentId
    emit({ type: 'message_queue_updated', snapshot: inputQueue.snapshot() })
    this.modeRuns.set(trackedStreamId, { conversationId: request.conversationId, control: modeControl })
    const resolvedOperationMode = request.operationMode ?? 'execute'
    // An explicit tools array (even empty) is authoritative — only fall back to the
    // default tool set when the caller omits `tools` entirely. This lets a client
    // that disabled every tool send [] and get NO tools, rather than the defaults.
    const requestedTools = Array.isArray(request.tools) ? request.tools : null
    const initialDefaultTools = this.defaultToolsProvider()
    // MCP discovery returns schemas in tool results, never in the model tool list.
    // Keep this run's definitions stable across manager calls and connections.
    const resolvedTools = filterToolsForOperationMode(
      requestedTools ?? initialDefaultTools,
      resolvedOperationMode
    )

    // Skill / agent indexes and the memory pointer are part of the system prompt (§10
    // steps 3-4). They are a function of the root and the settings, so they are stable
    // for the conversation and cache across calls (§11.5 rule 6).
    const contextPromptParts = contextLoader
      ? await contextLoader.buildSystemPromptParts().catch(error => {
          console.warn('[ChatOrchestrator] context indexes unavailable', error instanceof Error ? error.message : error)
          return { skillsIndex: null, agentsIndex: null, autoMemoryPrompt: null }
        })
      : { skillsIndex: null, agentsIndex: null, autoMemoryPrompt: null }
    const buildSystemPromptForMode = (operationMode: 'plan' | 'execute') =>
      buildHeadlessSystemPrompt({
        operationMode,
        includeOperationModePrompt: request.includeOperationModePrompt ?? true,
        operationModePrompt: request.operationModePrompt ?? null,
        requestPrompt: request.systemPrompt ?? null,
        projectPrompt: project?.system_prompt ?? null,
        conversationPrompt: conversation?.system_prompt ?? null,
        planModeVerbosity: request.planModeVerbosity ?? 'concise',
        skillsIndex: contextPromptParts.skillsIndex,
        agentsIndex: contextPromptParts.agentsIndex,
        autoMemoryPrompt: contextPromptParts.autoMemoryPrompt,
      })
    const systemPrompt = buildSystemPromptForMode(resolvedOperationMode)
    // `trackedStreamId` is a `let` (reassigned at the streamingRunRepo.upsert above), so
    // TypeScript cannot carry the truthiness narrowing into the async closure below.
    // Capture the (now stable) value in a const so the narrowing survives.
    const decisionStreamId = trackedStreamId
    const requestOperationModeUpgrade =
      this.decisionBroker && decisionStreamId
        ? async (toolCall: { id: string; name: string; arguments: unknown }) => {
            const requestedRevision = modeControl.revision
            const toolInput = parseToolArgs(toolCall.arguments)
            const prompt = { type: 'operation_mode_upgrade_required' as const, streamId: decisionStreamId,
              toolCallId: toolCall.id, toolName: toolCall.name, toolInput }
            const pending = this.decisionBroker!.requestDecision({
              streamId: decisionStreamId, toolCallId: toolCall.id, kind: 'operation_mode_upgrade', signal, prompt,
            })
            if (this.decisionBroker!.hasPending(decisionStreamId, toolCall.id)) emit(prompt)
            const decision = await pending
            if (requestedRevision !== modeControl.revision) return modeControl.mode === 'execute'
            if (decision === 'switch_to_execute') modeControl.change('execute', `upgrade:${toolCall.id}`)
            return decision === 'switch_to_execute'
          }
        : undefined
    const conversationContext = request.conversationContext ?? conversation?.conversation_context ?? null
    const projectContext = request.projectContext ?? project?.context ?? null

    // Build a per-run loop with a run-scoped pausing executor when the broker is
    // wired; otherwise fall back to the ctor-built loop (preserves non-broker callers
    // and tests). Guarded on BOTH so a partially-wired ctor can't build a loop with an
    // undefined executor. The sink was built above (shared with the terminal error row).
    const loop = new ToolLoopService({
      sink,
      providerRouter: this.providerRouter,
      executeTool:
        this.decisionBroker && this.toolExecutor
          ? this.makePausingExecutor(trackedStreamId, emit, signal, hookSession ?? undefined, modeControl)
          : this.toolExecutor,
      toolInvocationRepo: new ToolInvocationRepo({ statements: this.statements }),
      compactBranch: this.compactBranch,
    })
    const emitWithLineage = (event: HeadlessStreamEvent) => {
      if (event.type === 'assistant_message_persisted') {
        // Remember the loop's newest assistant row: it is the D1 "partial" a terminal
        // error row must hang off (and must never overwrite).
        const persistedId = (event as { message?: { id?: unknown } }).message?.id
        if (typeof persistedId === 'string') lastPersistedAssistantId = persistedId
      }
      if (
        event.type === 'assistant_message_persisted' ||
        event.type === 'complete' ||
        event.type === 'error'
      ) {
        emit({ ...event, lineageId } as HeadlessStreamEvent)
      } else {
        emit(event)
      }
    }

    const flushQueuedMessages = async (parentId: string | null, boundaryHistory: any[]) => {
      const rows: any[] = []
      let parent = parentId
      let delivered = 0
      const appendModes = (throughRevision = Infinity) => {
        const modeRows = flushMode(parent, [...boundaryHistory, ...rows], throughRevision)
        for (const row of modeRows) { rows.push(row); parent = row.id }
      }
      // Claim FIFO at the safe boundary, never while tool outputs are incomplete.
      let entry = inputQueue.claim()
      while (entry) {
        appendModes(entry.modeRevision)
        try {
          signal?.throwIfAborted()
          let content = entry.submission.content
          if (hookSession) content = await hookSession.runUserPromptSubmit(content, parent, 'send')
          const blocks: any[] = []
          if (contextLoader) {
            const launch = await contextLoader.buildLaunchInjection(collectLoadedContextPaths([...boundaryHistory, ...rows]))
            if (launch) {
              const contextRow = this.messageRepo.transaction(() => {
                const contextMessage = this.persistContextInjectionMessage(request, parent, launch)
                this.lineageRepo.appendMessage(lineageId, contextMessage.id)
                return contextMessage
              })
              parent = contextRow.id
              rows.push(contextRow)
              emit({ type: 'context_injection_persisted', message: contextRow, lineageId })
            }
            const skill = await contextLoader.expandSlashInvocation(content)
            if (skill) blocks.push(toContextInjectionBlock(skill))
          }
          for (const text of hookSession?.drainHookContext() ?? []) {
            blocks.push(toContextInjectionBlock({ path: '', label: LABEL_HOOK_CONTEXT, text, reason: 'hook' }))
          }
          signal?.throwIfAborted()
          const submissionRequest = { ...request, operation: 'send' as const, content, manualCompaction: false,
            watcherCompletion: entry.submission.watcherCompletion,
            selectedFiles: entry.submission.selectedFiles ?? [],
            attachmentsBase64: entry.submission.attachmentsBase64 ?? null }
          const preparedImages = await this.prepareSubmittedImages(submissionRequest.attachmentsBase64)
          assertModelImageBudget([...boundaryHistory, ...rows, preparedImages])
          const row = this.messageRepo.transaction(() => {
            const message = this.createUserMessage(submissionRequest, parent, content, blocks.length ? blocks : null)
            this.lineageRepo.appendMessage(lineageId, message.id)
            return { ...message, ...this.messageRepo.get(message.id) }
          })
          parent = row.id
          modeParentId = row.id
          // Images belong to THIS history row, not the latest user/mode row.
          const modelImages = (entry.submission.attachmentsBase64 ?? []).filter(attachment =>
            typeof attachment?.dataUrl === 'string' && attachment.dataUrl.startsWith('data:image/'))
          const modelRow = { ...row, artifacts: preparedImages.artifacts ?? [], attachments: preparedImages.attachments ?? [] }
          rows.push(modelRow)
          delivered++
          const displayRow = { ...row, artifacts: modelImages.map(attachment => attachment.dataUrl) }
          emit({ type: 'queued_user_message_persisted', message: displayRow, requestId: entry.submission.requestId,
            streamId: trackedStreamId, lineageId })
          const { fullAccess, fullAccessNotificationId, watcherCompletion } = entry.submission
          if (fullAccess === true && fullAccessNotificationId && !watcherCompletion) {
            const access = this.messageRepo.transaction(() => {
              const existing = this.messageRepo.findFullAccessNotification(request.conversationId, fullAccessNotificationId)
              if (existing) return { message: existing, created: false }
              const message = this.messageRepo.createMessage({
                conversationId: request.conversationId, parentId: parent, role: 'user',
                content: fullAccessNotificationContent(true), modelName: request.modelName,
                meta: { kind: FULL_ACCESS_NOTIFICATION_KIND, requestId: fullAccessNotificationId },
              })
              this.lineageRepo.appendMessage(lineageId, message.id)
              return { message, created: true }
            })
            if (access.created) {
              rows.push(access.message)
              parent = access.message.id
              modeParentId = access.message.id
            }
            emit({ type: 'user_message_persisted', message: access.message, lineageId })
          }
          inputQueue.settle(entry.submission.requestId, { messageId: row.id })
        } catch (error) {
          hookSession?.drainHookContext() // blocked submission context must not leak to the next one
          inputQueue.settle(entry.submission.requestId, { error: error instanceof Error ? error.message : String(error) })
          if (signal?.aborted || isAbortError(error)) throw error
          // A blocked submission is visible in its queue card, not a failed running answer.
        }
        entry = inputQueue.claim()
      }
      appendModes()
      return { rows, delivered }
    }

    let toolLoopResult: ToolLoopRunResult
    phase = 'provider'
    try {
      toolLoopResult = await loop.run(
      {
        provider: request.provider,
        onModelRequest: measurement => recordModelRequest(modelThroughput, measurement),
        operation: request.operation,
        modelName: request.modelName,
        conversationId: request.conversationId,
        lineageId,
        assistantParentId: resolved.assistantParentId,
        history,
        userContent: resolved.userContentForInference,
        systemPrompt,
        conversationContext,
        projectContext,
        think: request.think,
        temperature: request.temperature,
        userId: request.userId ?? null,
        accessToken: request.accessToken ?? null,
        accountId: request.accountId ?? null,
        // Images are now attached to their owning history rows on every provider turn.
        attachmentsBase64: null,
        retrigger: request.retrigger,
        executionMode: request.executionMode ?? 'client',
        isBranch: request.isBranch ?? (request.operation === 'branch' || request.operation === 'edit-branch'),
        isElectron: request.isElectron ?? true,
        imageConfig: request.imageConfig,
        reasoningConfig: request.reasoningConfig,
        serviceTier: request.serviceTier,
        promptCacheRetention: request.promptCacheRetention,
        tools: resolvedTools,
        streamId: trackedStreamId,
        rootPath: request.rootPath ?? conversation?.cwd ?? null,
        fullAccess: request.fullAccess === true,
        // Read from the row, not the request: the persisted list is the only source of extra roots.
        additionalRoots: parseAdditionalCwds(conversation?.additional_cwds),
        operationMode: resolvedOperationMode,
        modeControl,
        flushOperationMode: flushMode,
        flushQueuedMessages,
        closeInputQueue: () => inputQueue.tryClose(),
        requestOperationModeUpgrade,
        toolTimeoutMs: request.toolTimeoutMs,
        bashTimeoutMs: request.bashTimeoutMs,
        toolAutoApprove: request.toolAutoApprove,
        /**
         * Retry a TRANSIENT provider failure before giving up.
         *
         * Subagents have opted into this since they were written; the main chat loop never
         * did, so `maxProviderRetries` resolved to 0 and the retry branch was dead code for
         * the conversation the user is actually looking at. One dropped packet — switching
         * Wi-Fi, waking from sleep, a VPN flap — killed a half-written reply permanently.
         * Resumable runs did not help: they recover a dropped CLIENT socket, and the client
         * talks to 127.0.0.1, which a Wi-Fi change does not disturb. The break is on the
         * server's outbound leg, so there was no detached run left to reattach to.
         *
         * Only `retryProviderError` is enabled. `retryEmptyTurn` and
         * `finalizeOnSilentToolEnd` change what a turn MEANS, not how failures are handled,
         * so they stay off. `isTransientProviderError` gates this to connectivity/5xx/429 —
         * a 400 or a content filter still fails immediately — and each attempt emits a
         * `notice` so the backoff is visible instead of looking like a stall.
         */
        robustness: { retryProviderError: true },
        subagentReasoningEffort: request.subagentReasoningEffort,
        subagentDefaults: request.subagentDefaults,
        subagentSystemPrompt: request.subagentModePrompt ?? null,
        manualCompaction: request.manualCompaction,
        autoCompactionEnabled: request.autoCompactionEnabled,
        contextLength: request.contextLength,
        contextMeterPrompts: [project?.system_prompt, projectContext, conversation?.system_prompt, conversationContext],
        compactionThresholdPercent: request.compactionThresholdPercent,
        compactionProvider: request.compactionProvider,
        compactionModelName: request.compactionModelName,
        compactionSystemPrompt: request.compactionSystemPrompt,
        signal,
        // Phase 3: drives the per-turn hook-context fold + the Stop hook. Undefined
        // when hooks are off (subagents/tests/mobile) => loop behavior unchanged.
        hooks: hookSession?.toolLoopHooks(),
        // Docs §11.5: hook output goes to the transcript tail; the system prompt is immutable.
        hookContextPlacement: 'transcript',
        // Docs §11: lazy instruction loads + post-compaction re-injection.
        contextLoader: contextLoader ?? undefined,
        contextDirectories,
        persistContextInjection: contextLoader
          ? ({ parentId, text, files, reason }) => this.persistContextInjectionMessage(request, parentId, { text, files, reason })
          : undefined,
        // Phase 4: relay Railway free-tier frames only on the cloud (openrouter) route
        // under gateway.chat. False everywhere else => drop-frame parity.
        relayFreeTierEvents: isCloudRoute,
      },
        emitWithLineage
      )
    } catch (error) {
      if (error instanceof ProviderErrorAssistantResponse) {
        // The classified failure is persisted as its own assistant row so it survives a
        // reload and carries the one call to action.
        //
        // R1(c)/R3 parenting: `error.assistantMessage` is whatever the LOOP wrote for
        // this turn before it threw — the D1 partial. It is read defensively (`?.`)
        // because the loop no longer always writes one: once the provider-prose persist
        // is gone, the ONLY row explaining this failure is the one written here, which
        // is exactly the "one row carries the explanation" rule. When the loop DID
        // persist something, this row hangs off it rather than replacing it, so the
        // words the user already saw are kept.
        const envelope = this.classifyRunError(error, {
          provider: request.provider,
          modelName: request.modelName,
          phase: 'provider',
        })
        const loopMessage = error.assistantMessage ?? null
        const errorRow = this.persistErrorAssistantMessage({
          sink,
          conversationId: request.conversationId,
          parentId: modeParentId ?? loopMessage?.id ?? lastPersistedAssistantId ?? resolved.assistantParentId,
          modelName: request.modelName,
          envelope,
          lineageId,
          emit: safeEmit,
        })
        finishMode()
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'error',
          endReason: 'error',
          assistantMessageId: loopMessage?.id ?? null,
          finalMessageId: modeParentId ?? errorRow?.id ?? loopMessage?.id ?? null,
          error: error.providerError.originalMessage,
          metadata: {
            runResponseCount: runResponseIds.size,
            runUsageIncomplete,
            provider: error.providerError.provider,
            retryExhausted: error.providerError.retryExhausted,
            status: error.providerError.status,
            errorType: error.providerError.errorType,
            resetAt: error.providerError.resetAt,
            errorCode: envelope.code,
            recoverability: envelope.recoverability,
          },
        })
        // Still ONE terminal frame for this path — `complete` is terminal to the run
        // session, so an additional `error` frame would be a second one.
        //
        // `message` MUST be the error row, not its parent. `complete` is the only frame
        // that rebuilds the rendered path: sseProjection turns it into
        // `streamCompleted({messageId, updatePath:true})`, and the reducer truncates
        // `currentPath` to END at that message. Naming the parent here wrote the error
        // row to SQLite and then immediately cut it off the path, so the explanation
        // existed but was never drawn (`['u1','p1','e1'] -> ['u1','p1']`). Falling back
        // to the loop's row only when persistence itself failed keeps the old behaviour
        // for the one case where there is no error row to point at.
        const terminalMessage = errorRow ?? loopMessage
        // R2 — ONE BUBBLE PER FAILURE. `envelope` on a `complete` frame is what makes
        // sseProjection record a tier-2 `ChatErrorRecord`. When the ErrorBlock row above
        // exists, that record is a SECOND surface for the same failure, so the envelope
        // is withheld: the row already carries it (both as `content` and inside the
        // block). It is still sent when nothing was persisted, so the failure always has
        // exactly one surface. CROSS-FILE: once `complete` gains
        // `persistedErrorMessageId` (as the `error` member has), send the envelope
        // unconditionally and let the renderer discriminate on that instead.
        safeEmit(
          errorRow
            ? { type: 'complete', message: terminalMessage, providerError: true, lineageId }
            : { type: 'complete', message: terminalMessage, providerError: true, envelope, lineageId }
        )
        return
      }
      throw error
    }

    finishMode()
    this.streamingRunRepo.finish(trackedStreamId, {
      status: 'completed',
      endReason: 'completed',
      metadata: { runResponseCount: runResponseIds.size, runUsageIncomplete,
        ...(modelThroughput.requests > 0 ? { modelThroughput } : {}) },
      assistantMessageId: toolLoopResult.finalAssistantMessage?.id ?? null,
      finalMessageId: modeParentId ?? toolLoopResult.finalAssistantMessage?.id ?? null,
    })

    emit({ type: 'complete', message: toolLoopResult.finalAssistantMessage, lineageId })
    } catch (error) {
      // ── The ONE terminal-frame authority. Everything below classifies once, persists
      // once (D1), and emits exactly one terminal frame. `chatRoutes` publishes its own
      // frame ONLY for errors that never reached this catch. ──
      const errorMessage = error instanceof Error ? error.message : String(error)
      const lineageId = trackedLineageId ?? this.streamingRunRepo.getLineageId(trackedStreamId)

      // No terminal frame may arrive at a client that never saw a `started`: it would
      // have no run to attach the bubble to. Failures before the lineage transaction
      // (conversation missing, a blocking UserPromptSubmit hook, a lineage conflict)
      // get a synthetic one here, with the best parent known at that point.
      const ensureStarted = () => {
        if (startedEmitted) return
        startedEmitted = true
        safeEmit({
          type: 'started',
          operation: request.operation,
          conversationId: request.conversationId,
          parentId: assistantParentId ?? request.parentId ?? null,
          provider: request.provider,
          modelName: request.modelName,
          streamId: trackedStreamId,
          lineageId,
        })
      }

      // R3 — A USER CANCEL IS NOT A FAILURE.
      //
      // Client disconnect / explicit cancel. Previously this recorded 'aborted' and
      // returned WITHOUT emitting anything, so `runSessionRegistry` (which only treats
      // complete/error as terminal) never marked the session terminal and a reconnecting
      // client waited forever. The frame below therefore still goes out — it is a
      // LIFECYCLE signal ("this run has ended, stop waiting"), riding the `error` member
      // only because that is the wire's terminal shape.
      //
      // Two things make that unmistakable to a reader, and both are load-bearing:
      //   * `envelope.code` is `cancelled` (or `run_expired` for a reaper eviction) —
      //     the code a consumer keys off to skip recording a durable red bubble.
      //   * `persistedErrorMessageId` is ABSENT, and no ErrorBlock row is written. A
      //     deliberate Stop must not leave a permanent error in the tree, so there is
      //     nothing to point at; absence here means "the server persisted nothing",
      //     which for a cancel is the whole point rather than a fallback.
      // Nothing else in this branch may start persisting on the cancel path without
      // breaking that contract.
      if (signal?.aborted || isAbortError(error)) {
        finishMode()
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'aborted',
          endReason: 'aborted',
          metadata: { runResponseCount: runResponseIds.size, runUsageIncomplete },
          assistantMessageId: lastPersistedAssistantId,
          finalMessageId: modeParentId ?? lastPersistedAssistantId ?? assistantParentId,
          error: 'Run aborted',
        })
        ensureStarted()
        safeEmit({
          type: 'error',
          error: 'Run aborted',
          envelope: buildCancellationEnvelope(signal),
          terminal: true,
          lineageId,
        })
        return
      }

      // D2: an expired Yggdrasil session is `session_expired` with a "Sign in" action,
      // and nothing else — no forced navigation, no modal. D3 (free-tier exhaustion)
      // needs no special case at all: the provider attaches `free_tier_exhausted`, the
      // classifier honours it, and it flows down this same path into a bubble.
      const requiresReauthentication = error instanceof RailwayAppAuthError
      let envelope = this.classifyRunError(error, {
        provider: request.provider,
        modelName: request.modelName,
        phase,
      })
      if (requiresReauthentication && envelope.code !== 'session_expired') {
        envelope = buildChatErrorEnvelope('session_expired', {
          detail: envelope.detail ?? errorMessage,
          provider: envelope.provider ?? request.provider,
          status: envelope.status ?? 401,
          action: { kind: 'sign_in', label: 'Sign in' },
        })
      }

      ensureStarted()

      // D1 / R1(c): keep whatever the loop persisted (never overwritten, never
      // discarded) and add the failure as its own assistant row, parented onto that
      // partial so `user -> partial -> error` is the tree shape and the user keeps the
      // words AND gets the explanation. Only possible once the user message and the
      // lineage exist — before that there is nothing to parent it to, and `runSink` is
      // still null, so `errorRow` stays null and the frame below advertises nothing.
      const errorRow = this.persistErrorAssistantMessage({
        sink: runSink,
        conversationId: request.conversationId,
        parentId: modeParentId ?? lastPersistedAssistantId ?? assistantParentId,
        modelName: request.modelName,
        envelope,
        lineageId,
        emit: safeEmit,
      })

      finishMode()
      this.streamingRunRepo.finish(trackedStreamId, {
        status: 'error',
        endReason: 'error',
        assistantMessageId: lastPersistedAssistantId ?? errorRow?.id ?? null,
        finalMessageId: modeParentId ?? errorRow?.id ?? lastPersistedAssistantId ?? null,
        error: errorMessage,
        metadata: {
          runResponseCount: runResponseIds.size,
          runUsageIncomplete,
          errorCode: envelope.code,
          recoverability: envelope.recoverability,
          provider: envelope.provider ?? null,
          status: envelope.status ?? null,
        },
      })
      safeAssign(error, 'lineageId', lineageId)
      if (requiresReauthentication) {
        // Non-terminal by itself; it exists so a client can react to the auth state.
        // `envelope` is what it shows — `message` stays raw for logs/back-compat.
        safeEmit({ type: 'reauth_required', message: errorMessage, envelope })
      }
      // R2 — ONE BUBBLE PER FAILURE. `persistedErrorMessageId` is the tier-1/tier-2
      // discriminator: PRESENT means this failure is already durable message content
      // (the row above), so the renderer must NOT also create a `ChatErrorRecord`;
      // ABSENT means the server had nothing to attach it to and the renderer owns the
      // only surface. It is spread in rather than set to `null` so "the server persisted
      // nothing" is a missing key, never an ambiguous null.
      safeEmit({
        type: 'error',
        error: errorMessage,
        envelope,
        terminal: true,
        lineageId,
        ...(errorRow?.id ? { persistedErrorMessageId: errorRow.id as string } : {}),
      })

      // Rethrow so callers still log/propagate, but stamped so the route does not
      // publish a SECOND terminal frame over this one (the renderer keeps the last).
      if (error && typeof error === 'object') {
        throw markChatErrorPublished(error, envelope)
      }
      throw markChatErrorPublished(new Error(errorMessage), envelope)
    } finally {
      this.modeRuns.delete(trackedStreamId)
      // Drain any pending decisions + the per-stream session so a disconnected or
      // errored run never leaks a paused promise. rejectAllForStream also clears the session.
      if (this.decisionBroker && trackedStreamId) this.decisionBroker.rejectAllForStream(trackedStreamId)
    }
  }
}
