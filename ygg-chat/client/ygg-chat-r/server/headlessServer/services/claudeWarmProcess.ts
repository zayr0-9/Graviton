import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { EventPump, InputChannel } from './claudeWarmChannel.js'

/**
 * Warm Claude sessions: a branch's Claude CLI process stays open between Graviton runs, so the
 * next send at the head of that branch is pushed into the same process instead of launching a new
 * CLI (no boot, no MCP reconnects, no reload of skills, plugins and CLAUDE.md).
 *
 * Only continuous single-branch sends reuse a process. Forks, edits, retries, summary branches,
 * launch-time setting changes and anything uncertain take the cold path, which starts a new CLI.
 */

export interface ClaudeWarmConfig {
  /** A parked process is closed after this long unused. */
  idleMs: number
  /** Parked processes kept at once; the longest-unused is closed first. */
  maxParked: number
  /** A process is not parked again after this age, so it relaunches with fresh configuration. */
  maxAgeMs: number
}

export const DEFAULT_CLAUDE_WARM: ClaudeWarmConfig = { idleMs: 10 * 60_000, maxParked: 3, maxAgeMs: 60 * 60_000 }

/** `GRAVITON_CLAUDE_WARM_IDLE_MS=0` turns warm sessions off. */
export function claudeWarmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeWarmConfig | null {
  const number = (value: string | undefined, fallback: number) => {
    const parsed = value === undefined || value === '' ? NaN : Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  const config = { idleMs: number(env.GRAVITON_CLAUDE_WARM_IDLE_MS, DEFAULT_CLAUDE_WARM.idleMs),
    maxParked: Math.floor(number(env.GRAVITON_CLAUDE_WARM_MAX, DEFAULT_CLAUDE_WARM.maxParked)),
    maxAgeMs: number(env.GRAVITON_CLAUDE_WARM_MAX_AGE_MS, DEFAULT_CLAUDE_WARM.maxAgeMs) }
  return config.idleMs > 0 && config.maxParked > 0 ? config : null
}

// Bumped when Claude's MCP state changes outside a chat process (sign-in, reconnect, sign-out in
// Settings): a parked process still holds the old connections, so it must not be reused.
let configEpoch = 0
export function bumpClaudeConfigEpoch(): void { configEpoch++ }

/**
 * What a process fixed at launch that a later run cannot change on it: the folder and extra roots,
 * the thinking mode, MCP options, the executable, the shape of the SDK hooks, and the settings
 * files Claude read (hooks, permissions, plugins and MCP definitions are read once at launch).
 */
export async function claudeLaunchKey(input: {
  cwd: string; additionalDirectories?: string[]; adaptiveThinking: boolean; mcp: unknown
  plansDirectory: string; executable: string; hookShape: string
}): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const files = [
    path.join(configDir, 'settings.json'), path.join(configDir, 'settings.local.json'),
    path.join(input.cwd, '.mcp.json'), path.join(input.cwd, '.claude', 'settings.json'), path.join(input.cwd, '.claude', 'settings.local.json'),
  ]
  const fingerprint = async (file: string) => {
    const info = await stat(file).catch(() => null)
    return info ? `${info.mtimeMs}:${info.size}` : '-'
  }
  const executable = await realpath(input.executable).catch(() => input.executable)
  return JSON.stringify({
    cwd: input.cwd, additionalDirectories: [...(input.additionalDirectories ?? [])].sort(), adaptiveThinking: input.adaptiveThinking,
    mcp: input.mcp, plansDirectory: input.plansDirectory, hookShape: input.hookShape, epoch: configEpoch,
    executable: `${executable}@${await fingerprint(executable)}`, settings: await Promise.all(files.map(fingerprint)),
  })
}

/** The live settings a run applies to a reused process. */
export interface ClaudeWarmSettings { model: string; effort: string | null; ultracode: boolean }

/** The run that currently owns a process: its permission callback and SDK hooks. */
export interface ClaudeWarmBindings {
  canUseTool: CanUseTool
  hooks: NonNullable<Options['hooks']>
}

const NO_RUN = 'No Graviton run is attached to this Claude session.'

/**
 * Hooks with the run's structure whose callbacks forward to the current owner's callback at the
 * same position. With no owner, PreToolUse denies (the Chat-mode guard must never fail open) and
 * the rest do nothing. A reused process needs the same structure (`hookShape` in the launch key).
 */
function delegateHooks(template: NonNullable<Options['hooks']>, owner: () => ClaudeWarmBindings | null): NonNullable<Options['hooks']> {
  const delegated: NonNullable<Options['hooks']> = {}
  for (const [event, groups] of Object.entries(template) as Array<[keyof typeof template, NonNullable<(typeof template)[keyof typeof template]>]>) {
    delegated[event] = groups.map((group, groupIndex) => ({ ...group, hooks: group.hooks.map((_hook, hookIndex) => async (...args: Parameters<typeof _hook>) => {
      const target = owner()?.hooks[event]?.[groupIndex]?.hooks[hookIndex]
      if (target) return target(...args)
      if (event === 'PreToolUse') return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: NO_RUN } }
      return {}
    }) }))
  }
  return delegated
}

/** Events a parked, idle process may emit without having started work of its own. */
export function claudeIdleEvent(event: SDKMessage): boolean {
  const kind = event as { type: string; subtype?: string; state?: string; status?: string; tasks?: unknown[] }
  if (kind.type === 'rate_limit_event') return true
  // The previous prompt's `completed` arrives just after its `result`.
  if (kind.type === 'command_lifecycle') return kind.state === 'completed'
  if (kind.type !== 'system') return false
  if (kind.subtype === 'hook_started' || kind.subtype === 'hook_progress' || kind.subtype === 'hook_response') return true
  if (kind.subtype === 'session_state_changed') return kind.state === 'idle'
  if (kind.subtype === 'background_tasks_changed') return Array.isArray(kind.tasks) && kind.tasks.length === 0
  if (kind.subtype === 'status') return kind.status !== 'compacting'
  return kind.subtype === 'commands_changed' || kind.subtype === 'notification' || kind.subtype === 'informational'
}

export type ClaudeQuery = Pick<Query, 'close' | 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'mcpServerStatus' | 'stopTask'> & AsyncIterable<SDKMessage>
type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery

const EXIT_WAIT_MS = 8_000

/**
 * One CLI process. Owned by a run while it streams, parked between runs. While parked (or being
 * claimed) a drainer reads the events: anything but idle chatter means the CLI started work by
 * itself, so the process is closed and the branch marked interrupted (the next send forks at the
 * checkpoint instead of appending to a transcript Graviton did not see).
 */
export class ClaudeWarmProcess {
  readonly channel = new InputChannel<SDKUserMessage>()
  readonly events: EventPump<SDKMessage>
  readonly query: ClaudeQuery
  readonly createdAt = Date.now()
  private readonly abort = new AbortController()
  private owner: ClaudeWarmBindings | null
  private stateValue: 'owned' | 'claiming' | 'parked' | 'dead' = 'owned'
  private disposal: Promise<void> | null = null
  /** The CLI started work while no run owned it. */
  selfStarted = false
  /** Graviton row whose native entry is this process's transcript tail (set when parked). */
  headMessageId: string | null = null
  sessionId: string | null
  parkedAt = 0
  settings: ClaudeWarmSettings
  onSelfStart: ((process: ClaudeWarmProcess) => void) | null = null

  constructor(create: QueryFactory, options: Options, bindings: ClaudeWarmBindings,
    readonly lineageId: string, readonly launchKey: string, sessionId: string | null, settings: ClaudeWarmSettings) {
    this.owner = bindings
    this.sessionId = sessionId
    this.settings = settings
    this.query = create({ prompt: this.channel.stream(), options: { ...options, abortController: this.abort,
      canUseTool: (...args) => this.owner ? this.owner.canUseTool(...args) : Promise.resolve({ behavior: 'deny', message: NO_RUN, interrupt: true }),
      hooks: delegateHooks(bindings.hooks, () => this.owner) } })
    this.events = new EventPump(this.query)
    void this.events.exited.then(() => { if (this.stateValue !== 'dead') this.stateValue = 'dead' })
  }

  get state() { return this.stateValue }
  get alive() { return this.stateValue !== 'dead' && !this.events.done }

  /** Detach the run; start watching for work the CLI starts by itself. */
  park(headMessageId: string, sessionId: string, settings: ClaudeWarmSettings) {
    this.owner = null
    this.headMessageId = headMessageId
    this.sessionId = sessionId
    this.settings = settings
    this.parkedAt = Date.now()
    this.stateValue = 'parked'
    void this.drain()
  }

  /** A run took the process from the registry; the drainer keeps watching until `activate`. */
  claim() { if (this.stateValue === 'parked') this.stateValue = 'claiming' }

  /** The claiming run owns the process from here: callbacks reach it, the drainer stops. */
  activate(bindings: ClaudeWarmBindings): boolean {
    if (this.stateValue !== 'claiming' || !this.alive) return false
    this.owner = bindings
    this.stateValue = 'owned'
    return true
  }

  private async drain() {
    while (this.stateValue === 'parked' || this.stateValue === 'claiming') {
      let result: IteratorResult<SDKMessage>
      try { result = await this.events.next() } catch { this.stateValue = 'dead'; return }
      // A run took over: it reads this same, unconsumed result.
      if (this.stateValue !== 'parked' && this.stateValue !== 'claiming') return
      if (result.done) { this.stateValue = 'dead'; return }
      if (claudeIdleEvent(result.value)) { this.events.consume(); continue }
      this.selfStarted = true
      this.onSelfStart?.(this)
      void this.dispose()
      return
    }
  }

  /** Kill now (a stopped run): the CLI ends its turn and background tasks. */
  kill() {
    // The owner stays: a dead CLI calls nothing, and a run's own callbacks stay usable to it.
    this.stateValue = 'dead'
    this.channel.close()
    this.abort.abort()
    try { this.query.close() } catch { /* already exiting */ }
  }

  /** Close the process and wait (bounded) until it has exited, so nothing else writes its session. */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.kill()
      // Reading to the end is what observes the exit; whatever is left is dropped.
      await this.events.drain(EXIT_WAIT_MS)
    })()
    return this.disposal
  }
}

/** Parked processes by branch, plus processes still exiting, which a branch's next run waits for. */
export class ClaudeWarmRegistry {
  private readonly parked = new Map<string, { process: ClaudeWarmProcess; idle: ReturnType<typeof setTimeout> }>()
  private readonly exiting = new Map<string, Promise<void>>()

  constructor(readonly config: ClaudeWarmConfig | null, private readonly onSelfStart: (process: ClaudeWarmProcess) => void) {}

  get enabled() { return this.config !== null }

  /** Remove the branch's parked process, synchronously, for a run to claim or close. */
  take(lineageId: string): ClaudeWarmProcess | null {
    const entry = this.parked.get(lineageId)
    if (!entry) return null
    this.parked.delete(lineageId)
    clearTimeout(entry.idle)
    if (!entry.process.alive) { this.retire(entry.process); return null }
    entry.process.claim()
    return entry.process
  }

  /** Waits until no process of this branch is still exiting. */
  async settled(lineageId: string): Promise<void> {
    await this.exiting.get(lineageId)
  }

  park(process: ClaudeWarmProcess, headMessageId: string, sessionId: string, settings: ClaudeWarmSettings): boolean {
    const config = this.config
    if (!config || !process.alive || Date.now() - process.createdAt >= config.maxAgeMs) { this.retire(process); return false }
    const existing = this.parked.get(process.lineageId)
    if (existing && existing.process !== process) this.retire(existing.process)
    while (this.parked.size >= config.maxParked) {
      const [oldest] = [...this.parked.values()].sort((a, b) => a.process.parkedAt - b.process.parkedAt)
      this.parked.delete(oldest.process.lineageId)
      clearTimeout(oldest.idle)
      this.retire(oldest.process)
    }
    process.onSelfStart = proc => {
      const entry = this.parked.get(proc.lineageId)
      if (entry?.process === proc) { this.parked.delete(proc.lineageId); clearTimeout(entry.idle) }
      this.trackExit(proc)
      this.onSelfStart(proc)
    }
    process.park(headMessageId, sessionId, settings)
    const idle = setTimeout(() => {
      if (this.parked.get(process.lineageId)?.process !== process) return
      this.parked.delete(process.lineageId)
      this.retire(process)
    }, config.idleMs)
    idle.unref?.()
    this.parked.set(process.lineageId, { process, idle })
    return true
  }

  /** Close a process; the branch's next run waits for its exit. */
  retire(process: ClaudeWarmProcess): Promise<void> {
    void process.dispose()
    return this.trackExit(process)
  }

  private trackExit(process: ClaudeWarmProcess): Promise<void> {
    const previous = this.exiting.get(process.lineageId)
    const exit = previous ? Promise.all([previous, process.dispose()]).then(() => {}) : process.dispose()
    this.exiting.set(process.lineageId, exit)
    void exit.finally(() => { if (this.exiting.get(process.lineageId) === exit) this.exiting.delete(process.lineageId) })
    return exit
  }

  /** Host shutdown: close every process. */
  async disposeAll(): Promise<void> {
    for (const [lineageId, entry] of this.parked) { clearTimeout(entry.idle); this.parked.delete(lineageId); this.retire(entry.process) }
    await Promise.all([...this.exiting.values()])
  }

  /** Branches with a parked process (tests, diagnostics). */
  parkedLineages(): string[] { return [...this.parked.keys()] }
}
