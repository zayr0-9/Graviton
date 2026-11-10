import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { DEFAULT_HOST_CLAUDE_MCP } from '../../../../../shared/claudeNativeMcp'

// Minimal hook driver (as HookGenerationSettings.test): actual JSX handlers, no DOM dependency.
// Effects run once, on the first render.
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, cleanups: [] as Array<() => void> }))
const host = vi.hoisted(() => ({ value: {} as any, revision: 3, save: vi.fn(), refresh: vi.fn() }))
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('react', async () => ({ ...(await vi.importActual<any>('react')),
  useState: (initial: any) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  },
  useRef: (value: any) => {
    const index = hooks.cursor++
    hooks.values[index] ??= { current: value }
    return hooks.values[index]
  },
  useCallback: (fn: any) => { hooks.cursor++; return fn },
  useEffect: (effect: () => (() => void)) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) { hooks.values[index] = true; hooks.cleanups.push(effect()) }
  },
}))
vi.mock('../../services/hostExecutionClient', () => ({
  getHostExecutionPreferences: () => ({ claudeMcp: host.value }), getHostExecutionRevision: () => host.revision,
  HOST_EXECUTION_CHANGED: 'execution-changed', refreshHostExecutionPreferences: () => host.refresh(),
  saveHostExecutionPreference: (...args: any[]) => host.save(...args),
}))
vi.mock('../../utils/api', () => ({ localApi: { get: (...args: any[]) => api.get(...args), post: (...args: any[]) => api.post(...args) } }))
import { ClaudeMcpSettings } from './ClaudeMcpSettings'

const render = () => { hooks.cursor = 0; return ClaudeMcpSettings() }
const elements = (node: any): ReactElement<any>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...elements(node.props.children)]
}
const field = (label: string) => elements(render()).find(el => el.props['aria-label'] === label)
const button = (text: string) => elements(render()).find(el => el.type === 'button' && el.props.children === text)
const text = () => JSON.stringify(elements(render()).map(el => typeof el.props.children === 'string' ? el.props.children : ''))
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const servers = [
  { name: 'claude.ai Linear', status: 'needs-auth', source: 'claudeai', transport: 'claudeai-proxy', error: null, tools: [], hidden: false },
  { name: 'supabase', status: 'connected', source: 'project', transport: 'http', error: null, tools: ['query', 'list'], hidden: false },
]

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.cleanups = []
  host.value = { ...DEFAULT_HOST_CLAUDE_MCP }; host.revision = 3
  host.save.mockReset().mockImplementation(async (patch: any) => { host.value = patch.claudeMcp; host.revision++ })
  host.refresh.mockReset().mockResolvedValue(undefined)
  api.get.mockReset().mockResolvedValue({ cwd: '/Users/me', signInAvailable: true, servers })
  api.post.mockReset()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { open: vi.fn() }))
})
afterEach(() => { hooks.cleanups.forEach(cleanup => cleanup?.()); vi.unstubAllGlobals() })

it('starts off, asks Claude for nothing, and saves the switch with its edit base', async () => {
  render(); await flush()
  expect(field("Use Claude Code's MCP servers")!.props.checked).toBe(false)
  expect(field('Include claude.ai connectors')).toBeUndefined()
  expect(api.get).not.toHaveBeenCalled()
  await field("Use Claude Code's MCP servers")!.props.onChange({ target: { checked: true } })
  expect(host.save).toHaveBeenCalledWith({ claudeMcp: { enabled: true, claudeAiConnectors: true, disabledServers: [] } }, 3)
})

it('lists Claude\'s servers once when on, and hides a server by saving it as disabled', async () => {
  host.value = { ...DEFAULT_HOST_CLAUDE_MCP, enabled: true }
  render(); await flush()
  expect(api.get).toHaveBeenCalledTimes(1)
  expect(api.get).toHaveBeenCalledWith('/headless/claude/mcp/status')
  expect(field('Use supabase in Claude chats')!.props.checked).toBe(true)
  field('Use supabase in Claude chats')!.props.onChange({ target: { checked: false } }); await flush()
  expect(host.save).toHaveBeenLastCalledWith({ claudeMcp: { enabled: true, claudeAiConnectors: true, disabledServers: ['supabase'] } }, 3)
  expect(field('Use supabase in Claude chats')!.props.checked).toBe(false)
  // Sign out is offered for a connected remote server, sign in only where Claude needs it.
  expect(button('Sign out')).toBeDefined()
})

it('does not retry a failed status check on its own', async () => {
  host.value = { ...DEFAULT_HOST_CLAUDE_MCP, enabled: true }
  api.get.mockRejectedValue(new Error('Claude Code CLI is not installed on the host.'))
  render(); await flush(); render(); await flush(); render()
  expect(api.get).toHaveBeenCalledTimes(1)
  expect(text()).toContain('Claude Code CLI is not installed on the host.')
})

it('signs in through the host and opens Claude\'s sign-in address in the browser', async () => {
  host.value = { ...DEFAULT_HOST_CLAUDE_MCP, enabled: true }
  api.post.mockResolvedValue({ authUrl: 'https://auth.example/start', callbackExpected: true })
  render(); await flush()
  await button('Sign in')!.props.onClick()
  expect(api.post).toHaveBeenCalledWith('/headless/claude/mcp/sign-in', { name: 'claude.ai Linear' })
  expect((window as any).open).toHaveBeenCalledWith('https://auth.example/start', '_blank', 'noopener,noreferrer')
  // A callback-based sign-in offers to paste the final address back to Claude.
  field('Callback address')!.props.onChange({ target: { value: 'http://localhost:5555/callback?code=1' } })
  api.post.mockResolvedValue({ success: true })
  await button('Send')!.props.onClick()
  expect(api.post).toHaveBeenLastCalledWith('/headless/claude/mcp/sign-in/callback', { name: 'claude.ai Linear', callbackUrl: 'http://localhost:5555/callback?code=1' })
})

it('points to the terminal when this Claude Code cannot sign in from Graviton', async () => {
  host.value = { ...DEFAULT_HOST_CLAUDE_MCP, enabled: true }
  api.get.mockResolvedValue({ cwd: '/Users/me', signInAvailable: false, servers })
  render(); await flush()
  expect(button('Sign in')).toBeUndefined()
  expect(JSON.stringify(elements(render()).map(el => el.props.children))).toContain('claude mcp login')
})
