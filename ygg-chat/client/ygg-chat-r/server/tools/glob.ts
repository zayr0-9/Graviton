import { glob } from 'glob'
import * as path from 'path'
import { detectPathType, isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'

const DEFAULT_MAX_MATCHES = 3000
const DEFAULT_TIMEOUT_MS = 5000
const DIRECTORY_DEPTH_LIMIT = 6
const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/.ygg/memory/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/tmp/**',
  '**/temp/**',
  '**/*.min.js',
]

async function resolveGlobCwd(cwd: string, signal: AbortSignal, deadlineMs: number): Promise<string> {
  // glob runs in Node, not WSL: retain the native UNC path for filesystem access.
  if (isWindows() && detectPathType(cwd) === 'linux') {
    return resolveToWindowsPath(cwd, { signal, deadlineMs })
  }
  return path.resolve(cwd)
}

function mergeIgnorePatterns(defaults: string[], custom?: string | string[]): string[] {
  if (!custom) return defaults
  const userPatterns = Array.isArray(custom) ? custom : [custom]
  const cleaned = userPatterns.filter(Boolean)
  return Array.from(new Set([...defaults, ...cleaned]))
}

function enforcePatternDepth(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean)
  if (segments.length <= DIRECTORY_DEPTH_LIMIT) return pattern
  return segments.slice(0, DIRECTORY_DEPTH_LIMIT).join('/')
}

export interface GlobOptions {
  cwd?: string
  ignore?: string | string[]
  dot?: boolean
  absolute?: boolean
  mark?: boolean
  nosort?: boolean
  nocase?: boolean
  nodir?: boolean
  follow?: boolean
  realpath?: boolean
  stat?: boolean
  withFileTypes?: boolean
  maxMatches?: number
  timeoutMs?: number
  signal?: AbortSignal
  deadlineMs?: number
}

export interface GlobResult {
  success: boolean
  matches: string[]
  error?: string
  timedOut?: boolean
  cancelled?: boolean
  pattern?: string
  cwd?: string
}

export async function globSearch(pattern: string, options: GlobOptions = {}): Promise<GlobResult> {
  if (!pattern || pattern.trim() === '') {
    return {
      success: false,
      matches: [],
      error: 'Pattern cannot be empty',
    }
  }

  const {
    cwd = process.cwd(),
    ignore,
    dot = false,
    absolute = false,
    mark = false,
    nosort = false,
    nocase = false,
    nodir = false,
    follow = false,
    realpath = false,
    stat = false,
    withFileTypes = false,
    maxMatches = DEFAULT_MAX_MATCHES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.min(600_000, Math.floor(timeoutMs))) : DEFAULT_TIMEOUT_MS
  const deadlineMs = Math.min(Date.now() + budgetMs,
    Number.isFinite(options.deadlineMs) ? options.deadlineMs! : Infinity)
  const matchLimit = Number.isFinite(maxMatches) && maxMatches > 0
    ? Math.max(1, Math.floor(maxMatches)) : DEFAULT_MAX_MATCHES
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let cancelled = false
  const onCancel = () => {
    cancelled = true
    controller.abort(new Error('Glob search cancelled'))
  }
  const onTimeout = () => {
    timedOut = true
    controller.abort(new Error('Glob search timed out. Narrow the pattern or specify a smaller cwd.'))
  }
  let onAbort: () => void = () => {}

  try {
    if (options.signal?.aborted) onCancel()
    else if (deadlineMs <= Date.now()) onTimeout()
    controller.signal.throwIfAborted()
    options.signal?.addEventListener('abort', onCancel, { once: true })
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    timer = setTimeout(onTimeout, Math.max(0, deadlineMs - Date.now()))

    // Include path/WSL preparation in the budget, and fence late preparation so
    // cancellation cannot start a traversal after the caller has stopped waiting.
    const search = async (): Promise<GlobResult> => {
      const resolvedCwd = await resolveGlobCwd(cwd, controller.signal, deadlineMs)
      if (!controller.signal.aborted && Date.now() >= deadlineMs) onTimeout()
      controller.signal.throwIfAborted()
      const sanitizedPattern = enforcePatternDepth(pattern)
      const matches: string[] = []
      const globOptions = {
        cwd: resolvedCwd, ignore: mergeIgnorePatterns(DEFAULT_IGNORE_PATTERNS, ignore),
        dot, absolute: withFileTypes ? undefined : absolute, mark, nosort, nocase, nodir, follow, realpath, stat,
        withFileTypes, windowsPathsNoEscape: true, signal: controller.signal,
      }
      // Consume incrementally instead of retaining every match before applying
      // the limit. Abort also stops the package's underlying filesystem walk.
      for await (const match of glob.iterate(sanitizedPattern, globOptions)) {
        controller.signal.throwIfAborted()
        if (matches.length >= matchLimit) {
          const error = new Error(`Too many matches (>${matchLimit}). Narrow the pattern or reduce cwd scope.`)
          controller.abort(error)
          throw error
        }
        matches.push(typeof match === 'string' ? match : match.fullpath())
      }
      controller.signal.throwIfAborted()
      return { success: true, matches, pattern: sanitizedPattern, cwd: resolvedCwd }
    }
    return await Promise.race([search(), stopped])
  } catch (error: any) {
    return {
      success: false, matches: [], error: error?.message || 'Glob search failed', pattern, cwd,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

export default globSearch
