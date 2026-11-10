import { TerminalCommandQueue } from './terminalCommandQueue'
const inputQueue = new TerminalCommandQueue()
import { getClientId, newClientId } from '../helpers/clientId'
import { buildLocalApiUrl } from '../utils/api'
import { isBrowserClient } from './clientCapabilities'

type TerminalApi = NonNullable<Window['electronAPI']>['terminal']
const dataListeners = new Set<Parameters<TerminalApi['onData']>[0]>()
const exitListeners = new Set<Parameters<TerminalApi['onExit']>[0]>()
const sessions = new Map<string, { cursor: number; timer?: ReturnType<typeof setTimeout> }>()

async function command(action: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(await buildLocalApiUrl(`/terminal/${action}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, clientId: getClientId() }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Terminal command failed')
  return result
}
function observe(sessionId: string) {
  const state = { cursor: 0 } as { cursor: number; timer?: ReturnType<typeof setTimeout> }
  sessions.set(sessionId, state)
  const poll = async () => {
    let delay = 100
    try {
      const response = await fetch(await buildLocalApiUrl(`/terminal/${encodeURIComponent(sessionId)}?clientId=${encodeURIComponent(getClientId())}&after=${state.cursor}`), { cache: 'no-store' })
      if (response.status === 404) {
        for (const listener of exitListeners) listener({ sessionId, exitCode: null })
        sessions.delete(sessionId); return
      }
      if (!response.ok) throw new Error('Terminal disconnected')
      const result = await response.json()
      if (sessions.get(sessionId) !== state) return
      if (result.truncated) for (const listener of dataListeners) listener({ sessionId, data: '\r\n[Earlier terminal output is no longer retained]\r\n' })
      for (const event of result.events ?? []) if (event.seq > state.cursor) {
        for (const listener of dataListeners) listener({ sessionId, data: event.data })
        state.cursor = event.seq
      }
      state.cursor = Math.max(state.cursor, Number(result.cursor) || 0)
      if (typeof result.exitCode === 'number') {
        for (const listener of exitListeners) listener({ sessionId, exitCode: result.exitCode, signal: result.signal, cwd: result.cwd, shell: result.shell })
        sessions.delete(sessionId); return
      }
    } catch { delay = 1000 }
    if (sessions.get(sessionId) === state && (dataListeners.size || exitListeners.size)) state.timer = setTimeout(poll, delay)
    else sessions.delete(sessionId) // The host lease reclaims an abandoned view's PTY.
  }
  state.timer = setTimeout(poll, 0)
}
const browserTerminal: TerminalApi = {
  create: async options => {
    const request = { ...options, requestId: newClientId() }
    let result
    try { result = await command('create', request) }
    catch { result = await command('create', request) } // Recover a lost acknowledgement using the same host receipt.
    if (result.sessionId && !sessions.has(result.sessionId)) observe(result.sessionId)
    return result
  },
  write: (sessionId, data) => inputQueue.run(sessionId, () => command(`${encodeURIComponent(sessionId)}/write`, { data })),
  resize: (sessionId, cols, rows) => inputQueue.run(sessionId, () => command(`${encodeURIComponent(sessionId)}/resize`, { cols, rows })),
  kill: async sessionId => {
    inputQueue.close(sessionId)
    const result = await command(`${encodeURIComponent(sessionId)}/kill`, {})
    clearTimeout(sessions.get(sessionId)?.timer); sessions.delete(sessionId)
    return result
  },
  onData: callback => { dataListeners.add(callback); return () => { dataListeners.delete(callback) } },
  onExit: callback => { exitListeners.add(callback); return () => { exitListeners.delete(callback) } },
}
export const getTerminalClient = (): TerminalApi | undefined => isBrowserClient ? browserTerminal : window.electronAPI?.terminal
