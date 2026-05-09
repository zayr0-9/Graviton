import { spawn } from 'child_process'
import path from 'path'
import { detectPathType, isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'

const DEFAULT_MAX_OUTPUT_CHARS = 20000

export interface PowerShellOptions {
  /** Brief human-readable explanation of why this PowerShell command is being run */
  description?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  maxOutputChars?: number
  /** Treat these exit codes as success instead of failure */
  successCodes?: number[]
}

export interface PowerShellResult {
  success: boolean
  cwd: string
  stdout: string
  stderr: string
  error?: string
}

type PowerShellCwdResolution = {
  display: string
  forSpawn: string
}

/**
 * Resolve a cwd for native PowerShell execution.
 *
 * On Windows, Windows/relative paths are resolved with win32 semantics. If a WSL
 * path is supplied, try to convert it to the matching \\wsl$ UNC path so native
 * PowerShell can use it as a working directory.
 */
export async function resolvePowerShellCwd(inputCwd?: string): Promise<PowerShellCwdResolution> {
  const cwdCandidate = (inputCwd?.trim() || process.cwd()).trim()
  const fallback = cwdCandidate || process.cwd()

  if (!isWindows()) {
    const posix = path.isAbsolute(fallback) ? fallback : path.resolve(fallback)
    return { display: posix, forSpawn: posix }
  }

  const pathType = detectPathType(fallback)
  if (pathType === 'linux') {
    const windowsPath = await resolveToWindowsPath(fallback)
    return { display: windowsPath, forSpawn: windowsPath }
  }

  const normalizedWin = path.win32.isAbsolute(fallback)
    ? path.win32.normalize(fallback)
    : path.win32.resolve(fallback)

  return { display: normalizedWin, forSpawn: normalizedWin }
}

export function buildPowerShellCommand(command: string): { cmd: string; args: string[] } {
  return {
    cmd: isWindows() ? 'powershell.exe' : 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
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

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return

  if (isWindows()) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => {
      child.kill('SIGKILL')
    })
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export async function runPowerShellCommand(
  command: string,
  options: PowerShellOptions = {}
): Promise<PowerShellResult> {
  const maxOutputChars = clampMaxOutput(options.maxOutputChars)
  const { display: displayCwd, forSpawn: spawnCwd } = await resolvePowerShellCwd(options.cwd)
  const { cmd, args } = buildPowerShellCommand(command)

  const spawnOptions: { cwd: string; env: NodeJS.ProcessEnv } = {
    cwd: spawnCwd,
    env: {
      ...process.env,
      COLUMNS: '120',
      LINES: '24',
      ...(options.env || {}),
    },
  }

  let stdout = ''
  let stderr = ''
  let remaining = maxOutputChars
  let timeoutHandle: NodeJS.Timeout | null = null
  let timedOut = false
  let truncated = false

  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    if (remaining <= 0) {
      truncated = true
      return
    }

    const text = chunk.toString('utf8')
    const toTake = Math.min(remaining, text.length)
    if (toTake < text.length) {
      truncated = true
    }

    if (target === 'stdout') {
      stdout += text.slice(0, toTake)
    } else {
      stderr += text.slice(0, toTake)
    }

    remaining -= toTake
  }

  return new Promise<PowerShellResult>(resolve => {
    const child = spawn(cmd, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows(),
      windowsHide: true,
    })

    if (options.input) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        setTimeout(() => child.kill('SIGKILL'), 300)
      }, options.timeoutMs)
    }

    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))

    const finalize = (result: PowerShellResult) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      resolve(result)
    }

    child.on('error', error => {
      const filteredStderr = filterStderr(stderr)
      finalize({
        success: false,
        cwd: displayCwd,
        stdout,
        stderr: truncated ? `${filteredStderr}\n[Output truncated at ${maxOutputChars} characters]` : filteredStderr,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    child.on('close', code => {
      const successCodes = new Set(options.successCodes ?? [0])
      const filteredStderr = filterStderr(stderr)
      finalize({
        success: !timedOut && code !== null && successCodes.has(code),
        cwd: displayCwd,
        stdout,
        stderr: truncated ? `${filteredStderr}\n[Output truncated at ${maxOutputChars} characters]` : filteredStderr,
        error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
      })
    })
  })
}
