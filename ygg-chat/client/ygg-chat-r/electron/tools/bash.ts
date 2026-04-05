import { spawn } from 'child_process'
import path from 'path'
import { detectPathType, getWSLCommandArgs, isWindows, toWslPath } from '../utils/wslBridge.js'

const DEFAULT_MAX_OUTPUT_CHARS = 20000

type ShellMode = 'bash' | 'wsl' | 'powershell'

// Commands that return exit code 1 for "no matches" (not an error)
const EXIT_1_NO_MATCH_COMMANDS = ['grep', 'egrep', 'fgrep', 'diff', 'cmp', 'awk']

function getDefaultSuccessCodes(command: string): number[] {
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0]
  // Handle paths like /usr/bin/grep
  const basename = firstWord.split('/').pop() || firstWord

  if (EXIT_1_NO_MATCH_COMMANDS.includes(basename)) {
    return [0, 1]
  }
  return [0]
}

export interface BashOptions {
  /** Brief human-readable explanation of why this bash command is being run */
  description?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  maxOutputChars?: number
  /** Treat these exit codes as success instead of failure */
  successCodes?: number[]
}


export interface BashResult {
  success: boolean
  cwd: string
  stdout: string
  stderr: string
  error?: string
}

type CwdResolution = {
  display: string // what we return to the caller (windows stays windows)
  forSpawn?: string // what we pass to WSL/bash/powershell (converted when needed)
  shellMode: ShellMode
}

/**
 * Determine which shell to use based on platform and path type:
 * - Linux/Mac: always 'bash'
 * - Windows + Linux path (/home/...): 'wsl'
 * - Windows + Windows path (C:\...): 'powershell'
 */
function resolveCwd(inputCwd?: string): CwdResolution {
  const cwdCandidate = (inputCwd?.trim() || process.cwd()).trim()
  if (!cwdCandidate) {
    const fallback = process.cwd()
    return { display: fallback, forSpawn: fallback, shellMode: isWindows() ? 'powershell' : 'bash' }
  }

  if (!isWindows()) {
    // Linux/Mac: always use bash natively
    const posix = path.isAbsolute(cwdCandidate) ? cwdCandidate : path.resolve(cwdCandidate)
    return { display: posix, forSpawn: posix, shellMode: 'bash' }
  }

  // On Windows: determine shell based on path type
  const pathType = detectPathType(cwdCandidate)

  if (pathType === 'linux') {
    // Linux path on Windows → use WSL
    return { display: cwdCandidate, forSpawn: cwdCandidate, shellMode: 'wsl' }
  }

  // Windows path or relative path → use PowerShell natively
  const normalizedWin = path.win32.isAbsolute(cwdCandidate)
    ? path.win32.normalize(cwdCandidate)
    : path.win32.resolve(cwdCandidate)
  return { display: normalizedWin, forSpawn: normalizedWin, shellMode: 'powershell' }
}

async function buildCommand(
  command: string,
  spawnCwd?: string,
  shellMode: ShellMode = 'bash'
): Promise<{ cmd: string; args: string[]; displayCwd?: string }> {
  switch (shellMode) {
    case 'bash':
      // Native bash on Linux/Mac
      return { cmd: 'bash', args: ['-lc', command], displayCwd: spawnCwd }

    case 'wsl':
      // WSL bash on Windows for Linux paths
      const [wslCmd, wslArgs] = await getWSLCommandArgs('bash', ['-lc', command], spawnCwd)
      return { cmd: wslCmd, args: wslArgs, displayCwd: spawnCwd }

    case 'powershell':
      // Native PowerShell on Windows for Windows paths
      // Use -NoProfile for faster startup, -NonInteractive for non-interactive mode
      // -Command executes the command string
      return {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
        displayCwd: spawnCwd,
      }
  }
}

function filterStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !line.includes('screen size is bogus'))
    .join('\n')
}

function clampMaxOutput(max?: number): number {
  if (max === undefined || max === null) {
    return DEFAULT_MAX_OUTPUT_CHARS
  }
  if (Number.isNaN(max) || max <= 0) {
    return DEFAULT_MAX_OUTPUT_CHARS
  }
  return Math.min(200000, Math.floor(max))
}

export async function runBashCommand(command: string, options: BashOptions = {}): Promise<BashResult> {
  // const startTime = Date.now()
  const maxOutputChars = clampMaxOutput(options.maxOutputChars)
  const { display: displayCwd, forSpawn: spawnCwd, shellMode } = resolveCwd(options.cwd)

  const { cmd, args, displayCwd: resultCwd } = await buildCommand(command, spawnCwd, shellMode)

  const spawnOptions: { cwd?: string; env: NodeJS.ProcessEnv } = {
    env: {
      ...process.env,
      COLUMNS: '120',
      LINES: '24',
      ...(options.env || {}),
    },
  }

  // Set cwd for native shells (bash and powershell), WSL handles cwd via --cd flag
  if (shellMode === 'bash' || shellMode === 'powershell') {
    spawnOptions.cwd = spawnCwd
  }

  let stdout = ''
  let stderr = ''
  let remaining = maxOutputChars
  let timeoutHandle: NodeJS.Timeout | null = null
  let timedOut = false

  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    if (remaining <= 0) {
      return
    }

    const text = chunk.toString('utf8')
    const toTake = Math.min(remaining, text.length)
    if (target === 'stdout') {
      stdout += text.slice(0, toTake)
    } else {
      stderr += text.slice(0, toTake)
    }

    remaining -= toTake
  }

  return new Promise<BashResult>(resolve => {
    const child = spawn(cmd, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (options.input) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 300)
      }, options.timeoutMs)
    }

    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))

    const finalize = (result: BashResult) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      resolve(result)
    }

    child.on('error', error => {
      finalize({
        success: false,
        cwd: resultCwd ?? displayCwd,
        stdout,
        stderr: filterStderr(stderr),
        error: error instanceof Error ? error.message : String(error),
      })
    })

    child.on('close', (code) => {
      const successCodes = new Set(options.successCodes ?? getDefaultSuccessCodes(command))
      finalize({
        success: !timedOut && code !== null && successCodes.has(code),
        cwd: resultCwd ?? displayCwd,
        stdout,
        stderr: filterStderr(stderr),
      })
    })
  })
}
