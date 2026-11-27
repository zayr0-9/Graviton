import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ClaudeHookSettings } from './ClaudeHookSettings'

const state = vi.hoisted(() => ({ useQuery: vi.fn(), get: vi.fn(), themeColors: vi.fn(() => null as Record<string, string> | null),
  policy: { allowClaudeNativeHooks: false }, native: true }))
vi.mock('../../platform/clientCapabilities', () => ({ get isNativeShell() { return state.native } }))
vi.mock('../../services/hostExecutionClient', () => ({
  getHostExecutionPreferences: () => state.policy, getHostExecutionRevision: () => 2,
  HOST_EXECUTION_CHANGED: 'test-host-execution-changed', refreshHostExecutionPreferences: vi.fn(), saveHostExecutionPreference: vi.fn(),
}))
vi.mock('./settingsSectionTheme', () => ({ useSettingsSectionThemeColors: state.themeColors }))
vi.mock('@tanstack/react-query', () => ({ useQuery: state.useQuery }))
vi.mock('../../utils/api', () => ({ localApi: { get: state.get } }))

it('lists blocked hook declarations and does not offer unsupported approval controls', async () => {
  state.useQuery.mockReturnValue({ data: { cwd: '/workspace', sources: [
    { source: 'project', file: '.claude/settings.json', status: 'read', hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command' }] },
    { source: 'local', file: '.claude/settings.local.json', status: 'invalid', hooks: [] },
  ] } })
  const html = renderToStaticMarkup(<ClaudeHookSettings conversationId='chat&name' projectId='project' />)
  expect(html).toContain('command · Blocked')
  expect(html).toContain('including newly added repo hooks, without individual approval')
  expect(html).toContain('invalid settings or hook declarations')
  expect(html).toContain('Administrator-managed hooks may still run')
  expect(html).toContain('role="switch" aria-checked="false"')
  const { queryKey, queryFn } = state.useQuery.mock.lastCall![0]
  expect(queryKey).toEqual(['claude-hook-inventory', 'chat&name', 'project'])
  const { signal } = new AbortController()
  await queryFn({ signal })
  expect(state.get).toHaveBeenCalledWith('/headless/claude/hooks?conversationId=chat%26name&projectId=project', { signal })
})

it('shows loading and fetch failure instead of claiming that no hooks exist', () => {
  state.useQuery.mockReturnValue({ isPending: true, isFetching: true })
  expect(renderToStaticMarkup(<ClaudeHookSettings />)).toContain('Checking hook declarations')
  state.useQuery.mockReturnValue({ isError: true })
  const html = renderToStaticMarkup(<ClaudeHookSettings />)
  expect(html).toContain('Could not list Claude Code hooks')
  expect(html).not.toContain('No hooks declared')
})

it('sets default dark foregrounds and uses custom Settings colors for every text role', () => {
  state.useQuery.mockReturnValue({ data: { cwd: '/workspace', sources: [
    { source: 'project', file: '.claude/settings.json', status: 'read', hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command' }] },
  ] } })
  const render = () => renderToStaticMarkup(<ClaudeHookSettings />)
  const defaults = render()
  expect(defaults).toMatch(/<section[^>]+dark:text-stone-100/)
  expect(defaults).toMatch(/<button[^>]+dark:text-stone-100[^>]*>Refresh Claude hooks/)
  expect(defaults).toMatch(/<span[^>]+dark:text-stone-300[^>]*>Bash/)

  state.themeColors.mockReturnValueOnce({ cardBg: '#121212', titleText: '#ffffff', bodyText: '#eeeeee', innerCardBg: '#202020',
    listItemTitleText: '#dddddd', listItemMetaText: '#cccccc', buttonBg: '#303030', buttonText: '#fafafa' })
  const themed = render()
  expect(themed).toContain('background-color:#121212;color:#ffffff')
  expect(themed).toContain('background-color:#202020')
  expect(themed).toContain('background-color:#303030;color:#fafafa')
  expect(themed).toContain('color:#eeeeee">Workspace:')
  expect(themed).toContain('color:#dddddd">Project')
  expect(themed).toContain('color:#dddddd">PreToolUse')
  expect(themed).toContain('color:#cccccc">Bash')
})

it('reflects the saved opt-in without claiming each declared hook will run, and is read-only remotely', () => {
  state.policy.allowClaudeNativeHooks = true
  try {
    const render = () => renderToStaticMarkup(<ClaudeHookSettings />)
    const desktop = render()
    expect(desktop).toContain('role="switch" aria-checked="true"')
    expect(desktop).toContain('dark:bg-blue-300 dark:text-blue-950')
    expect(desktop).not.toContain('· Blocked')
    state.native = false
    const remote = render()
    expect(remote).not.toContain('role="switch"')
    expect(remote).toContain('Change in desktop Settings')
  } finally {
    state.policy.allowClaudeNativeHooks = false
    state.native = true
  }
})
