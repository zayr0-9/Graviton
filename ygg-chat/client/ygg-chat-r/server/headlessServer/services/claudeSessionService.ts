import { portableSummaryText } from '../../../../../shared/summaryHandoff.js'
import { applyClaudeTaskEvent, CLAUDE_FILE_EDIT_TOOLS, CLAUDE_NATIVE_HOOK_SOURCE, claudeFilePatch, claudeMessageMetadata, type ClaudeBackgroundTask } from '../../../../../shared/claudeProvider.js'
import { LABEL_AUTO_MEMORY, LABEL_LOCAL, LABEL_PROJECT, LABEL_USER_GLOBAL } from '../../../../../shared/contextInjection.js'
import { parseFrontmatter, stripHtmlComments } from '../../context/frontmatter.js'
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { claudeProcessEnvironment, resolveClaudeExecutable } from './claudeProcessConfig.js'
import type { HookInput, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HeadlessBackgroundTask, HeadlessBackgroundTaskOutput, HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { ClaudeSessionRepo } from '../persistence/claudeSessionRepo.js'
import type { MessageRepo } from '../persistence/messageRepo.js'
import type { MessageSink } from './messageSink.js'
import { OperationModeControl } from './operationModeControl.js'
import type { OperationMode } from '../../../../../shared/operationModeToolPolicy.js'
import type { DecisionBroker, OperationModeUpgradeDecision, PermissionDecision } from './decisionBroker.js'
import type { ChatHookSession } from './chatHookService.js'
import type { ToolExecutionContext } from './toolLoopService.js'
import type { HookEventName, HookRunRecord, HookRunStatus, HookRunTracker } from '../../hooks/hookTypes.js'
import { getHookRunTracker } from '../../hooks/hookRunTracker.js'
import { redactHookDiagnostic, toSafeHookRunRecord } from '../../hooks/hookDiagnostics.js'

// Lazy import keeps the native CLI launcher out of renderer and ordinary provider startup.
export type ClaudeSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query' | 'forkSession' | 'getSessionMessages'>
const loadSdk = () => import('@anthropic-ai/claude-agent-sdk')
const textOf = (value: any): string => typeof value === 'string' ? value : JSON.stringify(value ?? '')
// Anthropic accepts only these formats, at most 5 MB each; the shared hydrator also admits bmp/avif.
const CLAUDE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024
export function claudeImageBlock(url: string) {
  const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
  if (!match || !CLAUDE_IMAGE_MIMES.has(match[1])) throw new Error('Claude accepts PNG, JPEG, GIF or WebP images only.')
  const data = match[2].replace(/[\r\n]/g, '')
  if (Buffer.byteLength(data, 'base64') > MAX_CLAUDE_IMAGE_BYTES) throw new Error('Claude accepts images up to 5 MB each.')
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data } }
}
// Native plans share plan_md's storage so they are listable/displayable from Graviton.
export const CLAUDE_PLANS_DIRECTORY = path.join('.ygg', 'plans')
const PLAN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const MAX_PLAN_BYTES = 1024 * 1024
// How long a tool hook waits for its tool_use envelope before recording against the current head.
const OWNER_WAIT_MS = 2000
// Chat mode matches Graviton's: a normal conversation with file edits blocked, not native plan mode.
// The tools stay in Claude's tool list (a PreToolUse hook denies them) so that switching modes keeps
// the prompt cache: removing tools changes the prefix and re-bills the whole transcript.
export const CHAT_MODE_BLOCKED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'EnterPlanMode']
// Rides on the user message, after the cached prefix, so it costs no cache either.
export const CHAT_MODE_NOTE = '(Graviton Chat mode for this message: file edits are disabled, including through Bash. Answer, read and run read-only commands; the user can switch to Agent mode for changes.)'
const CHAT_MODE_EDIT_DENIAL = 'File edits need Agent mode. Ask the user to switch to Agent mode in Graviton.'
/** What Claude reads when the user switches mode during a run, as a queued message. */
export function claudeModeSwitchNotice(mode: OperationMode): string {
  return mode === 'plan'
    ? '(Graviton switched to Chat mode: file edits are now disabled, including through Bash. Answer, read and run read-only commands; the user can switch back to Agent mode for changes.)'
    : '(Graviton switched to Agent mode: file edits are enabled again.)'
}
/** A mode switch Claude read at this point of the run, recorded as a mode row. */
export interface ClaudeModeSwitch { mode: OperationMode; previousMode: OperationMode; revision: number; content: string }
// Claude Code's own settings layers, as the CLI loads them: skills, hooks, plugins and CLAUDE.md.
export const CLAUDE_SETTING_SOURCES: NonNullable<Options['settingSources']> = ['user', 'project', 'local']
const COMMAND_LOOKUP_TIMEOUT_MS = 15_000
// Hook events whose `hook_name` matcher is a tool name (`PreToolUse:Bash`).
const NATIVE_TOOL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const SKILL_BASE_DIRECTORY = /^Base directory for this skill: ([^\n]+)/
const INSTRUCTION_LABELS: Record<string, string> = { User: LABEL_USER_GLOBAL, Project: LABEL_PROJECT, Local: LABEL_LOCAL, Managed: 'managed policy instructions' }
// After a turn ends, Claude starts a held queued message at once; a longer silence means it never will.
const QUEUED_START_TIMEOUT_MS = 30_000
// A finished background task's notification starts a turn within milliseconds; past this, none is coming.
const TASK_TURN_START_TIMEOUT_MS = 10_000
// Workflow progress arrives per agent state change; its row is rewritten at most this often.
const TASK_PROGRESS_FLUSH_MS = 1_000

/**
 * The run's Graviton mailbox (MessageInputQueue), as a running Claude session consumes it.
 * Entries stay `queued`, and so cancellable, until Claude reports `command_lifecycle: started`:
 * Claude folds them in at its next tool boundary, or runs them as a new turn after `result`.
 */
export interface ClaudeQueuedInput {
  /** Calls `wake` when an entry is enqueued; returns the unsubscribe. */
  subscribe(wake: () => void): () => void
  /** The next entry not yet offered, as Claude prompt text and image data URLs; null when none. */
  prepareNext(): Promise<{ requestId: string; prompt: string; images: string[] } | null>
  /**
   * Claude started the entry: persist its user row below `parentId` and return it. The row records
   * `mode`; a `modeSwitch` the entry carried is persisted as a mode row above it.
   */
  deliver(requestId: string, parentId: string | null, mode: { mode: OperationMode; modeSwitch: ClaudeModeSwitch | null }): any
  /** Claude read a standalone mode notice: persist its mode row below `parentId` and return it. */
  recordModeSwitch(modeSwitch: ClaudeModeSwitch, parentId: string | null): any
  /** Claude will never run the entry. */
  release(requestId: string, outcome: { cancelled: true } | { error: string }): void
  /** True when nothing is queued; closes intake so a later send starts a successor run. */
  tryClose(): boolean
  /** Lets DELETE withdraw an entry: true cancelled, false Claude already has it, null not offered. */
  bindCancel(cancel: (requestId: string) => Promise<boolean | null>): void
}
type QueryWithAsyncCancel = { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }
// In the 0.3.309 runtime, not its .d.ts.
type QueryWithTaskOutput = { getTaskOutput?: (taskId: string) => Promise<{ output?: string; total_bytes?: number; truncated?: boolean }> }

/** The run's live background tasks, for the user to stop one or read its output. */
export interface ClaudeTaskControl {
  /** False when the task is not one of this run's live tasks. */
  stop(taskId: string): Promise<boolean>
  /** The end of a shell or Monitor task's output; null when this CLI cannot read it or the task is unknown. */
  output(taskId: string): Promise<HeadlessBackgroundTaskOutput | null>
}

/** An instruction file Claude Code loaded, as the model reads it (no frontmatter or HTML comments). */
async function readInstructionFile(file: string): Promise<string | null> {
  try {
    return stripHtmlComments(parseFrontmatter(await readFile(file, 'utf8')).body).trim() || null
  } catch {
    return null
  }
}

type NativeHookMessage = {
  hook_id: string; hook_name: string; hook_event: string
  stdout?: string; stderr?: string; output?: string; exit_code?: number; outcome?: 'success' | 'error' | 'cancelled'
}

/** The line worth showing from a native hook's JSON stdout: its message, block or deny reason. */
function nativeHookSummary(stdout: string | undefined): string | null {
  const trimmed = stdout?.trim()
  if (!trimmed?.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    const specific = parsed?.hookSpecificOutput ?? {}
    const summary = [parsed?.systemMessage, parsed?.reason, parsed?.stopReason, specific.permissionDecisionReason]
      .find(value => typeof value === 'string' && value.trim())
    return summary ? summary.trim() : null
  } catch {
    return null
  }
}

/**
 * Records the hooks Claude Code runs itself (from its settings and plugins) as Graviton hook
 * runs, so they persist and draw on the transcript like Graviton's own. Graviton's SDK
 * callback hooks never produce these events, so nothing is recorded twice.
 */
function nativeHookRecorder(config: {
  tracker: HookRunTracker | null; conversationId: string; streamId: string | null; cwd: string; lineageId: string
  emit: (event: HeadlessStreamEvent) => void
  /** The row a hook belongs to: its tool call's row for tool events, else the current head. */
  ownerOf: (event: string, matcher: string | null) => string | null
}) {
  const runs = new Map<string, { record: HookRunRecord; startedMs: number }>()
  const store = (record: HookRunRecord, create: boolean): HookRunRecord => {
    try {
      const stored = create ? config.tracker?.create(record) : config.tracker?.update(record.id, record)
      return stored ?? record
    } catch (error) {
      console.warn('[ClaudeSession] could not record native hook run', error instanceof Error ? error.message : error)
      return record
    }
  }
  const publish = (record: HookRunRecord) => {
    if (!record.messageId) return
    try {
      config.emit({ type: 'hook_activity', event: record.event, messageId: record.messageId,
        runs: [toSafeHookRunRecord(record)], lineageId: config.lineageId })
    } catch { /* operational metadata must not break chat */ }
  }
  const update = (id: string, change: Partial<HookRunRecord>) => {
    const run = runs.get(id)
    if (!run) return
    run.record = store({ ...run.record, ...change, updatedAt: new Date().toISOString() }, false)
    publish(run.record)
  }
  return {
    started(message: NativeHookMessage) {
      if (runs.has(message.hook_id)) return
      const now = new Date().toISOString()
      const separator = message.hook_name.indexOf(':')
      const matcher = separator >= 0 ? message.hook_name.slice(separator + 1) : null
      const record = store({
        id: message.hook_id, conversationId: config.conversationId, streamId: config.streamId,
        event: message.hook_event as HookEventName, messageId: config.ownerOf(message.hook_event, matcher),
        label: message.hook_name, configuredCommand: '', executedCommand: null, sourceFile: CLAUDE_NATIVE_HOOK_SOURCE,
        // Claude reports no settings layer; the source marks it as Claude's.
        scope: 'project', executionMode: 'sync', status: 'running', outcomeCode: null, outcomeSummary: null,
        cwd: config.cwd, startedAt: now, completedAt: null, durationMs: null, errorSummary: null,
        stdoutPreview: null, stderrPreview: null, logPath: null, logFallback: false, createdAt: now, updatedAt: now,
      }, true)
      runs.set(message.hook_id, { record, startedMs: Date.now() })
      publish(record)
    },
    progress(message: NativeHookMessage) {
      update(message.hook_id, { stdoutPreview: redactHookDiagnostic(message.stdout || null), stderrPreview: redactHookDiagnostic(message.stderr || null) })
    },
    finished(message: NativeHookMessage) {
      if (!runs.has(message.hook_id)) this.started(message)
      const stdout = message.stdout ?? ''
      const stderr = message.stderr ?? ''
      // Exit 2 is Claude's blocking answer (deny the tool, stop the prompt): the hook did its job.
      const blocked = message.outcome === 'error' && message.exit_code === 2
      const status: HookRunStatus = message.outcome === 'success' || blocked ? 'succeeded' : message.outcome === 'cancelled' ? 'skipped' : 'failed'
      const failureText = stderr.trim() || message.output?.trim() || (message.exit_code != null ? `Hook exited with code ${message.exit_code}` : 'Hook failed')
      update(message.hook_id, {
        status, completedAt: new Date().toISOString(), durationMs: Date.now() - runs.get(message.hook_id)!.startedMs,
        outcomeCode: blocked ? 'blocked' : message.outcome === 'cancelled' ? 'cancelled'
          : message.outcome === 'error' ? (message.exit_code != null ? `exit_${message.exit_code}` : 'error') : 'completed',
        outcomeSummary: redactHookDiagnostic(nativeHookSummary(stdout) ?? (blocked ? stderr.trim() || null : null) ?? (status === 'succeeded' ? 'completed' : null), 1_000),
        errorSummary: status === 'failed' ? redactHookDiagnostic(failureText, 2_000) : null,
        stdoutPreview: redactHookDiagnostic(stdout || null), stderrPreview: redactHookDiagnostic(stderr || null),
      })
      runs.delete(message.hook_id)
    },
    /** Hooks still open when the stream ended never answered. */
    settle(interrupted: boolean) {
      for (const id of [...runs.keys()]) {
        update(id, { status: interrupted ? 'failed' : 'skipped', completedAt: new Date().toISOString(),
          outcomeCode: interrupted ? 'interrupted' : 'no_response',
          outcomeSummary: interrupted ? 'Run stopped before the hook finished' : 'Claude reported no result for this hook' })
        runs.delete(id)
      }
    },
  }
}

async function readPlanFile(plansDir: string, candidate: string): Promise<{ plan: string; planFilePath: string } | null> {
  try {
    const [root, filename] = await Promise.all([realpath(plansDir), realpath(path.resolve(plansDir, candidate))])
    const relative = path.relative(root, filename)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !filename.endsWith('.md')) return null
    const plan = await readFile(filename, 'utf8')
    return plan.trim() && Buffer.byteLength(plan) <= MAX_PLAN_BYTES ? { plan, planFilePath: filename } : null
  } catch {
    return null
  }
}

type ResumeEntry = { uuid: string | null; toolUseIds: string[]; toolResultIds: string[]; hasText: boolean }
function resumeEntry(uuid: string | null | undefined, role: string, content: unknown): ResumeEntry {
  const blocks: any[] = Array.isArray(content) ? content : []
  return { uuid: uuid ?? null,
    toolUseIds: role === 'assistant' ? blocks.filter(block => block?.type === 'tool_use').map(block => block.id) : [],
    toolResultIds: role === 'user' ? blocks.filter(block => block?.type === 'tool_result').map(block => block.tool_use_id) : [],
    hasText: role === 'assistant' && blocks.some(block => block?.type === 'text' && String(block.text ?? '').trim()) }
}
/** Latest native uuid in an interrupted turn where no tool_use awaits its result. A
 * thinking-only envelope is never a cut; a call without a result is dropped from context. */
export function safeResumePoint(entries: ResumeEntry[]): string | null {
  const pending = new Set<string>()
  let safe: string | null = null
  for (const entry of entries) {
    for (const id of entry.toolUseIds) pending.add(id)
    for (const id of entry.toolResultIds) pending.delete(id)
    if (entry.uuid && !pending.size && (entry.hasText || entry.toolResultIds.length)) safe = entry.uuid
  }
  return safe
}
const isToolResultTurn = (message: any) => Array.isArray(message?.content) && message.content.length > 0 &&
  message.content.every((block: any) => block?.type === 'tool_result')
/** Safe point for a head recorded at `headUuid`, bounded to that turn of the native chain.
 * Results of the head's own calls count even if Graviton stopped before projecting them. */
export function interruptedResumePoint(chain: Array<{ type: string; uuid: string; message: unknown; parent_tool_use_id?: string | null }>, headUuid: string): string | null {
  const main = chain.filter(entry => !entry.parent_tool_use_id)
  let end = main.findIndex(entry => entry.uuid === headUuid)
  if (end < 0) return null
  while (main[end + 1]?.type === 'user' && isToolResultTurn(main[end + 1].message)) end++
  let start = end
  while (start > 0 && !(main[start - 1].type === 'user' && !isToolResultTurn(main[start - 1].message))) start--
  return safeResumePoint(main.slice(start, end + 1).map(entry => resumeEntry(entry.uuid, entry.type, (entry.message as any)?.content)))
}

/** Claude Code's command-name grammar (CLI 2.1.314); any other `/word` input is sent to the model as prose. */
const CLAUDE_COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/

/**
 * The `/name args` command Claude Code would dispatch for this input, or null when it reads the
 * input as an ordinary prompt. As in the CLI, the first word after `/` must be a command name, so
 * a message that starts with a path (`/Users/me/plan.md …`) is prose, not a command.
 */
export function parseClaudeSlashCommand(content: string | null | undefined): { name: string; args: string } | null {
  const match = /^\s*\/(\S*)\s*([\s\S]*)$/.exec(content ?? '')
  return match && CLAUDE_COMMAND_NAME.test(match[1]) ? { name: match[1], args: match[2].trim() } : null
}

export class ClaudeSessionService {
  constructor(private deps: { sessions: ClaudeSessionRepo; messages: MessageRepo; broker?: DecisionBroker; sdk?: () => Promise<ClaudeSdk>; executable?: () => Promise<string>
    /** Durable store for native hook runs; defaults to the server's configured tracker. */
    hookRuns?: HookRunTracker | null }) {}

  /**
   * The Claude skill or custom command that `/name args` runs, or null when Claude has none by
   * that name or it is one of Claude's built-ins (/clear, /model…), which would desync the
   * branch. Asks a short-lived CLI that never gets a prompt, with hooks off so none run twice.
   */
  async nativeCommand(cwd: string, content: string): Promise<{ name: string; args: string; description: string } | null> {
    const invocation = parseClaudeSlashCommand(content)
    if (!invocation) return null
    const sdk = await (this.deps.sdk ?? loadSdk)()
    const executable = await (this.deps.executable ?? resolveClaudeExecutable)()
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    async function* idle(): AsyncGenerator<SDKUserMessage> { await released }
    const lookup = sdk.query({ prompt: idle(), options: { cwd, settingSources: CLAUDE_SETTING_SOURCES, strictMcpConfig: true, mcpServers: {},
      persistSession: false, pathToClaudeCodeExecutable: executable, env: claudeProcessEnvironment(), settings: { disableAllHooks: true } } })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const commands = await Promise.race([lookup.supportedCommands(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude did not list its commands in time')), COMMAND_LOOKUP_TIMEOUT_MS)
      })])
      // A name a built-in carries runs the built-in; an alias applies only when no command has the name.
      const named = commands.filter(command => command.name === invocation.name)
      const command = named.length ? (named.some(row => row.builtin) ? null : named[0])
        : commands.find(row => row.aliases?.includes(invocation.name)) ?? null
      if (!command || command.builtin) return null
      return { name: command.name, args: invocation.args, description: command.description?.trim() ?? '' }
    } finally {
      clearTimeout(timer)
      release()
      lookup.close()
    }
  }

  /** Host startup: no run survives a restart. Give each interrupted branch head a checkpoint
   * at its last safe native point so it can be continued (by fork). Call before admitting runs. */
  async recoverInterruptedBranches(): Promise<number> {
    const branches = this.deps.sessions.interruptedBranches()
    for (const branch of branches) this.deps.sessions.setState(branch.lineage_id, 'uncertain')
    if (!branches.length) return 0
    const sdk = await (this.deps.sdk ?? loadSdk)()
    let recovered = 0
    for (const branch of branches) {
      try {
        const head = branch.head_message_id ? this.deps.sessions.checkpoint(branch.head_message_id) : undefined
        if (head && !head.resumable) {
          const resumeUuid = interruptedResumePoint(await sdk.getSessionMessages(head.session_id, { dir: head.cwd }), head.message_uuid)
          if (resumeUuid) {
            this.deps.sessions.record(branch.head_message_id!, head.session_id, resumeUuid, head.cwd, true)
            recovered++
          }
        }
        this.deps.sessions.setState(branch.lineage_id, 'interrupted')
      } catch (error) {
        // Left 'uncertain': retried next startup.
        console.warn('[ClaudeSession] interrupted branch recovery skipped', branch.lineage_id, error instanceof Error ? error.message : error)
      }
    }
    return recovered
  }

  /**
   * Graviton's PreToolUse/PostToolUse/PostToolUseFailure hooks around native tools, plus
   * SessionStart after a native compaction. Matchers see Claude's tool names (Read, Bash, Edit…).
   * Hook context is handed straight back to Claude, the only place it can reach this session.
   */
  private chatHooks(session: ChatHookSession, scope: {
    active: (hook: HookInput, signal: AbortSignal) => boolean
    context: (toolUseId: string, signal: AbortSignal) => Promise<ToolExecutionContext>
  }): NonNullable<Options['hooks']> {
    const drained = () => session.drainHookContext().join('\n\n') || undefined
    return {
      PreToolUse: [{ hooks: [async (hook, _toolUseId, { signal }) => {
        if (hook.hook_event_name !== 'PreToolUse' || !scope.active(hook, signal)) return {}
        const result = await session.runPreToolUse({ id: hook.tool_use_id, name: hook.tool_name, arguments: hook.tool_input ?? {} },
          await scope.context(hook.tool_use_id, signal))
        const additionalContext = drained()
        // Graviton enforces only deny and rewrites. A rewrite stays behind the host approval
        // prompt ('ask'); never 'allow', which would skip it.
        const decision = result.permissionDecision === 'deny'
          ? { permissionDecision: 'deny' as const, permissionDecisionReason: result.permissionDecisionReason || 'Tool blocked by hook' }
          : result.updatedInput ? { permissionDecision: 'ask' as const, updatedInput: result.updatedInput } : {}
        if (!additionalContext && !Object.keys(decision).length) return {}
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision, ...(additionalContext ? { additionalContext } : {}) } }
      }] }],
      PostToolUse: [{ hooks: [async (hook, _toolUseId, { signal }) => {
        if (hook.hook_event_name !== 'PostToolUse' || !scope.active(hook, signal)) return {}
        await session.runPostToolUse({ id: hook.tool_use_id, name: hook.tool_name, arguments: hook.tool_input ?? {} },
          hook.tool_response, await scope.context(hook.tool_use_id, signal))
        const additionalContext = drained()
        return additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } } : {}
      }] }],
      PostToolUseFailure: [{ hooks: [async (hook, _toolUseId, { signal }) => {
        // Parity with the Graviton loop: no failure hook on cancellation.
        if (hook.hook_event_name !== 'PostToolUseFailure' || hook.is_interrupt || !scope.active(hook, signal)) return {}
        await session.runPostToolUseFailure({ id: hook.tool_use_id, name: hook.tool_name, arguments: hook.tool_input ?? {} },
          hook.error, await scope.context(hook.tool_use_id, signal))
        const additionalContext = drained()
        return additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext } } : {}
      }] }],
      // Startup context rides on the user message (orchestrator); only a compaction needs it here.
      SessionStart: [{ hooks: [async (hook, _toolUseId, { signal }) => {
        if (hook.hook_event_name !== 'SessionStart' || hook.source !== 'compact' || !scope.active(hook, signal)) return {}
        await session.runSessionStart('compact')
        const additionalContext = drained()
        return additionalContext ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } } : {}
      }] }],
    }
  }

  async run(input: {
    request: HeadlessMessageRequest; lineageId: string; userMessage: any; parentId: string | null
    sourceMessageId: string | null; fork: boolean; cwd: string; sink: MessageSink
    /** Extra conversation roots (`--add-dir`). Unlike cwd these may change between turns. */
    additionalDirectories?: string[]
    emit: (event: HeadlessStreamEvent) => void; signal?: AbortSignal
    /** This turn's images as data URLs; earlier images live in the native transcript. */
    images?: string[]
    /** Graviton chat hooks, bridged onto the native tool and compaction lifecycle. */
    hookSession?: ChatHookSession | null
    /** The prompt is a Claude skill or custom command `nativeCommand()` resolved; Claude expands it. */
    nativeCommand?: boolean
    /** Messages the user queues while this run is live. */
    queuedInput?: ClaudeQueuedInput
    /** The run's live Chat/Agent mode, shared with Graviton's mode route; a switch applies to the next tool call. */
    modeControl?: OperationModeControl
    /** Receives the run's background-task control once Claude starts; returns the unbind. */
    bindTasks?: (control: ClaudeTaskControl) => () => void
  }): Promise<any> {
    const { request, lineageId, emit, sink, signal, cwd } = input
    if (!request.manualCompaction && !input.nativeCommand && parseClaudeSlashCommand(request.content)) throw new Error('Native slash commands require an explicit Graviton command.')
    // Validate before reserving so a rejected image never leaves the branch running.
    const imageBlocks = request.manualCompaction ? [] : (input.images ?? []).map(claudeImageBlock)
    const sdk = await (this.deps.sdk ?? loadSdk)()
    const executable = await (this.deps.executable ?? resolveClaudeExecutable)()
    signal?.throwIfAborted()
    const stored = this.deps.sessions.branch(lineageId)
    let sessionId: string | undefined = stored?.session_id ?? undefined
    if (!input.fork && stored?.state === 'running') throw new Error('This Claude session is still running. Wait for it to finish or fork a completed response.')
    // An interrupted session's tail may be torn: never append to it, always fork at the checkpoint.
    const interrupted = stored?.state === 'uncertain' || stored?.state === 'interrupted'
    const sourceRow = input.sourceMessageId ? this.deps.messages.get(input.sourceMessageId) : null
    const sourceSummarySession = portableSummaryText(sourceRow) ? claudeMessageMetadata(sourceRow?.meta)?.claude?.sessionId : null
    if (sourceSummarySession) {
      if (input.fork || !sessionId || sessionId !== sourceSummarySession) throw new Error('Branch from this summary to start an independent session.')
      if (interrupted) throw new Error('Claude session was interrupted. Fork from a completed Claude message before continuing.')
      // A manual /compact ends at a summary, not an assistant response checkpoint.
    } else if (input.sourceMessageId) {
      const checkpoint = this.deps.sessions.checkpoint(input.sourceMessageId)
      if (!checkpoint?.resumable) throw new Error('This node is not a completed Claude checkpoint. Choose a completed Claude response to fork or continue.')
      if (checkpoint.cwd !== cwd) throw new Error('Claude branch workspace is locked. Start a new conversation to change it.')
      // Verify the exact source is still available. Never silently start over.
      const transcript = await sdk.getSessionMessages(checkpoint.session_id, { dir: cwd })
      // getSessionMessages projects only the compacted live chain. Native forkSession
      // can still resolve historical UUIDs in the persisted source and rejects missing cuts.
      if (input.fork || interrupted || !sessionId || sessionId !== checkpoint.session_id || transcript.at(-1)?.uuid !== checkpoint.message_uuid) {
        const fork = await sdk.forkSession(checkpoint.session_id, { dir: cwd, upToMessageId: checkpoint.message_uuid })
        sessionId = fork.sessionId
      }
    } else if (sessionId) {
      throw new Error('Claude session has no matching checkpoint. Start a new conversation.')
    }
    this.deps.sessions.reserve(lineageId, request.conversationId, request.modelName, cwd)
    let recordedSession: string | undefined
    let observedSession = false
    let activeSession = sessionId
    let parent = input.parentId
    let finalMessage: any = null
    let completed = false
    let turn = 0
    let streamedText = ''
    let streamedReasoning = ''
    const toolOwners = new Map<string, { message: any; blocks: any[]; calls: any[] }>()
    // Hook callbacks arrive on the control channel and can outrun the envelope that owns the tool_use.
    const ownerWaiters = new Map<string, Array<() => void>>()
    const apiResponses = new Map<string, { message: any; blocks: any[]; calls: any[]; content: string }>()
    let lastUuid: string | null = null
    // Native entries of this turn (since the last compaction), for an interrupted-run checkpoint.
    let turnEntries: ResumeEntry[] = []
    let currentApiId: string | null = null
    const abortController = new AbortController()
    const abort = () => abortController.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const promptUuid = randomUUID()
    let compactionActive = false
    let compactionSummary: any = null
    let hookFailure: unknown
    const pendingCompactions: Array<{ summary: string; trigger: 'manual' | 'auto' }> = []
    const commitCompaction = () => {
      const pending = pendingCompactions.shift()
      if (!pending) throw new Error('Claude compacted without supplying a PostCompact summary; update the host CLI or retry.')
      compactionSummary = sink.persistAssistantMessage({ conversationId: request.conversationId, parentId: parent,
        modelName: request.modelName, content: pending.summary,
        contentBlocks: [{ type: 'text', content: pending.summary, index: 0 }], statisticsKind: 'compaction_summary',
        meta: { kind: 'compaction_summary', state: 'committed', version: 1, trigger: pending.trigger,
          compactionId: randomUUID(), operationMode: control.mode, claude: { sessionId: activeSession, checkpoint: false } } })
      parent = compactionSummary.id
      finalMessage = null; lastUuid = null; turnEntries = []
      compactionActive = false
      streamedText = ''; streamedReasoning = ''; currentApiId = null
      compactionEvent('completed', compactionSummary)
      // Graviton's PreCompact (and an early SessionStart) ran before this row existed.
      hookSession?.attachPendingHookRuns(compactionSummary.id)
    }
    const compactionEvent = (status: 'started' | 'completed' | 'failed', summaryMessage?: any, error?: string) => {
      emit({ type: 'context_compaction', status, turn, reportedTokens: 0, projectedTokens: 0,
        effectiveTokens: 0, contextLength: 0, thresholdPercent: 0,
        ...(summaryMessage ? { summaryMessage, parentMessageId: summaryMessage.id } : {}), ...(error ? { error } : {}) })
    }
    const hookSession = input.hookSession ?? null
    const ownerMessageId = async (toolUseId: string, hookSignal: AbortSignal): Promise<string> => {
      if (!toolOwners.has(toolUseId) && !hookSignal.aborted) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); hookSignal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, OWNER_WAIT_MS)
          hookSignal.addEventListener('abort', done, { once: true })
          ownerWaiters.set(toolUseId, [...(ownerWaiters.get(toolUseId) ?? []), done])
        })
      }
      return String(toolOwners.get(toolUseId)?.message.id ?? finalMessage?.id ?? parent ?? '')
    }
    const nativeHooks = nativeHookRecorder({
      tracker: this.deps.hookRuns === undefined ? getHookRunTracker() : this.deps.hookRuns,
      conversationId: request.conversationId, streamId: request.streamId ?? null, cwd, lineageId, emit,
      ownerOf: (event, matcher) => {
        // Native hook events carry no tool_use_id: the latest call to that tool owns them.
        if (matcher && NATIVE_TOOL_HOOK_EVENTS.has(event)) {
          for (const [id, owner] of [...toolOwners.entries()].reverse()) {
            if (owner.calls.some(call => call.id === id && call.name === matcher)) return String(owner.message.id)
          }
        }
        const head = finalMessage?.id ?? parent
        return head == null ? null : String(head)
      },
    })
    // A Skill call answers "Launching skill: X"; Claude then adds the skill's instructions as a
    // synthetic user message. They are kept on the call's row as what the model read.
    let pendingSkill: { owner: { message: any; blocks: any[]; calls: any[] }; toolUseId: string; name: string } | null = null
    const attachSkillBody = (skill: NonNullable<typeof pendingSkill>, raw: string) => {
      const text = raw.trim()
      if (!text) return
      const directory = SKILL_BASE_DIRECTORY.exec(text)?.[1]?.trim()
      skill.owner.blocks.push({ type: 'context_injection', tool_use_id: skill.toolUseId, path: directory ? path.join(directory, 'SKILL.md') : '',
        label: `skill ${skill.name} instructions`, text, reason: 'skill', origin: 'claude', index: skill.owner.blocks.length })
      const updated = sink.updateAssistantToolState(skill.owner.message.id, { contentBlocks: skill.owner.blocks })
      if (updated) emit({ type: 'assistant_message_persisted', message: updated, lineageId })
    }
    // Instruction files Claude loaded itself (CLAUDE.md, rules, imports). The hook arrives on the
    // control channel, so loads wait here for the ordered row they belong to: a file a tool read
    // rides beside that tool's result, the rest on the next assistant row. Shown, never re-sent.
    let pendingInstructions: Array<{ trigger: string | null; block: any }> = []
    const shownInstructions = new Set<string>()
    const takeInstructions = (match: (trigger: string | null) => boolean) => {
      const taken = pendingInstructions.filter(entry => match(entry.trigger))
      pendingInstructions = pendingInstructions.filter(entry => !match(entry.trigger))
      return taken.map(entry => entry.block)
    }
    // A resumed or forked session reloads its startup files every turn; they showed when it started.
    const resumedSession = Boolean(sessionId)
    const hooks: NonNullable<Options['hooks']> = {
      InstructionsLoaded: [{ hooks: [async (hook, _toolId, context) => {
        if (hook.hook_event_name !== 'InstructionsLoaded' || hook.agent_id || context.signal.aborted || abortController.signal.aborted) return {}
        const trigger = hook.trigger_file_path ? path.resolve(cwd, hook.trigger_file_path) : null
        if (resumedSession && !trigger && (hook.load_reason === 'session_start' || hook.load_reason === 'include')) return {}
        const file = path.resolve(cwd, hook.file_path)
        if (shownInstructions.has(file)) return {}
        shownInstructions.add(file)
        const text = await readInstructionFile(file)
        if (!text) return {}
        const label = path.basename(file) === 'MEMORY.md' && path.basename(path.dirname(file)) === 'memory'
          ? LABEL_AUTO_MEMORY : INSTRUCTION_LABELS[hook.memory_type] ?? LABEL_PROJECT
        pendingInstructions.push({ trigger, block: { type: 'context_injection', path: file, label, text, reason: hook.load_reason, origin: 'claude' } })
        return {}
      }] }],
      // Not a main-thread signal: the CLI (2.1.318) sends a background agent's PreCompact with the
      // parent's session_id and transcript_path and no agent_id. The indicator follows the
      // main-only `status: compacting` stream event instead. PostCompact is main-only.
      PreCompact: [{ hooks: [async (hook, _toolId, context) => {
        if (context.signal.aborted || abortController.signal.aborted || hook.agent_id) return {}
        if (hook.hook_event_name === 'PreCompact' && hook.session_id === activeSession) {
          if (hookSession) {
            await hookSession.runPreCompact(hook.trigger)
            // Native compaction takes no hook context; do not let it leak into a later tool result.
            hookSession.drainHookContext()
          }
        }
        return {}
      }] }],
      PostCompact: [{ hooks: [async (hook, _toolId, context) => {
        if (context.signal.aborted || abortController.signal.aborted || hook.hook_event_name !== 'PostCompact' || hook.agent_id || hook.session_id !== activeSession) return {}
        try {
          if (!hook.compact_summary.trim()) throw new Error('Claude returned an empty compaction summary')
          // SDK hooks arrive on a control channel. Commit only when the ordered
          // iterator reaches compact_boundary, after all pre-compaction output.
          pendingCompactions.push({ summary: hook.compact_summary, trigger: hook.trigger })
        } catch (error) {
          hookFailure = error
          compactionActive = false
          compactionEvent('failed', undefined, error instanceof Error ? error.message : String(error))
          abortController.abort(error)
        }
        return {}
      }] }],
      ...(hookSession ? this.chatHooks(hookSession, {
        active: (hook, signal) => !hook.agent_id && !signal.aborted && !abortController.signal.aborted,
        context: async (toolUseId, signal) => ({
          conversationId: request.conversationId, messageId: await ownerMessageId(toolUseId, signal),
          streamId: request.streamId ?? null, rootPath: cwd, provider: request.provider, modelName: request.modelName, signal,
        }),
      }) : {}),
    }
    // Chat mode only blocks edit tools; ExitPlanMode asks the user to switch to Agent mode.
    // The mode can change mid-run (Graviton's mode route, or an accepted ExitPlanMode).
    const control = input.modeControl ?? new OperationModeControl(request.operationMode === 'plan' ? 'plan' : 'execute')
    // The mode Claude was last told (a queued message is on its way) and last read (it started one).
    let toldMode = control.mode
    let readMode = control.mode
    // Main-agent tool calls still waiting for a result. A message queued now joins the turn at their
    // boundary; with none running it would start a turn of its own after `result`.
    const toolsInFlight = new Set<string>()
    // A hook decision outranks Claude's allow rules, acceptEdits and the auto classifier, and reads
    // the mode live, so a switch applies to the next tool call. Applies to child agents too.
    // Hooks are not part of the prompt, so this costs no cache.
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { hooks: [async hook => {
      if (control.mode !== 'plan' || hook.hook_event_name !== 'PreToolUse' || !CHAT_MODE_BLOCKED_TOOLS.includes(hook.tool_name)) return {}
      const reason = hook.tool_name === 'EnterPlanMode'
        ? 'Graviton Chat mode does not use native plan mode. Describe the plan in your reply.'
        : CHAT_MODE_EDIT_DENIAL
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    }] }]
    const permissionMode = request.claudePermissionMode === 'auto' ? 'auto' : 'default'
    const plansDir = path.join(cwd, CLAUDE_PLANS_DIRECTORY)
    let lastPlanPath: string | null = null
    // The permission callback can race the assistant envelope that persists the tool_use block.
    const pendingPlans = new Map<string, { plan: string; planFilePath?: string }>()
    const attachPlan = (toolUseId: string, plan: { plan: string; planFilePath?: string }) => {
      const owner = toolOwners.get(toolUseId)
      if (!owner) { pendingPlans.set(toolUseId, plan); return }
      const block = owner.blocks.find(block => block.type === 'tool_use' && block.id === toolUseId)
      const call = owner.calls.find(call => call.id === toolUseId)
      if (block) block.input = { ...block.input, ...plan }
      if (call) call.arguments = { ...call.arguments, ...plan }
      const updated = sink.updateAssistantToolState(owner.message.id, { contentBlocks: owner.blocks })
      if (updated) emit({ type: 'assistant_message_persisted', message: updated, lineageId })
      if (call) emit({ type: 'chunk', part: 'tool_call', toolCall: call })
    }
    const resolvePlan = async (args: Record<string, unknown>) => {
      const named = typeof args.planFilePath === 'string' ? await readPlanFile(plansDir, args.planFilePath) : null
      const tracked = !named && lastPlanPath ? await readPlanFile(plansDir, lastPlanPath) : null
      const file = named ?? tracked
      if (typeof args.plan === 'string' && args.plan.trim()) return { plan: args.plan, ...(file ? { planFilePath: file.planFilePath } : {}) }
      return file
    }
    const canUseTool: NonNullable<Options['canUseTool']> = async (name, args, context) => {
      if (abortController.signal.aborted || context.signal.aborted) return { behavior: 'deny', message: 'Run stopped', interrupt: true }
      if (name === 'ExitPlanMode') {
        const id = context.toolUseID || randomUUID()
        const plan = await resolvePlan(args)
        if (plan) attachPlan(id, plan)
        if (control.mode === 'execute') return { behavior: 'allow', updatedInput: args }
        if (!this.deps.broker) return { behavior: 'deny', message: 'Switch to Agent mode in Graviton.' }
        const event = { type: 'operation_mode_upgrade_required' as const, streamId: request.streamId!, toolCallId: id,
          toolName: name, toolInput: { ...args, ...(plan ?? {}) } }
        const pending = this.deps.broker.requestDecision<OperationModeUpgradeDecision>({ streamId: request.streamId!, toolCallId: id,
          kind: 'operation_mode_upgrade', signal: context.signal, prompt: event })
        if (this.deps.broker.hasPending(request.streamId!, id)) emit(event)
        if (await pending !== 'switch_to_execute') {
          return { behavior: 'deny', message: 'The user chose to stay in Chat mode. Revise the plan or ask what to change.' }
        }
        // Through the shared control, so the queue's successor run and the composer see Agent mode too.
        // Claude learns from this tool result; a notice goes only if a message on its way says otherwise.
        control.change('execute', `upgrade:${id}`)
        readMode = 'execute'
        syncToldMode()
        return { behavior: 'allow', updatedInput: args, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] }
      }
      // AskUserQuestion requires an answer protocol beyond permission; do not turn Approve into an invented answer.
      if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'Ask the user in your text response instead.' }
      // Auto-approval answers permission requests; it must not let Chat mode edit files.
      // The PreToolUse hook denies these first; this guards a CLI that still asks.
      if (control.mode === 'plan' && CHAT_MODE_BLOCKED_TOOLS.includes(name)) {
        return { behavior: 'deny', message: CHAT_MODE_EDIT_DENIAL }
      }
      if (!this.deps.broker) return { behavior: 'deny', message: 'Approval UI unavailable' }
      const id = context.toolUseID || randomUUID()
      const event = { type: 'permission_required' as const, streamId: request.streamId!, toolCallId: id, toolName: name, toolInput: args }
      const pending = this.deps.broker.requestDecision<PermissionDecision>({ streamId: request.streamId!, toolCallId: id,
        kind: 'permission', signal: context.signal, prompt: event })
      if (this.deps.broker.hasPending(request.streamId!, id)) emit(event)
      if (await pending !== 'deny') return { behavior: 'allow', updatedInput: args }
      // A switch to Chat mode denies edit prompts that were still waiting.
      return { behavior: 'deny', message: control.mode === 'plan' && CHAT_MODE_BLOCKED_TOOLS.includes(name) ? CHAT_MODE_EDIT_DENIAL : 'Denied by user' }
    }
    // Thinking is never disabled: several Claude models reject it, so the composer offers no
    // Off and a stale think:false falls back to the selected effort or the native default.
    // Omitted settings keep the native default for older/non-composer callers.
    // Newer models default to display 'omitted' (signature-only, empty thinking text), so always
    // ask for summaries; without a thinking config the CLI flag sets only the display mode.
    const effort = request.reasoningConfig?.effort
    const selectedEffort = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' ? effort : undefined
    const options: Options = {
      cwd, model: request.modelName, ...(sessionId ? { resume: sessionId } : {}),
      ...(input.additionalDirectories?.length ? { additionalDirectories: input.additionalDirectories } : {}),
      abortController, includePartialMessages: true, permissionMode,
      // Claude's own settings load (skills, hooks, plugins, CLAUDE.md) as in the CLI; MCP stays off.
      canUseTool, permissionPrompts: 'host', settingSources: CLAUDE_SETTING_SOURCES, strictMcpConfig: true, mcpServers: {},
      // Hook lifecycle events become Graviton hook runs (`nativeHooks`).
      persistSession: true, hooks, includeHookEvents: true,
      // A one-line status for each running agent, about every 30s (task_progress `summary`). The CLI
      // forks the agent's conversation for it, reusing its model and prompt cache.
      agentProgressSummaries: true,
      ...(request.think === true || selectedEffort
        ? { thinking: { type: 'adaptive', display: 'summarized' } as const, ...(selectedEffort ? { effort: selectedEffort } : {}) }
        : { extraArgs: { 'thinking-display': 'summarized' } }),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Ultracode is session-scoped flag settings, so every run (each resume) restates it.
      settings: { plansDirectory: CLAUDE_PLANS_DIRECTORY, ...(request.claudeUltracode ? { ultracode: true } : {}) },
    }
    // Use the host's installed CLI rather than resolving a bundled native executable relative to an esbuild bundle.
    options.pathToClaudeCodeExecutable = executable
    options.env = claudeProcessEnvironment()
    const selectedFiles = (request.selectedFiles ?? []).map(file => `File: ${file.path}\n${file.contents}`).join('\n\n')
    const userPrompt = selectedFiles ? `${request.content}\n\nSelected file context:\n${selectedFiles}` : request.content
    // A native command's arguments are the rest of its text, so the note stays off commands.
    const prompt = request.manualCompaction ? '/compact'
      : control.mode === 'plan' && !input.nativeCommand ? `${userPrompt}\n\n${CHAT_MODE_NOTE}` : userPrompt
    // Input stays open while queued messages may still reach Claude; closing it ends the session.
    const outbox: SDKUserMessage[] = []
    let inputClosed = false
    let wakeInput = () => {}
    const finishInput = () => { inputClosed = true; wakeInput() }
    const releaseInput = () => finishInput()
    abortController.signal.addEventListener('abort', releaseInput, { once: true })
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      const content = imageBlocks.length ? [...imageBlocks, { type: 'text' as const, text: prompt }] : prompt
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: promptUuid,
        session_id: sessionId ?? '' }
      while (true) {
        const next = outbox.shift()
        if (next) { yield next; continue }
        if (inputClosed) return
        await new Promise<void>(resolve => { wakeInput = resolve })
      }
    }
    let query: ReturnType<ClaudeSdk['query']> | undefined
    const queued = input.queuedInput
    // Native command uuid → Graviton request id, for entries Claude holds but has not started.
    const offered = new Map<string, string>()
    // Graviton request id → native command uuid, for every entry sent to Claude.
    const sent = new Map<string, string>()
    // Native command uuid → the mode that message tells Claude, in the order they were sent.
    const offeredModes = new Map<string, { mode: OperationMode; revision: number }>()
    const offerMode = (uuid: string, mode: OperationMode) => {
      offeredModes.set(uuid, { mode, revision: control.revision })
      toldMode = mode
    }
    // What Claude will know once it reads everything on its way; a gap from the live mode is re-announced.
    const syncToldMode = () => {
      toldMode = [...offeredModes.values()].at(-1)?.mode ?? readMode
      if (toldMode !== control.mode) void pump()
    }
    let pumping = false
    let pumpAgain = false
    // The last turn ended; the session closes once nothing is left to start another one.
    let idle = false
    let startTimer: ReturnType<typeof setTimeout> | undefined
    // Non-ambient background tasks still running, child agents' included (the CLI's level signal).
    let liveTasks = 0
    let liveTaskList: HeadlessBackgroundTask[] = []
    // Latest progress of every running non-ambient task, child agents' included, for the composer's
    // task list. Separate from `tasks`, which holds only the main agent's tasks for their call rows.
    const liveProgress = new Map<string, ClaudeBackgroundTask>()
    let backgroundFlush: ReturnType<typeof setTimeout> | undefined
    const withProgress = (entry: HeadlessBackgroundTask): HeadlessBackgroundTask => {
      const task = liveProgress.get(entry.id)
      if (!task) return entry
      return { ...entry, ...(task.activity ? { activity: task.activity } : {}), ...(task.progress ? { progress: task.progress } : {}),
        ...(task.lastTool ? { lastTool: task.lastTool } : {}), ...(task.usage ? { usage: task.usage } : {}) }
    }
    // Published only while tasks exist, and once more when the last one ends.
    let publishedBackground = '[]'
    const publishBackground = () => {
      clearTimeout(backgroundFlush)
      backgroundFlush = undefined
      const list = liveTaskList.map(withProgress)
      const signature = list.length ? JSON.stringify([idle, list]) : '[]'
      if (signature === publishedBackground) return
      publishedBackground = signature
      emit({ type: 'background_tasks', streamId: request.streamId!, lineageId, turnActive: !idle, tasks: list })
    }
    const trackProgress = (event: { task_id: string; subtype: string; ambient?: boolean; skip_transcript?: boolean }) => {
      if (event.ambient || event.skip_transcript) return
      const task = applyClaudeTaskEvent(liveProgress.get(event.task_id), event)
      if (!task) return
      // The level signal drops an ended task from the list.
      if (task.status !== 'running') { liveProgress.delete(event.task_id); return }
      liveProgress.set(event.task_id, task)
      // Progress arrives per tool call: at most one publish a second, like the call-row writes.
      if (event.subtype === 'task_progress' && !backgroundFlush && liveTaskList.some(entry => entry.id === event.task_id)) {
        backgroundFlush = setTimeout(publishBackground, TASK_PROGRESS_FLUSH_MS)
      }
    }
    let initSeen = false
    // Tasks the main agent launched → whether they ended. Claude answers each end with a turn of its own.
    const unansweredTasks = new Map<string, boolean>()
    const settleIdle = () => {
      if (!idle || pumping || inputClosed) return
      clearTimeout(startTimer)
      // Background work keeps the session, and so the queue, open: a message sent meanwhile reaches
      // Claude at once instead of waiting for the run to end. The task's end starts the next turn.
      if (liveTasks || [...unansweredTasks.values()].some(ended => !ended)) return
      if (unansweredTasks.size) {
        startTimer = setTimeout(() => { unansweredTasks.clear(); settleIdle() }, TASK_TURN_START_TIMEOUT_MS)
        return
      }
      if (!queued) { finishInput(); return }
      if (queued.tryClose()) { finishInput(); return }
      if (offered.size) startTimer = setTimeout(() => {
        for (const requestId of offered.values()) queued.release(requestId, { error: 'Claude did not start this message. Send it again.' })
        offered.clear()
        finishInput()
      }, QUEUED_START_TIMEOUT_MS)
    }
    // A new turn after `result`: a queued message, or Claude answering a finished background task.
    const turnStarted = () => {
      if (!idle) return
      idle = false
      clearTimeout(startTimer)
      for (const [id, ended] of unansweredTasks) if (ended) unansweredTasks.delete(id)
      publishBackground()
    }
    // Background tasks the main agent launched, shown on the tool_result of the call that launched
    // them. Child agents' own tasks stay in Claude's transcript, like the rest of their detail.
    const tasks = new Map<string, { toolUseId: string; task: ClaudeBackgroundTask }>()
    const dirtyTasks = new Set<string>()
    let taskFlush: ReturnType<typeof setTimeout> | undefined
    const taskForCall = (toolUseId: string) => [...tasks.values()].find(entry => entry.toolUseId === toolUseId)?.task
    const writeTasks = () => {
      clearTimeout(taskFlush)
      taskFlush = undefined
      const owners = new Set<{ message: any; blocks: any[]; calls: any[] }>()
      for (const id of dirtyTasks) {
        const entry = tasks.get(id)!
        const owner = toolOwners.get(entry.toolUseId)
        // task_started can precede the call's tool_result; the result block picks the task up then.
        const result = owner?.blocks.find(block => block.type === 'tool_result' && block.tool_use_id === entry.toolUseId)
        if (!owner || !result) continue
        result.task = entry.task
        owners.add(owner)
        dirtyTasks.delete(id)
      }
      for (const owner of owners) {
        const updated = sink.updateAssistantToolState(owner.message.id, { contentBlocks: owner.blocks })
        if (updated) emit({ type: 'assistant_message_persisted', message: updated, lineageId })
      }
    }
    const trackTask = (event: { task_id: string; subtype: string; tool_use_id?: string; ambient?: boolean; skip_transcript?: boolean }) => {
      const toolUseId = event.tool_use_id ?? tasks.get(event.task_id)?.toolUseId
      if (!toolUseId || !toolOwners.has(toolUseId) || event.ambient || event.skip_transcript) return
      const task = applyClaudeTaskEvent(tasks.get(event.task_id)?.task, event)
      if (!task) return
      tasks.set(event.task_id, { toolUseId, task })
      // The level signal can name a task before its task_started does.
      if (liveTaskList.some(entry => entry.id === event.task_id && entry.toolUseId !== toolUseId)) {
        liveTaskList = liveTaskList.map(entry => entry.id === event.task_id ? { ...entry, toolUseId } : entry)
        publishBackground()
      }
      if (event.subtype === 'task_started') unansweredTasks.set(event.task_id, false)
      else if (task.status !== 'running' && unansweredTasks.has(event.task_id)) unansweredTasks.set(event.task_id, true)
      dirtyTasks.add(event.task_id)
      if (event.subtype !== 'task_progress') writeTasks()
      else if (!taskFlush) taskFlush = setTimeout(writeTasks, TASK_PROGRESS_FLUSH_MS)
      if (task.status !== 'running') settleIdle()
    }
    const pump = async () => {
      if (!queued || inputClosed) return
      if (pumping) { pumpAgain = true; return }
      pumping = true
      try {
        do {
          pumpAgain = false
          for (let next = await queued.prepareNext(); next && !inputClosed; next = await queued.prepareNext()) {
            // The message carries the mode Claude applies from here: a switch it has not been told
            // about, or the note every Chat-mode message gets.
            const mode = control.mode
            const note = mode !== toldMode ? claudeModeSwitchNotice(mode) : mode === 'plan' ? CHAT_MODE_NOTE : ''
            const text = note ? `${next.prompt}\n\n${note}` : next.prompt
            let content: SDKUserMessage['message']['content']
            try {
              const images = next.images.map(claudeImageBlock)
              content = images.length ? [...images, { type: 'text' as const, text }] : text
            } catch (error) {
              queued.release(next.requestId, { error: error instanceof Error ? error.message : String(error) })
              continue
            }
            const uuid = randomUUID()
            offered.set(uuid, next.requestId)
            sent.set(next.requestId, uuid)
            offerMode(uuid, mode)
            // 'next' joins the running turn at its next tool boundary, or starts a turn after `result`.
            outbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid,
              session_id: activeSession ?? '', priority: 'next' })
            wakeInput()
          }
          // A switch with no queued message to carry it goes alone, but only while a tool runs: it then
          // joins that tool's boundary instead of starting a turn of its own after `result`. Otherwise
          // it waits for the next tool, the next queued message, or (failing both) the final row's mode.
          if (control.mode !== toldMode && toolsInFlight.size && !inputClosed) {
            const uuid = randomUUID()
            offerMode(uuid, control.mode)
            outbox.push({ type: 'user', message: { role: 'user', content: claudeModeSwitchNotice(control.mode) }, parent_tool_use_id: null,
              uuid, session_id: activeSession ?? '', priority: 'next' })
            wakeInput()
          }
        } while (pumpAgain && !inputClosed)
      } catch (error) {
        console.warn('[ClaudeSession] queued input stopped', error instanceof Error ? error.message : error)
      } finally {
        pumping = false
      }
      settleIdle()
    }
    queued?.bindCancel(async requestId => {
      const uuid = sent.get(requestId)
      if (!uuid) { queueMicrotask(settleIdle); return null }
      if (!offered.has(uuid)) return false
      const cancel = (query as unknown as QueryWithAsyncCancel | undefined)?.cancelAsyncMessage
      if (typeof cancel !== 'function' || !await cancel.call(query, uuid)) return false
      // The CLI's `cancelled` lifecycle frame can arrive before this answer and release it first.
      if (offered.delete(uuid)) {
        offeredModes.delete(uuid)
        queued.release(requestId, { cancelled: true })
        syncToldMode()
        settleIdle()
      }
      return true
    })
    const unsubscribeQueue = queued?.subscribe(() => { void pump() })
    // Each response records the mode it ran in. A switch Claude never read as a message (no tool step
    // left) still reaches the final row, where a mode row would displace the resumable checkpoint.
    const runMeta = () => ({ ...(this.deps.broker ? { toolAutoApprove: this.deps.broker.isAutoApproveAll(request.streamId!) } : {}),
      operationMode: control.mode })
    const persist = (content: string, blocks: any[], uuid?: string, partial = false) => {
      const row = sink.persistAssistantMessage({ conversationId: request.conversationId, parentId: parent,
        modelName: request.modelName, content, contentBlocks: blocks,
        meta: { operationMode: control.mode, claude: { sessionId: activeSession, messageUuid: uuid ?? null, checkpoint: false, partial } } })
      parent = row.id
      finalMessage = row
      if (uuid && activeSession) this.deps.sessions.record(row.id, activeSession, uuid, cwd, false)
      emit({ type: 'assistant_message_persisted', message: row, lineageId })
      return row
    }
    let unbindTasks: (() => void) | undefined
    try {
      signal?.throwIfAborted()
      query = sdk.query({ prompt: prompts(), options })
      unbindTasks = input.bindTasks?.({
        stop: async taskId => {
          if (!query || !liveTaskList.some(task => task.id === taskId)) return false
          // The CLI answers with a task_notification (stopped) and a new level signal.
          await query.stopTask(taskId)
          return true
        },
        output: async taskId => {
          const read = (query as unknown as QueryWithTaskOutput | undefined)?.getTaskOutput
          if (typeof read !== 'function' || (!tasks.has(taskId) && !liveTaskList.some(task => task.id === taskId))) return null
          const result = await read.call(query, taskId)
          return { output: String(result?.output ?? ''), totalBytes: Number(result?.total_bytes) || 0, truncated: Boolean(result?.truncated) }
        },
      })
      void pump()
      for await (const event of query) {
        signal?.throwIfAborted()
        if ((event as { type: string }).type === 'command_lifecycle') {
          const { command_uuid: uuid, state } = event as unknown as { command_uuid: string; state: string }
          const requestId = offered.get(uuid)
          const told = offeredModes.get(uuid)
          if ((!requestId && !told) || state === 'queued') continue
          offered.delete(uuid)
          offeredModes.delete(uuid)
          if (state === 'started') {
            turnStarted()
            // A switch is recorded where Claude read it, as a mode row above the message.
            const modeSwitch = told && told.mode !== readMode
              ? { mode: told.mode, previousMode: readMode, revision: told.revision, content: claudeModeSwitchNotice(told.mode) } : null
            if (told) readMode = told.mode
            if (requestId) parent = queued!.deliver(requestId, parent, { mode: told?.mode ?? control.mode, modeSwitch }).id
            else if (modeSwitch) parent = queued!.recordModeSwitch(modeSwitch, parent).id
          } else if (requestId) {
            queued!.release(requestId, state === 'cancelled' ? { cancelled: true } : { error: `Claude did not run this message (${state}).` })
            settleIdle()
          }
          syncToldMode()
          continue
        }
        if ('session_id' in event && event.session_id) {
          observedSession = true
          activeSession = event.session_id
          if (recordedSession !== activeSession) {
            this.deps.sessions.session(lineageId, activeSession, 'running')
            recordedSession = activeSession
          }
        }
        if ('parent_tool_use_id' in event && event.parent_tool_use_id) continue // child detail remains in Claude's native transcript
        if (event.type === 'system' && event.subtype === 'init') {
          // A turn Claude starts on its own after `result` (a finished background task) opens with init.
          const fresh = !initSeen
          initSeen = true
          turnStarted()
          if (!fresh) continue
          // The CLI falls back to 'default' where auto mode is unavailable for the model or account.
          if (permissionMode === 'auto' && event.permissionMode !== 'auto') {
            emit({ type: 'notice', code: 'claude_auto_unavailable', lineageId,
              message: 'Claude auto mode is unavailable for this model or account; tool calls will ask for approval.' })
          }
        } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
          commitCompaction()
        } else if (event.type === 'system' && event.subtype === 'hook_started') {
          nativeHooks.started(event)
        } else if (event.type === 'system' && event.subtype === 'hook_progress') {
          nativeHooks.progress(event)
        } else if (event.type === 'system' && event.subtype === 'hook_response') {
          nativeHooks.finished(event)
        } else if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
          liveTaskList = event.tasks.filter(task => !task.ambient).map(task => ({ id: task.task_id, kind: task.task_type,
            description: task.description, toolUseId: tasks.get(task.task_id)?.toolUseId ?? null }))
          liveTasks = liveTaskList.length
          publishBackground()
          settleIdle()
        } else if (event.type === 'system' && (event.subtype === 'task_started' || event.subtype === 'task_progress' ||
          event.subtype === 'task_updated' || event.subtype === 'task_notification')) {
          trackProgress(event)
          trackTask(event)
        } else if (event.type === 'stream_event') {
          const frame = event.event
          if (frame.type === 'message_start') {
            turnStarted()
            currentApiId = frame.message.id
            streamedText = ''; streamedReasoning = ''
            emit({ type: 'tool_loop', status: 'turn_started', turn: ++turn, maxTurns: 0 })
          }
          if (frame.type === 'content_block_start' && (frame.content_block.type === 'text' || frame.content_block.type === 'thinking')) {
            // The SDK emits one assistant envelope per completed block, not necessarily per API message.
            streamedText = ''; streamedReasoning = ''
            // The renderer hides live buffers once their API message has a persisted row, so an
            // earlier block's envelope (e.g. thinking) would hold this block's deltas until it lands.
            if (currentApiId && apiResponses.has(currentApiId)) emit({ type: 'tool_loop', status: 'turn_started', turn, maxTurns: 0 })
          }
          if (frame.type === 'content_block_delta') {
            if (frame.delta.type === 'text_delta') { streamedText += frame.delta.text; emit({ type: 'chunk', part: 'text', delta: frame.delta.text }) }
            if (frame.delta.type === 'thinking_delta') { streamedReasoning += frame.delta.thinking; emit({ type: 'chunk', part: 'reasoning', delta: frame.delta.thinking }) }
          }
        } else if (event.type === 'assistant') {
          if (event.error) throw new Error(`Claude failed: ${event.error}`)
          pendingSkill = null
          // Omitted thinking is signature-only; the resume entry below keeps the raw block, so the
          // projection can drop it rather than render an empty reasoning row.
          const blocks: any[] = event.message.content
            .filter(block => block.type !== 'thinking' || block.thinking.trim().length > 0)
            .map((block, index) => {
            if (block.type === 'text') return { type: 'text', content: block.text, index }
            if (block.type === 'thinking') return { type: 'thinking', content: block.thinking, index }
            if (block.type === 'tool_use') {
              const input = block.input as any
              if (PLAN_WRITE_TOOLS.has(block.name) && typeof input?.file_path === 'string' &&
                path.resolve(cwd, input.file_path).startsWith(plansDir + path.sep)) lastPlanPath = path.resolve(cwd, input.file_path)
              const plan = pendingPlans.get(block.id)
              pendingPlans.delete(block.id)
              return { type: 'tool_use', id: block.id, name: block.name, input: plan ? { ...input, ...plan } : input, index }
            }
            return { type: 'text', content: `[Claude ${block.type}]`, index }
          })
          const content = event.message.content.filter(block => block.type === 'text').map(block => (block as any).text).join('')
          const calls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, arguments: block.input, status: 'executing' }))
          for (const block of takeInstructions(trigger => trigger === null)) blocks.push({ ...block, index: blocks.length })
          const responseKey = event.message.id || event.uuid
          let response = apiResponses.get(responseKey)
          let row: any
          if (response) {
            for (const block of blocks) response.blocks.push({ ...block, index: response.blocks.length })
            response.content += content
            response.calls.push(...calls)
            row = this.deps.messages.updateClaudeProjection(response.message.id, response.content, response.blocks,
              { ...claudeMessageMetadata(response.message.meta), ...runMeta(), claude: { sessionId: activeSession, messageUuid: event.uuid, checkpoint: false } })
            response.message = row
            finalMessage = row
            if (activeSession) this.deps.sessions.record(row.id, activeSession, event.uuid, cwd, false)
            emit({ type: 'assistant_message_persisted', message: row, lineageId })
          } else {
            row = persist(content, blocks, event.uuid)
            response = { message: row, blocks, calls, content }
            apiResponses.set(responseKey, response)
          }
          lastUuid = event.uuid
          turnEntries.push(resumeEntry(event.uuid, 'assistant', event.message.content))
          streamedText = ''; streamedReasoning = ''
          for (const call of calls) toolsInFlight.add(call.id)
          // A switch held for want of a tool step can go now.
          if (calls.length && toldMode !== control.mode) void pump()
          for (const call of calls) {
            toolOwners.set(call.id, response)
            for (const wake of ownerWaiters.get(call.id) ?? []) wake()
            ownerWaiters.delete(call.id)
            emit({ type: 'chunk', part: 'tool_call', toolCall: call })
            emit({ type: 'tool_execution', status: 'started', toolCallId: call.id, toolName: call.name })
          }
        } else if (event.type === 'user') {
          const blocks = Array.isArray(event.message.content) ? event.message.content : []
          if (event.isSynthetic && pendingSkill) {
            attachSkillBody(pendingSkill, typeof event.message.content === 'string' ? event.message.content
              : blocks.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n\n'))
            pendingSkill = null
            continue
          }
          if (blocks.some(block => block.type === 'tool_result')) turnEntries.push(resumeEntry(event.uuid, 'user', blocks))
          // tool_use_result belongs to the whole message, so it is only attributable when one result rides on it.
          const soleResult = blocks.filter(block => block.type === 'tool_result').length === 1
          for (const result of blocks) {
            if (result.type !== 'tool_result') continue
            toolsInFlight.delete(result.tool_use_id)
            const owner = toolOwners.get(result.tool_use_id)
            const content = textOf(result.content)
            const toolName = owner?.calls.find(call => call.id === result.tool_use_id)?.name
            const patch = soleResult && !result.is_error && CLAUDE_FILE_EDIT_TOOLS.has(toolName ?? '') ? claudeFilePatch(event.tool_use_result) : undefined
            if (owner) {
              const task = taskForCall(result.tool_use_id)
              owner.blocks.push({ type: 'tool_result', tool_use_id: result.tool_use_id, content, is_error: Boolean(result.is_error), ...(patch ? { patch } : {}), ...(task ? { task } : {}), index: owner.blocks.length })
              const call = owner.calls.find(call => call.id === result.tool_use_id)
              const read = (call?.arguments as any)?.file_path ?? (call?.arguments as any)?.notebook_path
              if (typeof read === 'string') {
                const target = path.resolve(cwd, read)
                for (const block of takeInstructions(trigger => trigger === target)) {
                  owner.blocks.push({ ...block, tool_use_id: result.tool_use_id, index: owner.blocks.length })
                }
              }
              if (call) call.status = 'complete'
              const updated = sink.updateAssistantToolState(owner.message.id, { contentBlocks: owner.blocks })
              if (updated) emit({ type: 'assistant_message_persisted', message: updated, lineageId })
              emit({ type: 'tool_execution', status: result.is_error ? 'failed' : 'completed', toolCallId: result.tool_use_id, toolName: call?.name ?? 'Claude tool' })
              if (toolName === 'Skill' && !result.is_error) {
                const resultName = soleResult ? (event.tool_use_result as any)?.commandName : undefined
                pendingSkill = { owner, toolUseId: result.tool_use_id, name: String(resultName ?? (call?.arguments as any)?.skill ?? 'skill') }
              }
            }
            emit({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: result.tool_use_id, content, is_error: Boolean(result.is_error), ...(patch ? { patch } : {}) } })
          }
        } else if (event.type === 'system' && event.subtype === 'status' && event.compact_result === 'failed') {
          compactionActive = false
          compactionEvent('failed', undefined, event.compact_error ?? 'Claude compaction failed')
          if (request.manualCompaction) throw new Error(event.compact_error ?? 'Claude compaction failed')
        } else if (event.type === 'system' && event.subtype === 'status' && event.status === 'compacting') {
          // Main thread only: the CLI gives subagent contexts no compaction-event sink. It also
          // repeats every 30s during a long compaction, so only the first one starts it.
          if (!compactionActive) {
            compactionActive = true
            compactionEvent('started')
          }
        } else if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') throw new Error(`Claude run failed: ${'errors' in event ? event.errors.join('; ') : event.subtype}`)
          // A main compaction always ends at its boundary or a failed status within the turn.
          if (compactionActive) {
            compactionActive = false
            compactionEvent('failed', undefined, 'Claude compaction did not complete')
          }
          completed = true
          toolsInFlight.clear()
          // A queued message keeps the session open: Claude runs it as the next turn.
          idle = true
          publishBackground()
          settleIdle()
        }
      }
      if (hookFailure) throw hookFailure
      if (pendingCompactions.length) throw new Error('Claude supplied a summary without a completed compaction boundary')
      if (request.manualCompaction) {
        if (!completed || !activeSession || !compactionSummary) throw new Error('Claude ended without a committed compaction summary')
        this.deps.sessions.session(lineageId, activeSession, 'ready')
        // A switch made while compacting has no turn to carry it; the summary records it, as a
        // response row would, so the composer and the next send pick it up.
        const summaryMeta = claudeMessageMetadata(compactionSummary.meta)
        if (summaryMeta.operationMode !== control.mode) {
          const blocks = typeof compactionSummary.content_blocks === 'string' ? JSON.parse(compactionSummary.content_blocks) : compactionSummary.content_blocks ?? []
          compactionSummary = this.deps.messages.updateClaudeProjection(compactionSummary.id, compactionSummary.content, blocks,
            { ...summaryMeta, operationMode: control.mode })
          control.settlePending()
        }
        return compactionSummary
      }
      if (!completed || !activeSession || !finalMessage || !lastUuid) throw new Error('Claude ended without a completed response')
      this.deps.sessions.record(finalMessage.id, activeSession, lastUuid, cwd, true)
      const finalResponse = [...apiResponses.values()].find(response => response.message.id === finalMessage.id)
      const finalBlocks = finalResponse?.blocks ?? (typeof finalMessage.content_blocks === 'string' ? JSON.parse(finalMessage.content_blocks) : finalMessage.content_blocks ?? finalMessage.contentBlocks ?? [])
      // Loads no later row or matching tool result claimed (a trigger path that did not match).
      for (const block of takeInstructions(() => true)) finalBlocks.push({ ...block, index: finalBlocks.length })
      finalMessage = this.deps.messages.updateClaudeProjection(finalMessage.id, finalMessage.content, finalBlocks,
        { ...claudeMessageMetadata(finalMessage.meta), ...runMeta(), claude: { sessionId: activeSession, messageUuid: lastUuid, checkpoint: true } })
      emit({ type: 'assistant_message_persisted', message: finalMessage, lineageId })
      this.deps.sessions.session(lineageId, activeSession, 'ready')
      return finalMessage
    } catch (error) {
      if (compactionActive) compactionEvent('failed', undefined, 'Claude compaction did not complete')
      if (streamedText || streamedReasoning) {
        const blocks = [
          ...(streamedReasoning ? [{ type: 'thinking', content: streamedReasoning, index: 0 }] : []),
          ...(streamedText ? [{ type: 'text', content: streamedText, index: 1 }] : []),
        ]
        const response = currentApiId ? apiResponses.get(currentApiId) : undefined
        if (response) {
          for (const block of blocks) response.blocks.push({ ...block, index: response.blocks.length })
          finalMessage = this.deps.messages.updateClaudeProjection(response.message.id, response.content + streamedText, response.blocks,
            { ...claudeMessageMetadata(response.message.meta), ...runMeta(), claude: { sessionId: activeSession, checkpoint: false, partial: true } })
          emit({ type: 'assistant_message_persisted', message: finalMessage, lineageId })
        } else persist(streamedText, blocks, undefined, true)
      }
      if (activeSession && observedSession) {
        // Make the visible head continuable from the last safe native point (forked, never appended).
        // Not across a compaction whose native outcome is unknown.
        const compactionUnsettled = request.manualCompaction || compactionActive || pendingCompactions.length > 0 || hookFailure !== undefined
        const resumeUuid = compactionUnsettled ? null : safeResumePoint(turnEntries)
        if (finalMessage && resumeUuid) this.deps.sessions.record(finalMessage.id, activeSession, resumeUuid, cwd, true)
        this.deps.sessions.session(lineageId, activeSession, finalMessage && resumeUuid ? 'interrupted' : 'uncertain')
      }
      throw error
    } finally {
      unbindTasks?.()
      liveTaskList = []
      liveProgress.clear()
      publishBackground()
      // Stopping the session ends its background tasks too.
      for (const [id, entry] of tasks) {
        if (entry.task.status !== 'running') continue
        entry.task = { ...entry.task, status: 'stopped' }
        dirtyTasks.add(id)
      }
      writeTasks()
      finishInput()
      clearTimeout(startTimer)
      unsubscribeQueue?.()
      abortController.signal.removeEventListener('abort', releaseInput)
      signal?.removeEventListener('abort', abort)
      query?.close()
      nativeHooks.settle(abortController.signal.aborted)
      // A Graviton SessionStart after a compaction can land after its boundary.
      hookSession?.attachPendingHookRuns(compactionSummary?.id ?? finalMessage?.id ?? parent)
    }
  }
}
