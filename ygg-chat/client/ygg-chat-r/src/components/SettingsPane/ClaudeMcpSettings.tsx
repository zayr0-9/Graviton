import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_HOST_CLAUDE_MCP, type ClaudeMcpServerView, type ClaudeMcpSignInResponse, type ClaudeMcpStatusResponse, type HostClaudeMcpPreferences,
} from '../../../../../shared/claudeNativeMcp'
import { getHostExecutionPreferences, getHostExecutionRevision, HOST_EXECUTION_CHANGED, refreshHostExecutionPreferences, saveHostExecutionPreference } from '../../services/hostExecutionClient'
import { localApi } from '../../utils/api'

const SIGN_IN_POLL_MS = 4_000
const SIGN_IN_WAIT_MS = 5 * 60_000

const STATUS_LABEL: Record<ClaudeMcpServerView['status'], string> = {
  connected: 'Connected', failed: 'Failed', 'needs-auth': 'Needs sign-in', pending: 'Connecting', disabled: 'Disabled in Claude Code',
}
const STATUS_CLASS: Record<ClaudeMcpServerView['status'], string> = {
  connected: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  'needs-auth': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  pending: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700/50 dark:text-neutral-300',
  disabled: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-700/50 dark:text-neutral-400',
}
const SOURCE_LABEL: Record<string, string> = {
  user: 'User', project: 'Project', local: 'Local', plugin: 'Plugin', claudeai: 'claude.ai', managed: 'Managed', enterprise: 'Enterprise', dynamic: 'Dynamic', agent: 'Agent',
}

const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback

async function openInBrowser(url: string) {
  const shell = (window as any).electronAPI?.shell
  if (shell?.openExternal) {
    const result = await shell.openExternal(url)
    if (result?.success !== false) return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Claude Code's own MCP servers in Claude chats: the host switch, which servers' tools the model
 * gets, and in-app sign-in through the installed CLI. Servers are defined in Claude Code
 * (`claude mcp add`, `.mcp.json`, plugins, claude.ai connectors), not here.
 */
export function ClaudeMcpSettings() {
  const [preferences, setPreferences] = useState<HostClaudeMcpPreferences>(() => getHostExecutionPreferences()?.claudeMcp ?? DEFAULT_HOST_CLAUDE_MCP)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<ClaudeMcpStatusResponse>()
  const [loading, setLoading] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [signIn, setSignIn] = useState<{ name: string; callbackExpected: boolean; callbackUrl: string; startedAt: number } | null>(null)
  const live = useRef(true)

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    setStatusError('')
    try {
      const next = await localApi.get<ClaudeMcpStatusResponse>('/headless/claude/mcp/status')
      if (live.current) setStatus(next)
      return next
    } catch (error) {
      if (live.current) setStatusError(errorText(error, 'Claude Code did not report its MCP servers.'))
      return undefined
    } finally {
      if (live.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    live.current = true
    const sync = () => setPreferences(getHostExecutionPreferences()?.claudeMcp ?? DEFAULT_HOST_CLAUDE_MCP)
    window.addEventListener(HOST_EXECUTION_CHANGED, sync)
    void refreshHostExecutionPreferences().then(sync).catch(() => { if (live.current) setMessage('Claude MCP settings are unavailable. Reload settings to retry.') })
    return () => { live.current = false; window.removeEventListener(HOST_EXECUTION_CHANGED, sync) }
  }, [])

  // Once per enable: a failed check shows its error and waits for Refresh, instead of retrying.
  const checked = useRef(false)
  useEffect(() => {
    if (!preferences.enabled) { checked.current = false; return }
    if (checked.current) return
    checked.current = true
    void refreshStatus()
  }, [preferences.enabled, refreshStatus])

  // A started sign-in finishes in the browser; poll until Claude reports the server connected.
  useEffect(() => {
    if (!signIn) return
    const timer = setInterval(async () => {
      if (Date.now() - signIn.startedAt > SIGN_IN_WAIT_MS) {
        setSignIn(null)
        setMessage(`Sign-in to ${signIn.name} did not finish. Start it again to retry.`)
        return
      }
      const next = await refreshStatus()
      if (next?.servers.find(server => server.name === signIn.name)?.status === 'connected') {
        setSignIn(null)
        setMessage(`${signIn.name} is connected. New Claude turns can use it.`)
      }
    }, SIGN_IN_POLL_MS)
    return () => clearInterval(timer)
  }, [signIn, refreshStatus])

  const save = async (patch: Partial<HostClaudeMcpPreferences>) => {
    const next = { ...preferences, ...patch }
    setSaving(true)
    setMessage('')
    try {
      await saveHostExecutionPreference({ claudeMcp: next }, getHostExecutionRevision('claudeMcp'))
      setPreferences(getHostExecutionPreferences()?.claudeMcp ?? next)
      return true
    } catch (error) {
      setMessage(errorText(error, 'Could not save Claude MCP settings.'))
      return false
    } finally { setSaving(false) }
  }

  const setServerUsed = async (name: string, used: boolean) => {
    const disabled = new Set(preferences.disabledServers)
    if (used) disabled.delete(name)
    else disabled.add(name)
    if (await save({ disabledServers: [...disabled] })) {
      setStatus(current => current && { ...current, servers: current.servers.map(server => server.name === name ? { ...server, hidden: !used } : server) })
    }
  }

  const startSignIn = async (name: string) => {
    setBusy(name)
    setMessage('')
    try {
      const result = await localApi.post<ClaudeMcpSignInResponse>('/headless/claude/mcp/sign-in', { name })
      setSignIn({ name, callbackExpected: result.callbackExpected, callbackUrl: '', startedAt: Date.now() })
      await openInBrowser(result.authUrl)
    } catch (error) { setMessage(errorText(error, `Could not start sign-in for ${name}.`)) }
    finally { setBusy(null) }
  }

  const submitCallback = async () => {
    if (!signIn?.callbackUrl.trim()) return
    setBusy(signIn.name)
    try {
      await localApi.post('/headless/claude/mcp/sign-in/callback', { name: signIn.name, callbackUrl: signIn.callbackUrl.trim() })
      setMessage('Callback sent to Claude. Waiting for the server to connect…')
    } catch (error) { setMessage(errorText(error, 'Claude did not accept the callback address.')) }
    finally { setBusy(null) }
  }

  const runAction = async (name: string, action: 'reconnect' | 'sign-out') => {
    setBusy(name)
    setMessage('')
    try {
      await localApi.post(`/headless/claude/mcp/${action}`, { name })
      await refreshStatus()
      if (action === 'sign-out') setMessage(`Signed out of ${name} in Claude Code.`)
    } catch (error) { setMessage(errorText(error, `Could not ${action === 'reconnect' ? 'reconnect' : 'sign out of'} ${name}.`)) }
    finally { setBusy(null) }
  }

  const pill = 'rounded-full px-2 py-0.5 text-[11px] font-medium'
  const button = 'rounded-lg border border-neutral-300 px-2 py-1 text-xs transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800'
  const servers = status?.servers ?? []
  const used = servers.filter(server => !server.hidden && server.status === 'connected').length

  return <div className='mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-700'>
    <div>
      <h4 className='text-sm font-medium text-stone-700 dark:text-stone-200'>Claude Code MCP servers</h4>
      <p className='mt-1 text-xs text-neutral-500 dark:text-neutral-400'>
        For Claude Code chats only. Claude loads the servers you set up in Claude Code (<code>claude mcp add</code>, a project's <code>.mcp.json</code>, plugins, claude.ai connectors). The servers above are Graviton's and are not passed to Claude yet.
      </p>
    </div>

    <label className='flex items-start gap-3 text-sm'>
      <input type='checkbox' className='mt-1' aria-label="Use Claude Code's MCP servers" checked={preferences.enabled} disabled={saving}
        onChange={event => void save({ enabled: event.target.checked })} />
      <span>
        <span className='font-medium text-neutral-700 dark:text-neutral-200'>Use Claude Code's MCP servers in Claude chats</span>
        <span className='block text-xs text-neutral-500 dark:text-neutral-400'>Applies to new Claude turns. Tool calls still go through Graviton's approval prompts.</span>
      </span>
    </label>

    {preferences.enabled && <>
      <label className='flex items-start gap-3 text-sm'>
        <input type='checkbox' className='mt-1' aria-label='Include claude.ai connectors' checked={preferences.claudeAiConnectors} disabled={saving}
          onChange={event => { void save({ claudeAiConnectors: event.target.checked }).then(ok => { if (ok) void refreshStatus() }) }} />
        <span>
          <span className='font-medium text-neutral-700 dark:text-neutral-200'>Include claude.ai connectors</span>
          <span className='block text-xs text-neutral-500 dark:text-neutral-400'>The connectors on your Claude account. Each one connects at the start of every Claude turn.</span>
        </span>
      </label>

      <div className='flex flex-wrap items-center gap-2'>
        <button type='button' className={button} onClick={() => void refreshStatus()} disabled={loading}>{loading ? 'Checking…' : 'Refresh status'}</button>
        {status && <span className='text-xs text-neutral-500 dark:text-neutral-400'>{used} in use · {servers.length} found{status.cwd ? ` (read from ${status.cwd})` : ''}</span>}
      </div>

      {statusError && <p role='alert' className='text-xs text-red-600 dark:text-red-400'>{statusError}</p>}

      {signIn && <div className='space-y-2 rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-xs dark:border-amber-500/40 dark:bg-amber-500/10'>
        <p className='text-neutral-700 dark:text-neutral-200'>Finish signing in to <strong>{signIn.name}</strong> in your browser. This updates when Claude reports it connected.</p>
        {signIn.callbackExpected && <div className='flex flex-wrap items-center gap-2'>
          <input aria-label='Callback address' className='min-w-0 flex-1 rounded-lg border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-600'
            placeholder='If the browser shows an error page after sign-in, paste its address here'
            value={signIn.callbackUrl} onChange={event => setSignIn(current => current && { ...current, callbackUrl: event.target.value })} />
          <button type='button' className={button} onClick={() => void submitCallback()} disabled={!signIn.callbackUrl.trim() || busy === signIn.name}>Send</button>
        </div>}
        <button type='button' className={button} onClick={() => setSignIn(null)}>Stop waiting</button>
      </div>}

      {servers.length > 0 && <ul className='space-y-2'>
        {servers.map(server => <li key={server.name} className='rounded-xl border border-neutral-200 p-2.5 dark:border-neutral-700'>
          <div className='flex flex-wrap items-center gap-2'>
            <input type='checkbox' aria-label={`Use ${server.name} in Claude chats`} checked={!server.hidden} disabled={saving}
              onChange={event => void setServerUsed(server.name, event.target.checked)} />
            <span className='min-w-0 break-all text-sm font-medium text-neutral-700 dark:text-neutral-200'>{server.name}</span>
            <span className={`${pill} ${STATUS_CLASS[server.status]}`}>{STATUS_LABEL[server.status]}</span>
            {server.source && <span className={`${pill} bg-neutral-100 text-neutral-600 dark:bg-neutral-700/50 dark:text-neutral-300`}>{SOURCE_LABEL[server.source] ?? server.source}</span>}
            {server.status === 'connected' && <span className='text-xs text-neutral-500 dark:text-neutral-400'>{server.tools.length} tool{server.tools.length === 1 ? '' : 's'}</span>}
            <span className='ml-auto flex gap-1.5'>
              {server.status === 'needs-auth' && status?.signInAvailable && <button type='button' className={button} disabled={busy === server.name}
                onClick={() => void startSignIn(server.name)}>Sign in</button>}
              {server.status === 'failed' && <button type='button' className={button} disabled={busy === server.name}
                onClick={() => void runAction(server.name, 'reconnect')}>Reconnect</button>}
              {server.status === 'connected' && server.transport !== 'stdio' && status?.signInAvailable && <button type='button' className={button} disabled={busy === server.name}
                onClick={() => void runAction(server.name, 'sign-out')}>Sign out</button>}
            </span>
          </div>
          {server.error && <p className='mt-1 break-words text-xs text-red-600 dark:text-red-400'>{server.error}</p>}
          {server.status === 'needs-auth' && !status?.signInAvailable && <p className='mt-1 text-xs text-neutral-500 dark:text-neutral-400'>
            Run <code>claude mcp login "{server.name}"</code> in a terminal to sign in.</p>}
          {server.status === 'disabled' && <p className='mt-1 text-xs text-neutral-500 dark:text-neutral-400'>Turned off in Claude Code. Enable it with <code>/mcp</code> in Claude Code.</p>}
        </li>)}
      </ul>}

      {status && servers.length === 0 && !loading && <p className='text-xs text-neutral-500 dark:text-neutral-400'>Claude Code has no MCP servers. Add one with <code>claude mcp add</code>.</p>}

      <p className='text-xs text-neutral-500 dark:text-neutral-400'>
        Unchecking a server hides its tools from Claude in Graviton only; Claude still connects to it, and the terminal CLI is unaffected. A project's <code>.mcp.json</code> servers appear only in chats using that folder, and only after you approve them in Claude Code. A stdio server that needs extra environment variables may fail here: Claude gets a reduced environment.
      </p>
    </>}

    {message && <p role='status' className='text-xs text-neutral-600 dark:text-neutral-300'>{message}</p>}
  </div>
}
