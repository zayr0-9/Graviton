import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Serializes memory-heavy shell commands (builds, type checks, test runners)
 * per workspace. Agents batch these in parallel `multi_call`s and concurrent
 * runs share a checkout, so without a gate one workspace can start several
 * `tsc`/`vite build`/vitest worker pools at once and exhaust host RAM.
 *
 * Only Graviton's own `bash`/`powershell` tool passes through here; Claude
 * Code's native Bash runs inside the Claude CLI and is not gated.
 */

const PACKAGE_SCRIPT =
  /\b(?:npm|pnpm|yarn|bun)\b(?:\s+-{1,2}[\w-]+(?:[= ](?!run\b)[^\s;&|-][^\s;&|]*)?)*\s+(?:run(?:-script)?\s+)?(?:build|test|t|typecheck|type-check|tsc|e2e|check|lint)(?:[:.-][\w:.-]*)?(?=$|[\s;&|)])/
const TOOL_BINARY =
  /(?:^|[\s;&|(/"'])(?:tsc|vitest|jest|webpack|electron-builder|playwright)(?:\.[cm]?js)?(?=$|[\s;&|)"'])/
const SUBCOMMAND =
  /(?:^|[\s;&|(/])(?:(?:vite|next|nuxt|astro)(?:\.[cm]?js)?\s+build|cargo\s+(?:build|test|check|clippy)|go\s+(?:build|test))(?=$|[\s;&|)])/

const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/

/** Minimum budget left for the command itself once the gate is acquired. */
export const HEAVY_COMMAND_MIN_RUN_MS = 10_000

export function isHeavyShellCommand(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  return PACKAGE_SCRIPT.test(command) || TOOL_BINARY.test(command) || SUBCOMMAND.test(command)
}

function findRepoRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/** Repository root (or resolved cwd) the command will run in. */
export function resolveHeavyCommandWorkspace(command: string, cwd: unknown, rootPath: string | null | undefined): string {
  const base = rootPath?.trim() || process.cwd()
  let target = typeof cwd === 'string' && cwd.trim() ? path.resolve(base, cwd.trim()) : path.resolve(base)
  const cd = command.match(LEADING_CD)?.[1]?.replace(/^["']|["']$/g, '')
  if (cd && !cd.startsWith('~') && !cd.includes('$')) target = path.resolve(target, cd)
  try {
    target = realpathSync(target)
  } catch {
    /* nonexistent paths still key consistently */
  }
  return findRepoRoot(target)
}

type Holder = { command: string; since: number }
type Waiter = { grant: () => void }
type Slot = { holder: Holder; waiters: Waiter[] }

export class HeavyCommandBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeavyCommandBusyError'
  }
}

function abortError(): Error {
  const error = new Error('Tool execution aborted')
  error.name = 'AbortError'
  return error
}

function summarize(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

export class HeavyCommandGate {
  private readonly slots = new Map<string, Slot>()

  /**
   * Resolves with a release function once `workspace` has no other heavy
   * command running. Waiters are granted in FIFO order. Rejects on abort, or
   * with HeavyCommandBusyError (the command never started) at `waitUntilMs`.
   */
  async acquire(
    workspace: string,
    command: string,
    options: { signal?: AbortSignal; waitUntilMs?: number } = {}
  ): Promise<() => void> {
    const { signal, waitUntilMs = Infinity } = options
    if (signal?.aborted) throw abortError()
    const holder: Holder = { command: summarize(command), since: Date.now() }
    const slot = this.slots.get(workspace)
    if (!slot) {
      this.slots.set(workspace, { holder, waiters: [] })
      return this.releaser(workspace)
    }

    const blockedBy = slot.holder
    console.log(`[HeavyCommandGate] queued in ${workspace}: "${holder.command}" waiting for "${blockedBy.command}"`)
    return await new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = slot.waiters.indexOf(waiter)
        if (index >= 0) slot.waiters.splice(index, 1)
      }
      const waiter: Waiter = {
        grant: () => {
          cleanup()
          holder.since = Date.now()
          slot.holder = holder
          resolve(this.releaser(workspace))
        },
      }
      const onAbort = () => {
        cleanup()
        reject(abortError())
      }
      slot.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (Number.isFinite(waitUntilMs)) {
        timer = setTimeout(() => {
          cleanup()
          const current = this.slots.get(workspace)?.holder ?? blockedBy
          const runningFor = Math.round((Date.now() - current.since) / 1000)
          reject(new HeavyCommandBusyError(
            `Not started: another heavy command ("${current.command}") has been running in ${workspace} for ${runningFor}s. ` +
              'Builds, type checks and test runners run one at a time per workspace to bound memory use. ' +
              'Retry after it finishes, or run fewer heavy commands at once.'
          ))
        }, Math.max(0, waitUntilMs - Date.now()))
      }
    })
  }

  private releaser(workspace: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const slot = this.slots.get(workspace)
      if (!slot) return
      const next = slot.waiters[0]
      if (next) next.grant()
      else this.slots.delete(workspace)
    }
  }

  /** Test/diagnostic view of current holders. */
  snapshot(): Array<{ workspace: string; command: string; waiting: number }> {
    return [...this.slots.entries()].map(([workspace, slot]) => ({
      workspace,
      command: slot.holder.command,
      waiting: slot.waiters.length,
    }))
  }
}

export const heavyCommandGate = new HeavyCommandGate()
