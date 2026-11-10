import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { operationFingerprint } from '../headlessServer/persistence/operationReceiptRepo.js'
import type { IPty } from 'node-pty'
import { clampTerminalDimension, resolveTerminalLaunch } from './terminalLaunch.js'

interface TerminalRecord {
  owner: string; pty: IPty; cwd: string; shell: string; cols: number; rows: number
  seq: number; dropped: number; bytes: number; events: Array<{ seq: number; data: string }>
  exitCode?: number; signal?: number; lastSeen: number
}
/** Browser terminals are independent client-owned PTYs, never desktop mirrors. */
export class TerminalService {
  private sessions = new Map<string, TerminalRecord>()
  private pending = new Map<string, { promise: Promise<any>; fingerprint: string }>()
  private launching = 0
  private listeners = new Set<(owner: string, type: 'data' | 'exit', payload: any) => void>()
  subscribe(listener: (owner: string, type: 'data' | 'exit', payload: any) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private notify(owner: string, type: 'data' | 'exit', payload: any): void {
    for (const listener of this.listeners) { try { listener(owner, type, payload) } catch { /* A lost native view does not crash its host. */ } }
  }
  killOwner(owner: string): void { for (const [id, session] of this.sessions) if (session.owner === owner) this.kill(owner, id) }
  private accepting = true
  private timer = setInterval(() => {
    for (const [id, session] of this.sessions) if (this.leaseMs > 0 && Date.now() - session.lastSeen > this.leaseMs) this.kill(session.owner, id)
  }, 5000)
  constructor(private spawn = (...args: Parameters<typeof import('node-pty').spawn>) => {
    let binding: typeof import('node-pty')
    try { binding = createRequire(import.meta.url)('node-pty') } catch { throw new Error('Terminal capability unavailable on this host: native PTY binding could not load.') }
    return binding.spawn(...args)
  }, private leaseMs = 60000) {
    this.timer.unref?.()
  }
  create(owner: string, requestId: string, options: { cwd?: string; cols?: number; rows?: number; title?: string }) {
    const key = JSON.stringify([owner, requestId])
    const fingerprint = operationFingerprint(options)
    const existing = this.pending.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Terminal request ID already used for different options')
      return existing.promise
    }
    if (!this.accepting || this.sessions.size + this.launching >= 32 || this.pending.size >= 4096) throw new Error('Terminal capacity reached')
    this.launching++
    const promise = this.launch(owner, options).finally(() => {
      this.launching--
      if (!this.leaseMs) this.pending.delete(key) // IPC creates have no HTTP retry receipt lifetime.
    })
    this.pending.set(key, { promise, fingerprint })
    // Keep compact create receipts for retry safety; bounded capacity fails closed.
    return promise
  }
  private async launch(owner: string, options: { cwd?: string; cols?: number; rows?: number; title?: string }) {
    const launch = await resolveTerminalLaunch(options.cwd)
    if (!this.accepting) throw new Error('Host is shutting down')
    const cols = clampTerminalDimension(options.cols, 120, 20, 400)
    const rows = clampTerminalDimension(options.rows, 32, 5, 200)
    const pty = this.spawn(launch.file, launch.args, { name: 'xterm-256color', cols, rows, cwd: launch.spawnCwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, ...(process.platform === 'win32' ? { useConpty: true } : {}) })
    const sessionId = randomUUID()
    const session: TerminalRecord = { owner, pty, cwd: launch.displayCwd, shell: launch.shellLabel, cols, rows,
      seq: 0, dropped: 0, bytes: 0, events: [], lastSeen: Date.now() }
    this.sessions.set(sessionId, session)
    pty.onData(data => {
      this.notify(owner, 'data', { sessionId, data })
      session.events.push({ seq: ++session.seq, data }); session.bytes += Buffer.byteLength(data)
      while (session.bytes > 1024 * 1024 || session.events.length > 4096) {
        const dropped = session.events.shift()!
        session.dropped = dropped.seq; session.bytes -= Buffer.byteLength(dropped.data)
      }
    })
    pty.onExit(event => {
      session.exitCode = event.exitCode; session.signal = event.signal
      this.notify(owner, 'exit', { sessionId, ...event, cwd: session.cwd, shell: session.shell })
      if (!this.leaseMs) this.sessions.delete(sessionId)
    })
    return { success: true, sessionId, cwd: session.cwd, shell: session.shell, cols, rows, title: options.title || 'Terminal' }
  }
  private get(owner: string, id: string): TerminalRecord {
    const session = this.sessions.get(id)
    if (!session || session.owner !== owner) throw new Error('Terminal session unavailable')
    session.lastSeen = Date.now()
    return session
  }
  read(owner: string, id: string, after: number) {
    const session = this.get(owner, id)
    return { sessionId: id, events: session.events.filter(event => event.seq > after), cursor: session.seq,
      truncated: after < session.dropped || after > session.seq, exitCode: session.exitCode, signal: session.signal, cwd: session.cwd, shell: session.shell }
  }
  write(owner: string, id: string, data: string) { this.get(owner, id).pty.write(data) }
  resize(owner: string, id: string, cols: number, rows: number) {
    const session = this.get(owner, id)
    session.cols = clampTerminalDimension(cols, session.cols, 20, 400)
    session.rows = clampTerminalDimension(rows, session.rows, 5, 200)
    session.pty.resize(session.cols, session.rows)
  }
  kill(owner: string, id: string) {
    const session = this.sessions.get(id)
    if (!session || session.owner !== owner) return
    this.sessions.delete(id)
    try { session.pty.kill() } catch { /* Process already exited. */ }
  }
  shutdown() {
    this.accepting = false; clearInterval(this.timer)
    for (const [id, session] of this.sessions) this.kill(session.owner, id)
    this.pending.clear(); this.listeners.clear()
  }
}
