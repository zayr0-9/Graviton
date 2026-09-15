import { spawn, type ChildProcess } from 'child_process'
import { normalizeShellTimeoutMs, SHELL_CLEANUP_GRACE_MS } from './shellExecutionPolicy.js'

export interface ShellRunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Epoch deadline at which execution must stop (cleanup follows). */
  deadlineMs?: number
  maxOutputChars?: number
  successCodes?: number[]
}
export interface ShellRunResult {
  success: boolean
  cwd: string
  stdout: string
  stderr: string
  error?: string
  timedOut?: boolean
  cancelled?: boolean
}
export interface ShellPreparationContext { signal: AbortSignal; deadlineMs: number }
export interface PreparedShell {
  cmd: string
  args: string[]
  cwd?: string
  displayCwd?: string
  /** WSL only: Linux group identity is reported by a setsid wrapper. */
  wsl?: { distro: string; marker: string }
}

/** Runs cleanup helpers without ever waiting for their close event. */
function boundedHelper(cmd: string, args: string[], onFailure: () => void = () => {}): () => void {
  let helper: ChildProcess | undefined
  let timer: NodeJS.Timeout | undefined
  let done = false
  const dispose = () => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    try { helper?.kill('SIGKILL') } catch { /* best effort */ }
    helper?.unref()
    onFailure()
  }
  try {
    helper = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    // Keep this listener after disposal to absorb late spawn errors.
    helper.on('error', dispose)
    helper.once('close', code => {
      if (done) return
      if (code !== 0) { dispose(); return }
      done = true
      if (timer) clearTimeout(timer)
      helper?.unref()
    })
    timer = setTimeout(dispose, SHELL_CLEANUP_GRACE_MS)
  } catch { dispose() }
  return dispose
}

/** One deadline covers asynchronous preparation and execution; close is never required to settle. */
export function runBoundedShell(
  prepare: (context: ShellPreparationContext) => Promise<PreparedShell>,
  options: ShellRunOptions = {},
  truncationNotice = false
): Promise<ShellRunResult> {
  const timeoutMs = normalizeShellTimeoutMs(options.timeoutMs)
  const deadlineMs = Math.min(Date.now() + timeoutMs,
    Number.isFinite(options.deadlineMs) ? options.deadlineMs! : Infinity)
  const controller = new AbortController()
  const max = typeof options.maxOutputChars === 'number' && options.maxOutputChars > 0 && !Number.isNaN(options.maxOutputChars)
    ? Math.max(1, Math.min(200000, Math.floor(options.maxOutputChars))) : 20000
  return new Promise(resolve => {
    let child: ChildProcess | undefined
    let prepared: PreparedShell | undefined
    let groupPid: number | undefined
    let stdout = '', stderr = '', markerBuffer = ''
    let remaining = max, truncated = false, settled = false
    let stopReason: 'timedOut' | 'cancelled' | undefined
    let failure: string | undefined
    let grace: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    const helpers: Array<() => void> = []
    const append = (target: 'stdout' | 'stderr', text: string) => {
      if (settled) return
      const taken = text.slice(0, remaining)
      truncated ||= text.length > remaining
      remaining -= taken.length
      if (target === 'stdout') stdout += taken
      else stderr += taken
    }
    const onStdout = (chunk: Buffer) => append('stdout', chunk.toString('utf8'))
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (!prepared?.wsl || groupPid) { append('stderr', text); return }
      markerBuffer += text
      const escapedMarker = prepared.wsl.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = markerBuffer.match(new RegExp(`${escapedMarker}(\\d+)\\r?\\n`))
      const reportedPid = match ? Number(match[1]) : undefined
      if (match && Number.isSafeInteger(reportedPid) && reportedPid! > 1 && reportedPid! <= 2147483647) {
        groupPid = reportedPid
        append('stderr', markerBuffer.replace(match[0], ''))
        markerBuffer = ''
        if (stopReason) terminate('SIGTERM')
      } else if (markerBuffer.length > 4096) {
        append('stderr', markerBuffer.slice(0, -256))
        markerBuffer = markerBuffer.slice(-256)
      }
    }
    const terminate = (signal: 'SIGTERM' | 'SIGKILL') => {
      if (!child?.pid) return
      if (prepared?.wsl && groupPid) {
        helpers.push(boundedHelper('wsl.exe', ['-d', prepared.wsl.distro, '-e', '/bin/kill',
          signal === 'SIGTERM' ? '-TERM' : '-KILL', '--', `-${groupPid}`]))
      }
      if (process.platform === 'win32') {
        // Keep the WSL bridge alive during TERM so it can report the Linux group.
        if (!prepared?.wsl || signal === 'SIGKILL') {
          const target = child
          helpers.push(boundedHelper('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], () => {
            try { target.kill('SIGKILL') } catch { /* taskkill unavailable; best effort */ }
          }))
        }
      } else {
        try { process.kill(-child.pid, signal) } catch {
          try { child.kill(signal) } catch { /* already gone */ }
        }
      }
    }
    const finish = (code: number | null = null) => {
      if (settled) return
      append('stderr', markerBuffer)
      settled = true
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      options.signal?.removeEventListener('abort', onAbort)
      controller.abort()
      child?.stdout?.removeListener('data', onStdout)
      child?.stderr?.removeListener('data', onStderr)
      child?.removeListener('close', onClose)
      // Keep inert error sinks: late spawn/stream errors must not become uncaught exceptions.
      child?.removeListener('error', onError)
      child?.on('error', ignoreError)
      child?.stdin?.removeListener('error', onStreamError)
      child?.stdout?.removeListener('error', onStreamError)
      child?.stderr?.removeListener('error', onStreamError)
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        stream?.on('error', ignoreError)
        stream?.destroy()
      }
      child?.unref()
      const filtered = stderr.split('\n').filter(line => !line.includes('screen size is bogus')).join('\n')
      let error = failure || (stopReason === 'cancelled' ? 'Command cancelled' : stopReason ? `Command timed out after ${timeoutMs}ms (execution deadline reached)` : undefined)
      if (stopReason && prepared?.wsl) error += '; WSL group cleanup is best effort (requires a responsive distro and setsid); detached descendants may survive'
      resolve({ success: !stopReason && !failure && code !== null && (options.successCodes ?? [0]).includes(code),
        cwd: prepared?.displayCwd ?? prepared?.cwd ?? options.cwd ?? process.cwd(), stdout,
        stderr: truncationNotice && truncated ? `${filtered}\n[Output truncated at ${max} characters]` : filtered,
        ...(error ? { error } : {}), ...(stopReason ? { [stopReason]: true } : {}) })
    }
    const stop = (reason: 'timedOut' | 'cancelled') => {
      if (settled || stopReason) return
      stopReason = reason
      controller.abort()
      if (!child) { finish(); return }
      terminate('SIGTERM')
      grace = setTimeout(() => {
        // Do not cancel this escalation when the leader closes: descendants may remain.
        for (const dispose of helpers.splice(0)) dispose()
        terminate('SIGKILL')
        finish()
      }, SHELL_CLEANUP_GRACE_MS)
    }
    const onAbort = () => stop('cancelled')
    const ignoreError = () => {}
    const onError = (error: Error) => { if (!settled && !stopReason) { failure = error.message; finish() } }
    const onStreamError = (error: Error & { code?: string }) => {
      if (error.code === 'EPIPE' || settled || stopReason) return
      failure = error.message
      stop('cancelled')
    }
    const onClose = (code: number | null) => { if (!stopReason) finish(code) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) { stop('cancelled'); return }
    if (deadlineMs <= Date.now()) { stop('timedOut'); return }
    timer = setTimeout(() => stop('timedOut'), Math.max(1, deadlineMs - Date.now()))
    Promise.resolve().then(() => {
      if (settled) return undefined
      return prepare({ signal: controller.signal, deadlineMs })
    }).then(value => {
      if (settled || stopReason || !value) return
      if (Date.now() >= deadlineMs) { stop('timedOut'); return }
      prepared = value
      try {
        child = spawn(value.cmd, value.args, { cwd: value.cwd,
          env: { ...process.env, COLUMNS: '120', LINES: '24', ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
        child.on('error', onError)
        child.on('close', onClose)
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', onStdout)
        child.stderr?.on('data', onStderr)
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', onStreamError)
        child.stdin?.end(options.input)
      } catch (error) { onError(error instanceof Error ? error : new Error(String(error))) }
    }, error => onError(error instanceof Error ? error : new Error(String(error))))
  })
}
