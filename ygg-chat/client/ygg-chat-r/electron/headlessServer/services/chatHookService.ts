/**
 * chatHookService — server-side port of the renderer's chat-hook contract
 * (src/features/chats/chatActions.ts + chatHookClient.ts) for the headless loop.
 *
 * Phase 3: the server-owned loop fires the same 5 lifecycle hooks the renderer
 * fires today (UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop)
 * by calling `runHookRequest` in-process. The pure builders below are verbatim
 * ports of the renderer functions; the only difference is the message source —
 * a server ConversationRepo (SQLite) instead of the RQ cache / Redux state.
 *
 * All new behavior is opt-in: the ChatOrchestrator builds a session only when a
 * hookRunner is wired AND the request set `hooksEnabled`. Subagents and the mobile
 * LAN UI never enable it, so their loop is byte-for-byte unchanged.
 *
 * NOTE (intentional scope, see Phase 3 risks): memory-context injection
 * (long-term/recent/project memory) that the renderer folds via the same
 * buildSystemPromptWithHookContext is NOT ported here — it is a separate feature,
 * orthogonal to hooks. Only hook context is folded server-side.
 */
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import type {
  HookEventName,
  HookProjectContext,
  HookRunRequest,
  HookRunResult,
  HookTurnContext,
} from '../../hooks/hookTypes.js'
import { attachChatErrorCode } from '../providers/providerErrorFormatter.js'
import type { ToolExecutionContext, ToolLoopHooks } from './toolLoopService.js'
import { toToolResultContent } from './toolLoopService.js'

// ── Pure builders (direct ports of chatActions.ts) ──────────────────────────

/** Port of chatActions.ts appendHookAdditionalContext (:1139-1144). */
export function appendHookAdditionalContext(target: string[], value: string | null | undefined): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  target.push(trimmed)
}

/** Port of chatActions.ts getAssistantMessageTextForHook (:1232-1241). */
export function getAssistantMessageTextForHook(message: any): string {
  if (!message) return ''
  if (typeof message.content_plain_text === 'string' && message.content_plain_text.trim()) {
    return message.content_plain_text
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content
  }
  return ''
}

/**
 * Port of chatActions.ts buildSystemPromptWithHookContext (:1187-1222), WITHOUT the
 * memory-context params (see file header). Base first, one `[Hook context]` block per
 * accumulated entry last, joined by blank lines.
 */
export function buildSystemPromptWithHookContext(
  baseSystemPrompt: string | null | undefined,
  hookContext: string[]
): string {
  const segments = [typeof baseSystemPrompt === 'string' ? baseSystemPrompt.trim() : ''].filter(Boolean)
  const hookContextBlocks = hookContext
    .map(context => context.trim())
    .filter(Boolean)
    .map(context => `[Hook context]\n${context}`)
  if (hookContextBlocks.length > 0) {
    segments.push(hookContextBlocks.join('\n\n'))
  }
  return segments.join('\n\n')
}

export interface ChatHookMessageLike {
  id: string | number
  parent_id?: string | number | null
}

export interface ChatHookLineage {
  rootMessageId: string | null
  ancestorIds: string[]
  depth: number
  isRoot: boolean
}

/** Verbatim port of chatActions.ts buildHookLineage (:1267-1309). Fully pure. */
export function buildHookLineage(params: {
  messages: ChatHookMessageLike[]
  messageId?: string | number | null
  parentId?: string | number | null
}): ChatHookLineage {
  const messageId = params.messageId != null ? String(params.messageId) : null
  const explicitParentId = params.parentId != null ? String(params.parentId) : null
  const messageById = new Map(params.messages.map(message => [String(message.id), message]))

  const ancestorIds: string[] = []
  const visited = new Set<string>()

  let cursorId: string | null = null
  let isPersistedMessage = false

  if (messageId && messageById.has(messageId)) {
    cursorId = messageId
    isPersistedMessage = true
  } else if (explicitParentId) {
    cursorId = explicitParentId
  }

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId)
    const message = messageById.get(cursorId)
    if (!message) break
    ancestorIds.push(String(message.id))
    cursorId = message.parent_id != null ? String(message.parent_id) : null
  }

  ancestorIds.reverse()

  const rootMessageId = ancestorIds.length > 0 ? ancestorIds[0] : null
  const isRoot = isPersistedMessage ? ancestorIds.length === 1 : explicitParentId == null
  const depth = isPersistedMessage ? Math.max(ancestorIds.length - 1, 0) : ancestorIds.length

  return { rootMessageId, ancestorIds, depth, isRoot }
}

export interface ConversationRepoLike {
  listMessages(conversationId: string): any[]
  getMessageById(messageId: string): any
}

export interface ChatHookMetadata {
  conversationId: string | null
  messageId: string | null
  parentId: string | null
  lineage: ChatHookLineage
  lookup: { localApiBase: string | null }
  turn?: HookTurnContext
  project?: HookProjectContext
}

/**
 * Port of chatActions.ts buildHookMetadata (:1311-1347). The renderer sources
 * messages from the RQ cache / Redux; the server sources them from
 * ConversationRepo.listMessages (all rows for the conversation, created_at ASC) —
 * the full id->message map the lineage walk needs.
 */
export function buildHookMetadata(params: {
  conversationRepo: ConversationRepoLike
  conversationId: string | null
  messageId?: string | null
  parentId?: string | null
  turn?: HookTurnContext | null
  project?: HookProjectContext | null
  localApiBase?: string | null
}): ChatHookMetadata {
  const conversationId = params.conversationId != null ? String(params.conversationId) : null
  const messageId = params.messageId != null ? String(params.messageId) : null
  let parentId = params.parentId != null ? String(params.parentId) : null
  const messages = conversationId ? params.conversationRepo.listMessages(conversationId) : []

  if (messageId && parentId == null) {
    const currentMessage = messages.find((message: any) => String(message.id) === messageId)
    if (currentMessage?.parent_id != null) {
      parentId = String(currentMessage.parent_id)
    }
  }

  return {
    conversationId,
    messageId,
    parentId,
    lineage: buildHookLineage({ messages, messageId, parentId }),
    lookup: { localApiBase: params.localApiBase ?? null },
    turn: params.turn ?? undefined,
    project: params.project ?? undefined,
  }
}

// ── Hook failure visibility ─────────────────────────────────────────────────

/**
 * A hook failure is NON-terminal: a broken hook must never kill a chat. But it must
 * also never be silent — before this, `HookRunResult.errors` was written by the runner
 * and read by nobody, so "your hooks are broken" and "you have no hooks" were the same
 * observable state. Every failure now surfaces as a `notice` frame the UI can render
 * inline while the run keeps going.
 *
 * The lifecycle point is the only hook identity the runner currently reports (its
 * `errors` are bare strings with no command/source attached), so it is what the message
 * names. See the cross-file note on hookRunner.ts for the structured-failure upgrade.
 */
const HOOK_LIFECYCLE_PHRASE: Record<HookEventName, string> = {
  UserPromptSubmit: 'before your message was sent',
  PreToolUse: 'before a tool ran',
  PostToolUse: 'after a tool ran',
  PostToolUseFailure: 'after a tool failed',
  Stop: 'when the reply finished',
}

/**
 * Cap on a single accumulated `[Hook context]` block. A hook that prints non-JSON and
 * exits 0 has its ENTIRE stdout interpreted as `additionalContext` by the runner, so an
 * accidental `set -x`, a stack trace, or a `cat` of a large file would otherwise be
 * folded verbatim into the system prompt of every subsequent turn.
 */
const MAX_HOOK_CONTEXT_CHARS = 8_000

const TRUNCATION_MARKER = '\n…[hook output truncated]'

function describeHookFailure(event: HookEventName, failureCount: number): string {
  const when = HOOK_LIFECYCLE_PHRASE[event] ?? `at the ${event} lifecycle point`
  const subject =
    failureCount > 1 ? `${failureCount} of your ${event} hooks failed` : `Your ${event} hook failed`
  return `${subject} to run ${when}. The chat continued without it — check your hook configuration.`
}

function describeHookOutputTruncation(event: HookEventName): string {
  const when = HOOK_LIFECYCLE_PHRASE[event] ?? `at the ${event} lifecycle point`
  return `Your ${event} hook printed more output than can be used as context ${when}, so it was truncated. A hook should print JSON, or nothing.`
}

/**
 * UserPromptSubmit block. The hook's own `reason` is authored by the user's own
 * configuration and is written to be read, so it is the one raw string allowed to
 * become `userMessage`; everything else falls back to prose. `Error.message` keeps its
 * previous value so existing callers/logs are unchanged.
 *
 * NOTE: this only classifies the failure. Per decision D1 the typed prompt must still
 * be persisted — that reordering lives in chatOrchestrator.ts (see the report).
 */
export function createUserPromptBlockedError(reason?: string | null): Error {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  const error = new Error(trimmed || 'Blocked by hook')
  return attachChatErrorCode(error, 'tool_blocked_by_policy', {
    userMessage: trimmed || 'A hook blocked this message before it was sent.',
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Check hooks' },
  })
}

/**
 * PreToolUse `permissionDecision: 'deny'`. Deliberately `tool_denied` rather than
 * `hook_failed`: the hook did exactly what it was configured to do, which is a very
 * different thing to tell a user than "your hook crashed".
 */
export function createPreToolUseDenyError(
  result: Pick<HookRunResult, 'permissionDecisionReason' | 'reason'>
): Error {
  const trimmed = (result.permissionDecisionReason || result.reason || '').trim()
  const error = new Error(trimmed || 'Tool blocked by hook')
  return attachChatErrorCode(error, 'tool_denied', {
    userMessage: trimmed || 'A hook blocked this tool call.',
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Check hooks' },
  })
}

// ── Session (the wiring surface handed to the orchestrator + loop) ───────────

export type HookRunFn = (req: HookRunRequest) => Promise<HookRunResult>

export interface ChatHookSessionConfig {
  conversationRepo: ConversationRepoLike
  runHook: HookRunFn
  conversationId: string
  cwd: string | null
  provider: string | null
  model: string | null
  operation: string | null
  streamId: string | null
  project?: HookProjectContext | null
  localApiBase?: string | null
  /**
   * Stream sink. When wired, every hook failure surfaces as a non-terminal
   * `{type:'notice', code:'hook_failed'}` frame. Optional so subagents, the mobile LAN
   * path and existing tests keep working unchanged — they simply get no notices.
   */
  emit?: (event: HeadlessStreamEvent) => void
  /** Stamped onto emitted notices so the renderer can attribute them to a lineage. */
  lineageId?: string | null
}

export interface ChatHookSession {
  /** Shared accumulator: executor (Pre/Post/Failure) and loop (Stop) both push. */
  readonly hookContext: string[]
  /** Mutable — set to the final tracked stream id after StreamingRunRepo.upsert. */
  streamId: string | null
  /** UserPromptSubmit — returns the effective prompt; throws if a hook blocks. */
  runUserPromptSubmit(prompt: string, parentId: string | null): Promise<string>
  /** PreToolUse — returns the raw result so the executor can rewrite args / enforce deny. */
  runPreToolUse(toolCall: any, ctx: ToolExecutionContext): Promise<HookRunResult>
  /** PostToolUse — success path; folds additionalContext. */
  runPostToolUse(effectiveToolCall: any, result: any, ctx: ToolExecutionContext): Promise<void>
  /** PostToolUseFailure — error path; folds additionalContext (caller re-throws). */
  runPostToolUseFailure(effectiveToolCall: any, error: unknown, ctx: ToolExecutionContext): Promise<void>
  /** Adapter handed to ToolLoopService via input.hooks (Stop + per-turn fold). */
  toolLoopHooks(): ToolLoopHooks
}

export function createChatHookSession(config: ChatHookSessionConfig): ChatHookSession {
  const hookContext: string[] = []
  const project = config.project ?? null
  const localApiBase = config.localApiBase ?? null
  let streamId = config.streamId

  const emitNotice = (message: string): void => {
    if (!config.emit) return
    try {
      config.emit({
        type: 'notice',
        code: 'hook_failed',
        message,
        lineageId: config.lineageId ?? null,
      })
    } catch {
      // A dead stream sink must not turn a hook failure into a chat failure.
    }
  }

  /**
   * Raw failure text is diagnostic, never user-facing: a `notice` has no `detail`
   * field, so it goes to the server log while the user gets prose.
   */
  const reportHookFailures = (event: HookEventName, errors: string[]): void => {
    if (errors.length === 0) return
    console.warn(`[chatHookService] ${event} hook failure`, { event, conversationId: config.conversationId, errors })
    emitNotice(describeHookFailure(event, errors.length))
  }

  // Parity with the renderer chatHookClient swallow (:120-132): a hook-runner
  // failure never aborts the chat — surface it as a no-match result. The failure is no
  // longer silent though: both a discovery-level rejection and the per-hook failures
  // the runner collects into `errors` now emit a non-terminal notice.
  const safeRun = async (req: HookRunRequest): Promise<HookRunResult> => {
    try {
      const result = await config.runHook(req)
      reportHookFailures(req.event, Array.isArray(result.errors) ? result.errors : [])
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reportHookFailures(req.event, [message])
      return { matched: false, hookCount: 0, errors: [message] }
    }
  }

  /**
   * Guarded fold of a hook's `additionalContext` into the shared accumulator. Enforces
   * MAX_HOOK_CONTEXT_CHARS so a hook that dumps its stdout cannot silently take over
   * the system prompt for the rest of the run.
   */
  const foldAdditionalContext = (event: HookEventName, value: string | null | undefined): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.length <= MAX_HOOK_CONTEXT_CHARS) {
      appendHookAdditionalContext(hookContext, trimmed)
      return
    }
    hookContext.push(`${trimmed.slice(0, MAX_HOOK_CONTEXT_CHARS).trimEnd()}${TRUNCATION_MARKER}`)
    console.warn(`[chatHookService] ${event} hook context truncated`, {
      event,
      conversationId: config.conversationId,
      length: trimmed.length,
      limit: MAX_HOOK_CONTEXT_CHARS,
    })
    emitNotice(describeHookOutputTruncation(event))
  }

  const metadataFor = (opts: {
    messageId?: string | null
    parentId?: string | null
    turn?: HookTurnContext | null
    includeProject?: boolean
  }): ChatHookMetadata =>
    buildHookMetadata({
      conversationRepo: config.conversationRepo,
      conversationId: config.conversationId,
      messageId: opts.messageId ?? null,
      parentId: opts.parentId ?? null,
      turn: opts.turn ?? null,
      // Renderer asymmetry (parity): only UserPromptSubmit + Stop carry project; the
      // tool hooks (Pre/Post/Failure) do not (chatActions.ts:2408-2413 / 2467-2473).
      project: opts.includeProject ? project : null,
      localApiBase,
    })

  const runUserPromptSubmit = async (prompt: string, parentId: string | null): Promise<string> => {
    const meta = metadataFor({ parentId, includeProject: true })
    const result = await safeRun({
      event: 'UserPromptSubmit',
      conversationId: meta.conversationId,
      streamId,
      cwd: config.cwd,
      provider: config.provider,
      model: config.model,
      operation: config.operation,
      prompt,
      messageId: meta.messageId,
      parentId: meta.parentId,
      lineage: meta.lineage,
      lookup: meta.lookup,
      project: meta.project,
    })
    foldAdditionalContext('UserPromptSubmit', result.additionalContext)
    if (result.blocked) {
      throw createUserPromptBlockedError(result.reason)
    }
    return typeof result.updatedPrompt === 'string' ? result.updatedPrompt : prompt
  }

  const runPreToolUse = async (toolCall: any, ctx: ToolExecutionContext): Promise<HookRunResult> => {
    const meta = metadataFor({ messageId: ctx.messageId ?? null })
    const result = await safeRun({
      event: 'PreToolUse',
      conversationId: meta.conversationId,
      streamId,
      cwd: ctx.rootPath ?? config.cwd,
      provider: config.provider,
      model: config.model,
      operation: config.operation,
      toolCall,
      messageId: meta.messageId,
      parentId: meta.parentId,
      lineage: meta.lineage,
      lookup: meta.lookup,
    })
    foldAdditionalContext('PreToolUse', result.additionalContext)
    return result
  }

  const runPostToolUse = async (effectiveToolCall: any, toolResult: any, ctx: ToolExecutionContext): Promise<void> => {
    const meta = metadataFor({ messageId: ctx.messageId ?? null })
    const result = await safeRun({
      event: 'PostToolUse',
      conversationId: meta.conversationId,
      streamId,
      cwd: ctx.rootPath ?? config.cwd,
      provider: config.provider,
      model: config.model,
      operation: config.operation,
      toolCall: effectiveToolCall,
      // Match the renderer's serialized persisted content (chatActions.ts:2474); the
      // hook payload JSON-stringifies this into `tool_result`.
      toolResult: toToolResultContent(toolResult),
      messageId: meta.messageId,
      parentId: meta.parentId,
      lineage: meta.lineage,
      lookup: meta.lookup,
    })
    foldAdditionalContext('PostToolUse', result.additionalContext)
  }

  const runPostToolUseFailure = async (effectiveToolCall: any, error: unknown, ctx: ToolExecutionContext): Promise<void> => {
    const meta = metadataFor({ messageId: ctx.messageId ?? null })
    const result = await safeRun({
      event: 'PostToolUseFailure',
      conversationId: meta.conversationId,
      streamId,
      cwd: ctx.rootPath ?? config.cwd,
      provider: config.provider,
      model: config.model,
      operation: config.operation,
      toolCall: effectiveToolCall,
      error: error instanceof Error ? error.message : String(error),
      messageId: meta.messageId,
      parentId: meta.parentId,
      lineage: meta.lineage,
      lookup: meta.lookup,
    })
    foldAdditionalContext('PostToolUseFailure', result.additionalContext)
  }

  // Port of chatActions.ts shouldContinueFromStopHook (:1396-1455). Returns true to
  // force one more turn; appends additionalContext (+ the reason on continue) to the
  // shared buffer so the loop folds it into the next turn's system prompt.
  const runStop = async (params: { assistantMessage: any; streamId: string | null }): Promise<boolean> => {
    const lastAssistantMessage = params.assistantMessage
    if (!lastAssistantMessage) return false
    const lastAssistantMessageId = lastAssistantMessage?.id != null ? String(lastAssistantMessage.id) : null
    const lastUserMessageId = lastAssistantMessage?.parent_id != null ? String(lastAssistantMessage.parent_id) : null
    const meta = metadataFor({
      messageId: lastAssistantMessageId,
      parentId: lastUserMessageId,
      turn: { lastUserMessageId, lastAssistantMessageId },
      includeProject: true,
    })
    const result = await safeRun({
      event: 'Stop',
      conversationId: meta.conversationId,
      streamId: params.streamId ?? streamId,
      cwd: config.cwd,
      provider: config.provider,
      model: config.model,
      operation: config.operation,
      lastAssistantMessage: getAssistantMessageTextForHook(lastAssistantMessage),
      messageId: meta.messageId,
      parentId: meta.parentId,
      lineage: meta.lineage,
      lookup: meta.lookup,
      turn: meta.turn,
      project: meta.project,
    })
    foldAdditionalContext('Stop', result.additionalContext)
    if (result.blocked) {
      foldAdditionalContext('Stop', result.reason || 'Hook requested continued execution.')
      return true
    }
    return false
  }

  const foldSystemPrompt = (baseSystemPrompt: string | null): string | null => {
    // No accumulated context => leave the base prompt (possibly null) untouched, so a
    // hooks-enabled run with no hook output is identical to the non-hooks path.
    if (hookContext.length === 0) return baseSystemPrompt ?? null
    return buildSystemPromptWithHookContext(baseSystemPrompt, hookContext)
  }

  return {
    hookContext,
    get streamId(): string | null {
      return streamId
    },
    set streamId(value: string | null) {
      streamId = value
    },
    runUserPromptSubmit,
    runPreToolUse,
    runPostToolUse,
    runPostToolUseFailure,
    toolLoopHooks(): ToolLoopHooks {
      return { hookContext, foldSystemPrompt, runStop }
    },
  }
}
