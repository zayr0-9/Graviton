import { spawn } from 'child_process'
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
  command?: string
}

let windowsNativeRgPathPromise: Promise<string | null> | null = null

async function detectWindowsNativeRgPath(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }

  if (!windowsNativeRgPathPromise) {
    windowsNativeRgPathPromise = new Promise(resolve => {
      const child = spawn('where.exe', ['rg.exe'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })

      let stdout = ''

      child.stdout.on('data', data => {
        stdout += data.toString('utf8')
      })

      child.on('error', () => {
        resolve(null)
      })

      child.on('close', code => {
        if (code !== 0) {
          resolve(null)
          return
        }

        const firstPath = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(Boolean)

        resolve(firstPath || null)
      })
    })
  }

  return windowsNativeRgPathPromise
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
  const pathType = detectPathType(normalizedSearchPath)
  const windowsNativeRgPath = await detectWindowsNativeRgPath()

  const canUseNativeWindowsRg =
    process.platform === 'win32' &&
    Boolean(windowsNativeRgPath) &&
    (pathType === 'relative' || pathType === 'windows')

  const useWSL = shouldUseWSL() && !canUseNativeWindowsRg
  const resolvedPath = resolveSearchPath(normalizedSearchPath, useWSL)
  const nativeShellPath = useWSL ? null : await getNativeShellPath()

  // Build rg command arguments
  const args: string[] = []

  // Pattern (must be first non-option argument)
  args.push(pattern)

  // Path to search (already resolved/converted)
  args.push(resolvedPath)

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

  let cmd = 'rg'
  let cmdArgs = args

  if (useWSL) {
    // Use getWSLCommandArgs to run rg through WSL
    const wsl = await getWSLCommandArgs('rg', args)
    cmd = wsl[0]
    cmdArgs = wsl[1]
  } else if (canUseNativeWindowsRg && windowsNativeRgPath) {
    // Prefer native Windows rg when available (faster than WSL /mnt bridge)
    cmd = windowsNativeRgPath
    cmdArgs = args
  }

  return new Promise(resolve => {
    const command = `${cmd} ${cmdArgs.join(' ')}`
    const child = spawn(cmd, cmdArgs, {
      env: nativeShellPath ? { ...process.env, PATH: nativeShellPath } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', data => {
      stdout += data.toString('utf8')
    })

    child.stderr.on('data', data => {
      stderr += data.toString('utf8')
    })

    child.on('error', error => {
      resolve({
        success: false,
        matches: [],
        error: `Failed to execute ripgrep: ${error.message}. Make sure ripgrep (rg) is installed and in your PATH.`,
        command,
      })
    })

    child.on('close', code => {
      // rg returns 0 when matches found, 1 when no matches, 2 for error
      if (code === 2 && stderr) {
        resolve({
          success: false,
          matches: [],
          error: `ripgrep error: ${stderr.trim()}`,
          command,
        })
        return
      }

      try {
        const matches = parseRipgrepOutput(stdout, {
          count,
          filesWithMatches,
        })

        // Multi-layered limit checks

        // Check 1: Number of match objects
        if (matches.length > MAX_RESULT_LINES) {
          resolve({
            success: false,
            matches: [],
            error: `Search returned too many matches (${matches.length} matches, limit is ${MAX_RESULT_LINES}). Please narrow your search by: (1) using a more specific pattern, (2) adding a glob filter (e.g., '*.ts'), (3) reducing the search path, or (4) using maxCount to limit matches per file.`,
            command,
          })
          return
        }

        // Check 2: Total character count across all match content
        let totalChars = 0
        for (const match of matches) {
          if (match.line) {
            totalChars += match.line.length
          }
        }

        if (totalChars > maxOutputChars) {
          resolve({
            success: false,
            matches: [],
            error: `Search output too large (${totalChars} characters, limit is ${maxOutputChars}). Please narrow your search by: (1) using a more specific pattern, (2) adding a glob filter (e.g., '*.ts'), (3) reducing the search path, or (4) using maxCount to limit matches per file.`,
            command,
          })
          return
        }

        // Check 3: Truncate individual lines that are too long
        for (const match of matches) {
          if (match.line && match.line.length > MAX_LINE_LENGTH) {
            match.line = match.line.substring(0, MAX_LINE_LENGTH) + '... [truncated]'
          }
        }

        resolve({
          success: true,
          matches,
          command,
        })
      } catch (parseError: any) {
        resolve({
          success: false,
          matches: [],
          error: `Failed to parse ripgrep output: ${parseError.message}`,
          command,
        })
      }
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1000)
    }, 30000)
  })
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
      const parts = line.trim().split(':')
      if (parts.length >= 2) {
        matches.push({
          file: parts[0],
          matchCount: parseInt(parts[1]) || 0,
        })
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
        if (data.type === 'match' && data.data) {
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
