import { randomUUID } from 'crypto'
import { runBoundedShell, type ShellRunOptions, type ShellRunResult } from './shellRunner.js'
import * as path from 'path'
import { detectPathType, getWSLCommandArgs, shouldUseWSL, toWslPath } from '../utils/wslBridge.js'
import { getNativeShellPath } from './nativeShell.js'

const DEFAULT_MAX_OUTPUT_CHARS = (() => {
  const envValue = Number(process.env.RIPGREP_MAX_OUTPUT_CHARS ?? process.env.RIPGREP_OUTPUT_LIMIT)
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.floor(envValue)
  }
  return 40000
})()

// Multi-layered limits to prevent overwhelming responses
const MAX_RESULT_LINES = 5000 // Maximum number of match objects
const MAX_LINE_LENGTH = 1000 // Maximum characters per individual line (will truncate)
// const MAX_TOTAL_CHARS = 5000 // Maximum total characters across all match content

export interface RipgrepOptions {
  caseSensitive?: boolean // -s (case-sensitive) vs -i (case-insensitive)
  lineNumbers?: boolean // -n (show line numbers)
  count?: boolean // -c (count matches)
  filesWithMatches?: boolean // -l (list files with matches)
  maxCount?: number // -m (max matches per file)
  glob?: string // -g (file pattern)
  hidden?: boolean // --hidden (search hidden files)
  noIgnore?: boolean // --no-ignore (ignore .gitignore)
  contextLines?: number // -C (context lines before and after)
  maxOutputChars?: number // Optional limit on total output characters returned
  timeoutMs?: number
  signal?: AbortSignal
  deadlineMs?: number
}

export interface RipgrepResult {
  success: boolean
  matches: Array<{
    file: string
    lineNumber?: number
    line?: string
    matchCount?: number
  }>
  error?: string
  timedOut?: boolean
  cancelled?: boolean
  command?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
// Raw JSON includes metadata/context that the model-result character limit does
// not count. Bound collection before parsing, independently of that result limit.
const MAX_RAW_OUTPUT_CHARS = 200_000
let windowsNativeRgPath: string | undefined

async function detectWindowsNativeRgPath(options: ShellRunOptions): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (windowsNativeRgPath) return windowsNativeRgPath
  const result = await runBoundedShell(async () => ({ cmd: 'where.exe', args: ['rg.exe'] }), {
    ...options, maxOutputChars: 16_384,
  })
  if (result.cancelled || result.timedOut) throw new Error(result.error || 'ripgrep discovery stopped')
  const found = result.success ? result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) : undefined
  // Do not cache an in-flight invocation: one caller's cancellation must not
  // poison other searches or leave a hung discovery promise cached forever.
  if (found) windowsNativeRgPath = found
  return found || null
}

/**
 * Resolve the search path for ripgrep.
 * - WSL mode: convert to Linux path for `wsl.exe -e rg`.
 * - Native mode: resolve to native absolute path.
 */
function resolveSearchPath(inputPath: string, useWSL: boolean): string {
  const pathCandidate = (inputPath?.trim() || '.').trim()

  if (useWSL) {
    return toWslPath(pathCandidate)
  }

  return path.isAbsolute(pathCandidate) ? pathCandidate : path.resolve(pathCandidate)
}

export async function ripgrepSearch(
  pattern: string,
  searchPath: string = '.',
  options: RipgrepOptions = {}
): Promise<RipgrepResult> {
  const {
    caseSensitive = false,
    lineNumbers = true,
    count = false,
    filesWithMatches = false,
    maxCount,
    glob,
    hidden = false,
    noIgnore = false,
    contextLines,
    maxOutputChars: userMaxOutputChars,
  } = options

  const maxOutputChars =
    Number.isFinite(userMaxOutputChars) && userMaxOutputChars !== undefined && userMaxOutputChars > 0
      ? Math.floor(userMaxOutputChars)
      : DEFAULT_MAX_OUTPUT_CHARS

  const normalizedSearchPath = (searchPath?.trim() || '.').trim()
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.max(1, Math.min(180_000, Math.floor(options.timeoutMs))) : DEFAULT_TIMEOUT_MS
  const runOptions: ShellRunOptions = {
    timeoutMs, signal: options.signal, deadlineMs: options.deadlineMs,
    maxOutputChars: MAX_RAW_OUTPUT_CHARS, successCodes: [0, 1], env: {},
  }

  // Build rg command arguments
  const args: string[] = []

  // Keep patterns beginning with '-' literal rather than interpreting rg flags.
  args.push('-e', pattern)

  // Options
  if (!caseSensitive) {
    args.push('-i') // Case-insensitive
  } else {
    args.push('-s') // Case-sensitive
  }

  if (lineNumbers && !count && !filesWithMatches) {
    args.push('-n') // Show line numbers
  }

  if (count) {
    args.push('-c') // Count matches
  }

  if (filesWithMatches) {
    args.push('-l') // List files with matches
  }

  if (maxCount !== undefined) {
    args.push('-m', maxCount.toString())
  }

  if (glob) {
    args.push('-g', glob)
  }

  if (hidden) {
    args.push('--hidden')
  }

  if (noIgnore) {
    args.push('--no-ignore')
  }

  if (contextLines !== undefined) {
    args.push('-C', contextLines.toString())
  }

  // Add JSON output format for easier parsing (if supported and not using simple modes)
  if (!count && !filesWithMatches) {
    args.push('--json')
  }

  let command = `rg ${args.join(' ')} ${normalizedSearchPath}`
  const result: ShellRunResult = await runBoundedShell(async context => {
    const pathType = detectPathType(normalizedSearchPath)
    const nativeRg = await detectWindowsNativeRgPath({ ...context, timeoutMs })
    context.signal.throwIfAborted()
    const useNativeWindows = process.platform === 'win32' && nativeRg &&
      (pathType === 'relative' || pathType === 'windows')
    const useWSL = shouldUseWSL() && !useNativeWindows
    const resolvedPath = resolveSearchPath(normalizedSearchPath, Boolean(useWSL))
    const commandArgs = [...args, '--', resolvedPath]
    if (useWSL) {
      const marker = `__YGG_RG_${randomUUID().replace(/-/g, '')}__`
      // Pass every rg argument positionally, never interpolate the user's pattern
      // into shell code. Own a Linux process group for bounded WSL cleanup.
      const [cmd, wslArgs] = await getWSLCommandArgs('setsid', ['sh', '-c',
        `printf '${marker}%s\\n' "$$" >&2; exec rg "$@"`, 'ygg-rg', ...commandArgs], undefined, context)
      command = `${cmd} ${wslArgs.join(' ')}`
      return { cmd, args: wslArgs, wsl: { distro: wslArgs[1], marker } }
    }
    const nativeShellPath = await getNativeShellPath()
    context.signal.throwIfAborted()
    if (nativeShellPath) runOptions.env!.PATH = nativeShellPath
    const cmd = useNativeWindows ? nativeRg! : 'rg'
    command = `${cmd} ${commandArgs.join(' ')}`
    return { cmd, args: commandArgs }
  }, runOptions, true)

  if (!result.success) {
    return {
      success: false, matches: [], command,
      error: result.error || result.stderr.trim() || 'ripgrep exited unsuccessfully',
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.cancelled ? { cancelled: true } : {}),
    }
  }
  // Never parse a truncated JSON record or mistake partial capture for a complete
  // search. The shared runner bounds stdout+stderr while the child is producing it.
  if (result.stderr.includes(`[Output truncated at ${MAX_RAW_OUTPUT_CHARS} characters]`)) {
    return { success: false, matches: [], command,
      error: `Search output exceeded the ${MAX_RAW_OUTPUT_CHARS}-character capture limit. Narrow the pattern or search path.` }
  }
  try {
    const matches = parseRipgrepOutput(result.stdout, { count, filesWithMatches })
    if (matches.length > MAX_RESULT_LINES) {
      return { success: false, matches: [], command,
        error: `Search returned too many matches (${matches.length} > ${MAX_RESULT_LINES}). Narrow the pattern or search path.` }
    }
    const totalChars = matches.reduce((total, match) => total + (match.line?.length ?? match.file.length), 0)
    if (totalChars > maxOutputChars) {
      return { success: false, matches: [], command,
        error: `Search output too large (${totalChars} characters, limit is ${maxOutputChars}). Narrow the pattern or search path.` }
    }
    for (const match of matches) {
      if (match.line && match.line.length > MAX_LINE_LENGTH) {
        match.line = match.line.substring(0, MAX_LINE_LENGTH) + '... [truncated]'
      }
    }
    return { success: true, matches, command }
  } catch (error: any) {
    return { success: false, matches: [], command, error: `Failed to parse ripgrep output: ${error.message}` }
  }
}

function parseRipgrepOutput(
  output: string,
  flags: { count?: boolean; filesWithMatches?: boolean }
): Array<{
  file: string
  lineNumber?: number
  line?: string
  matchCount?: number
}> {
  const matches: Array<{
    file: string
    lineNumber?: number
    line?: string
    matchCount?: number
  }> = []

  if (!output.trim()) {
    return matches
  }

  // Handle --count mode (-c)
  if (flags.count) {
    const lines = output.trim().split('\n')
    for (const line of lines) {
      const match = line.trim().match(/^(.*):(\d+)$/)
      if (match) {
        matches.push({ file: match[1], matchCount: Number(match[2]) })
      }
    }
    return matches
  }

  // Handle --files-with-matches mode (-l)
  if (flags.filesWithMatches) {
    const lines = output.trim().split('\n')
    for (const line of lines) {
      if (line.trim()) {
        matches.push({ file: line.trim() })
      }
    }
    return matches
  }

  // Handle JSON mode (default)
  try {
    const lines = output.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const data = JSON.parse(line)
        if ((data.type === 'match' || data.type === 'context') && data.data) {
          const { path: filePath, lines: matchLines, line_number } = data.data
          const file = typeof filePath === 'string' ? filePath : filePath?.text || ''

          if (matchLines && matchLines.text) {
            matches.push({
              file,
              lineNumber: line_number,
              line: matchLines.text,
            })
          }
        }
      } catch (e) {
        // Skip invalid JSON lines
        continue
      }
    }
  } catch (error) {
    // Fallback to simple line parsing if JSON parsing fails
    const lines = output.trim().split('\n')
    for (const line of lines) {
      const match = line.match(/^(.+?):(\d+):(.*)$/)
      if (match) {
        matches.push({
          file: match[1],
          lineNumber: parseInt(match[2]),
          line: match[3],
        })
      }
    }
  }

  return matches
}

export default ripgrepSearch
