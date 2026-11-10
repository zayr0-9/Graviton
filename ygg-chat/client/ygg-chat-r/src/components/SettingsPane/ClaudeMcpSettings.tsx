import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  DEFAULT_HOST_CLAUDE_MCP, type ClaudeMcpServerView, type ClaudeMcpSignInResponse, type ClaudeMcpStatusResponse, type HostClaudeMcpPreferences,
} from '../../../../../shared/claudeNativeMcp'
import { getHostExecutionPreferences, getHostExecutionRevision, HOST_EXECUTION_CHANGED, refreshHostExecutionPreferences, saveHostExecutionPreference } from '../../services/hostExecutionClient'
import { localApi } from '../../utils/api'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode, type ThemeColorPair } from '../ThemeManager/themeConfig'
import { useSettingsSectionThemeColors } from './settingsSectionTheme'
import './claudeMcpSettings.css'

const SIGN_IN_POLL_MS = 4_000
const SIGN_IN_WAIT_MS = 5 * 60_000

const STATUS_LABEL: Record<ClaudeMcpServerView['status'], string> = {
  connected: 'Connected', failed: 'Failed', 'needs-auth': 'Needs sign-in', pending: 'Connecting', disabled: 'Disabled in Claude Code',
}
const SOURCE_LABEL: Record<string, string> = {
  user: 'User', project: 'Project', local: 'Local', plugin: 'Plugin', claudeai: 'claude.ai', managed: 'Managed', enterprise: 'Enterprise', dynamic: 'Dynamic', agent: 'Agent',
}

/**
 * The panel's palette from the custom theme (agent_design.md): settings card tokens for rows,
 * buttons and badges, tool-jobs tokens for text and status pills, the composer's active colour
 * for switches. Without a custom theme, claudeMcpSettings.css supplies light and dark defaults.
 */
function useClaudeMcpThemeStyle(): CSSProperties | undefined {
  const colors = useSettingsSectionThemeColors()
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  if (!colors || !enabled) return undefined
  const color = (pair: ThemeColorPair) => getThemeModeColor(pair, isDarkMode)
  const tokens = theme.colors
  return {
    '--cmcp-text': color(tokens.toolJobsPrimaryText),
    '--cmcp-muted': color(tokens.toolJobsMutedText),
    '--cmcp-surface': colors.innerCardBg,
    '--cmcp-button-bg': colors.buttonBg,
    '--cmcp-button-text': colors.buttonText,
    '--cmcp-badge-bg': colors.badgeBg,
    '--cmcp-badge-text': colors.badgeText,
    '--cmcp-accent': color(tokens.composerToggleActiveText),
    '--cmcp-switch-off': `color-mix(in srgb, ${color(tokens.toolJobsMutedText)} 30%, ${colors.innerCardBg})`,
    '--cmcp-thumb': colors.buttonText,
    '--cmcp-thumb-on': colors.buttonBg,
    '--cmcp-error': color(tokens.toolJobsErrorText),
    '--cmcp-ok-bg': color(tokens.toolJobsStatusCompletedBg),
    '--cmcp-ok-text': color(tokens.toolJobsStatusCompletedText),
    '--cmcp-failed-bg': color(tokens.toolJobsStatusFailedBg),
    '--cmcp-failed-text': color(tokens.toolJobsStatusFailedText),
    '--cmcp-auth-bg': color(tokens.toolJobsStatusPendingBg),
    '--cmcp-auth-text': color(tokens.toolJobsStatusPendingText),
    '--cmcp-pending-bg': color(tokens.toolJobsStatusRunningBg),
    '--cmcp-pending-text': color(tokens.toolJobsStatusRunningText),
    '--cmcp-off-bg': color(tokens.toolJobsStatusCancelledBg),
    '--cmcp-off-text': color(tokens.toolJobsStatusCancelledText),
  } as CSSProperties
}

/** A themed switch (same track and thumb as the tool rows). */
function switchButton(label: string, checked: boolean, disabled: boolean, onToggle: () => void) {
  return <button type='button' role='switch' className='claude-mcp-switch' aria-label={label} title={label} aria-checked={checked} disabled={disabled} onClick={onToggle}>
    <span className='claude-mcp-switch-track' aria-hidden='true'><span /></span>
  </button>
}

function settingRow(control: ReactNode, title: string, description: string) {
  return <div className='flex items-start gap-2'>
    {control}
    <div className='pt-2'>
      <p className='text-sm font-medium'>{title}</p>
      <p className='claude-mcp-muted text-xs'>{description}</p>
    </div>
  </div>
}

/**
 * The servers to show: alphabetical by name (case-insensitive, numbers in order), filtered by a
 * query matched against the name, source, status and tool names.
 */
export function visibleClaudeMcpServers(servers: ClaudeMcpServerView[], query: string): ClaudeMcpServerView[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (server: ClaudeMcpServerView) => {
    if (!terms.length) return true
    const haystack = [server.name, server.source ?? '', SOURCE_LABEL[server.source ?? ''] ?? '', STATUS_LABEL[server.status], ...server.tools].join(' ').toLowerCase()
    return terms.every(term => haystack.includes(term))
  }
  return servers.filter(matches).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
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
  const [query, setQuery] = useState('')
  const live = useRef(true)
  const themeStyle = useClaudeMcpThemeStyle()

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

  const servers = status?.servers ?? []
  const used = servers.filter(server => !server.hidden && server.status === 'connected').length
  const shown = visibleClaudeMcpServers(servers, query)

  return <div className='claude-mcp mt-4 space-y-3 pt-2' style={themeStyle}>
    <div>
      <h4 className='text-sm font-medium'>Claude Code MCP servers</h4>
      <p className='claude-mcp-muted mt-1 text-xs'>
        For Claude Code chats only. Claude loads the servers you set up in Claude Code (<code>claude mcp add</code>, a project's <code>.mcp.json</code>, plugins, claude.ai connectors). The servers above are Graviton's and are not passed to Claude yet.
      </p>
    </div>

    {settingRow(switchButton("Use Claude Code's MCP servers", preferences.enabled, saving, () => void save({ enabled: !preferences.enabled })),
      "Use Claude Code's MCP servers in Claude chats", "Applies to new Claude turns. Tool calls still go through Graviton's approval prompts.")}

    {preferences.enabled && <>
      {settingRow(switchButton('Include claude.ai connectors', preferences.claudeAiConnectors, saving,
        () => void save({ claudeAiConnectors: !preferences.claudeAiConnectors }).then(ok => { if (ok) void refreshStatus() })),
        'Include claude.ai connectors', 'The connectors on your Claude account. Each one connects when a Claude session starts.')}

      <div className='flex flex-wrap items-center gap-2'>
        <button type='button' className='claude-mcp-button' onClick={() => void refreshStatus()} disabled={loading}>{loading ? 'Checking…' : 'Refresh status'}</button>
        {servers.length > 0 && <input type='search' aria-label='Search Claude MCP servers' className='claude-mcp-input max-w-xs'
          placeholder='Search servers, status or tools' value={query} onChange={event => setQuery(event.target.value)} />}
        {status && <span className='claude-mcp-muted text-xs'>
          {used} in use · {query.trim() ? `${shown.length} of ${servers.length} shown` : `${servers.length} found`}{status.cwd ? ` (read from ${status.cwd})` : ''}
        </span>}
      </div>

      {statusError && <p role='alert' className='claude-mcp-error text-xs'>{statusError}</p>}

      {signIn && <div className='claude-mcp-notice space-y-2 p-3 text-xs'>
        <p>Finish signing in to <strong>{signIn.name}</strong> in your browser. This updates when Claude reports it connected.</p>
        {signIn.callbackExpected && <div className='flex flex-wrap items-center gap-2'>
          <input aria-label='Callback address' className='claude-mcp-input'
            placeholder='If the browser shows an error page after sign-in, paste its address here'
            value={signIn.callbackUrl} onChange={event => setSignIn(current => current && { ...current, callbackUrl: event.target.value })} />
          <button type='button' className='claude-mcp-button' onClick={() => void submitCallback()} disabled={!signIn.callbackUrl.trim() || busy === signIn.name}>Send</button>
        </div>}
        <button type='button' className='claude-mcp-button' onClick={() => setSignIn(null)}>Stop waiting</button>
      </div>}

      {shown.length > 0 && <ul className='space-y-1.5'>
        {shown.map(server => <li key={server.name} className='claude-mcp-surface py-1 pl-1 pr-3'>
          <div className='flex flex-wrap items-center gap-2'>
            {switchButton(`Use ${server.name} in Claude chats`, !server.hidden, saving, () => void setServerUsed(server.name, server.hidden))}
            <span className='min-w-0 break-all text-sm font-medium'>{server.name}</span>
            <span className='claude-mcp-pill' data-tone={server.status}>{STATUS_LABEL[server.status]}</span>
            {server.source && <span className='claude-mcp-pill' data-tone='badge'>{SOURCE_LABEL[server.source] ?? server.source}</span>}
            {server.status === 'connected' && <span className='claude-mcp-muted text-xs'>{server.tools.length} tool{server.tools.length === 1 ? '' : 's'}</span>}
            <span className='ml-auto flex gap-1.5'>
              {server.status === 'needs-auth' && status?.signInAvailable && <button type='button' className='claude-mcp-button' disabled={busy === server.name}
                onClick={() => void startSignIn(server.name)}>Sign in</button>}
              {server.status === 'failed' && <button type='button' className='claude-mcp-button' disabled={busy === server.name}
                onClick={() => void runAction(server.name, 'reconnect')}>Reconnect</button>}
              {server.status === 'connected' && server.transport !== 'stdio' && status?.signInAvailable && <button type='button' className='claude-mcp-button' disabled={busy === server.name}
                onClick={() => void runAction(server.name, 'sign-out')}>Sign out</button>}
            </span>
          </div>
          {server.error && <p className='claude-mcp-error mt-1 break-words pl-11 text-xs'>{server.error}</p>}
          {server.status === 'needs-auth' && !status?.signInAvailable && <p className='claude-mcp-muted mt-1 pl-11 text-xs'>
            Run <code>claude mcp login "{server.name}"</code> in a terminal to sign in.</p>}
          {server.status === 'disabled' && <p className='claude-mcp-muted mt-1 pl-11 text-xs'>Turned off in Claude Code. Enable it with <code>/mcp</code> in Claude Code.</p>}
        </li>)}
      </ul>}

      {servers.length > 0 && shown.length === 0 && <p className='claude-mcp-muted text-xs'>No server matches "{query.trim()}".</p>}

      {status && servers.length === 0 && !loading && <p className='claude-mcp-muted text-xs'>Claude Code has no MCP servers. Add one with <code>claude mcp add</code>.</p>}

      <p className='claude-mcp-muted text-xs'>
        Switching a server off hides its tools from Claude in Graviton only; Claude still connects to it, and the terminal CLI is unaffected. A project's <code>.mcp.json</code> servers appear only in chats using that folder, and only after you approve them in Claude Code. A stdio server that needs extra environment variables may fail here: Claude gets a reduced environment.
      </p>
    </>}

    {message && <p role='status' className='claude-mcp-muted text-xs'>{message}</p>}
  </div>
}
