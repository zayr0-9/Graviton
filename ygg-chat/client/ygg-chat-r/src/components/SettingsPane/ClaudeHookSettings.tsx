import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { ClaudeHookInventory, ClaudeHookSettingsSource } from '../../../../../shared/claudeHookInventory'
import { isNativeShell } from '../../platform/clientCapabilities'
import { getHostExecutionPreferences, getHostExecutionRevision, HOST_EXECUTION_CHANGED, refreshHostExecutionPreferences, saveHostExecutionPreference } from '../../services/hostExecutionClient'
import { localApi } from '../../utils/api'
import { useSettingsSectionThemeColors } from './settingsSectionTheme'

const sourceLabels = { project: 'Project', local: 'Project local', user: 'User' } as const
const sourceMessages: Record<ClaudeHookSettingsSource['status'], string> = {
  missing: 'Settings file not found.',
  unreadable: 'Could not safely read this settings file.',
  invalid: 'This file contains invalid settings or hook declarations.',
  limited: 'Only part of this file could be checked, or it exceeded the size limit.',
  read: 'No hooks declared.',
}

function readHookPolicy() {
  return { allowed: getHostExecutionPreferences()?.allowClaudeNativeHooks, revision: getHostExecutionRevision('allowClaudeNativeHooks') }
}

export function ClaudeHookSettings({ conversationId, projectId }: { conversationId?: string | null; projectId?: string | null }) {
  const colors = useSettingsSectionThemeColors()
  const [policy, setPolicy] = useState(readHookPolicy)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const allowed = policy.allowed === true
  const policyKnown = policy.allowed !== undefined

  useEffect(() => {
    const update = () => setPolicy(readHookPolicy())
    window.addEventListener(HOST_EXECUTION_CHANGED, update)
    update()
    void refreshHostExecutionPreferences().catch(() => {})
    return () => window.removeEventListener(HOST_EXECUTION_CHANGED, update)
  }, [])

  const togglePolicy = async () => {
    if (!isNativeShell || saving || !policyKnown || policy.revision === undefined) return
    setSaving(true)
    setSaveError('')
    try {
      await saveHostExecutionPreference({ allowClaudeNativeHooks: !allowed }, policy.revision)
      setPolicy(readHookPolicy())
    } catch {
      setSaveError('Could not change Claude Code hook permissions. Try again.')
      await refreshHostExecutionPreferences().catch(() => {})
    } finally { setSaving(false) }
  }
  const bodyStyle = colors ? { color: colors.bodyText } : undefined
  const rowTitleStyle = colors ? { color: colors.listItemTitleText } : undefined
  const rowMetaStyle = colors ? { color: colors.listItemMetaText } : undefined
  const params = new URLSearchParams()
  if (conversationId) params.set('conversationId', conversationId)
  if (projectId) params.set('projectId', projectId)
  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ['claude-hook-inventory', conversationId ?? null, projectId ?? null],
    queryFn: ({ signal }) => localApi.get<ClaudeHookInventory>(`/headless/claude/hooks?${params}`, { signal }),
    retry: false,
  })

  return (
    <section className='space-y-2 rounded-2xl bg-white/60 px-3 py-3 text-sm text-stone-900 dark:bg-white/5 dark:text-stone-100'
      style={colors ? { backgroundColor: colors.cardBg, color: colors.titleText } : undefined} aria-labelledby='claude-hooks-title'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 id='claude-hooks-title' className='font-medium'>Claude Code hooks</h3>
        <button type='button' disabled={isFetching} onClick={() => { void refetch() }}
          className='rounded-full bg-white/70 px-3 py-1.5 text-xs text-stone-800 focus-visible:outline focus-visible:outline-2 disabled:opacity-50 dark:bg-white/10 dark:text-stone-100'
          style={colors ? { backgroundColor: colors.buttonBg, color: colors.buttonText } : undefined}>
          Refresh Claude hooks
        </button>
      </div>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        {isNativeShell && <button type='button' role='switch' aria-checked={allowed} aria-describedby='claude-hook-policy-help'
          disabled={!policyKnown || policy.revision === undefined || saving} onClick={() => { void togglePolicy() }}
          className={`rounded-full px-3 py-1.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 disabled:opacity-50 ${allowed
            ? 'bg-blue-700 text-white dark:bg-blue-300 dark:text-blue-950'
            : 'bg-white/70 text-stone-800 dark:bg-white/10 dark:text-stone-100'}`}
          style={colors ? { backgroundColor: allowed ? colors.primaryButtonBg : colors.buttonBg,
            color: allowed ? colors.primaryButtonText : colors.buttonText } : undefined}>
          Allow Claude Code hooks
        </button>}
        <span className='text-xs text-stone-600 dark:text-stone-300' style={bodyStyle}>
          {saving ? 'Saving…' : !policyKnown ? 'Hook policy unavailable' : allowed ? 'On' : 'Off'}
          {!isNativeShell && ' · Change in desktop Settings'}
        </span>
      </div>
      <p id='claude-hook-policy-help' className='text-xs text-stone-600 dark:text-stone-300' style={bodyStyle}>
        When on, Claude Code can run hooks in every workspace, including newly added repo hooks, without individual approval.
        Changes apply to the next run. Stop any active run before sending a follow-up under the new setting. Graviton hooks and standalone Claude Code are unchanged.
      </p>
      {saveError && <p role='alert' className='text-xs text-red-600 dark:text-red-400'>{saveError}</p>}
      {isPending && <p role='status' className='text-xs'>Checking hook declarations…</p>}
      {isError && <p role='alert' className='text-xs text-red-600 dark:text-red-400'>Could not list Claude Code hooks. Try refreshing.</p>}
      {data && <>
        <p className='break-all text-xs text-stone-600 dark:text-stone-300' style={bodyStyle}>{data.cwd ? `Workspace: ${data.cwd}` : 'Select a workspace to see its Claude Code hooks.'}</p>
        {data.sources.map(source => (
          <div key={source.source} className='rounded-xl bg-white/50 p-2 dark:bg-white/5'
            style={colors ? { backgroundColor: colors.innerCardBg } : undefined}>
            <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
              <h4 className='text-xs font-medium' style={rowTitleStyle}>{sourceLabels[source.source]}</h4>
              <span className='break-all font-mono text-xs text-stone-600 dark:text-stone-300' style={rowMetaStyle}>{source.file}</span>
            </div>
            {source.hooks.length > 0 && <ul className='mt-1 space-y-1'>
              {source.hooks.map((hook, index) => (
                <li key={`${hook.event}:${index}`} className='flex flex-wrap items-baseline gap-x-2 break-all text-xs'>
                  <span className='font-medium' style={rowTitleStyle}>{hook.event}</span>
                  {hook.matcher && <span className='font-mono text-stone-600 dark:text-stone-300' style={rowMetaStyle}>{hook.matcher}</span>}
                  <span className='text-stone-600 dark:text-stone-300' style={rowMetaStyle}>{hook.type}{policyKnown && !allowed ? ' · Blocked' : ''}</span>
                </li>
              ))}
            </ul>}
            {(source.status !== 'read' || !source.hooks.length) && <p className='mt-1 text-xs text-stone-600 dark:text-stone-300' style={rowMetaStyle}>{sourceMessages[source.status]}</p>}
          </div>
        ))}
        <p className='text-xs text-stone-600 dark:text-stone-300' style={bodyStyle}>Only settings files are listed here. Plugins, skills, agents and administrator-managed hooks are not shown. Administrator-managed hooks may still run.</p>
      </>}
    </section>
  )
}
