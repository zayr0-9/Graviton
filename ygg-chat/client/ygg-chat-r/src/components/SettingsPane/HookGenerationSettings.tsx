import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HOST_HOOK_GENERATION, type HostHookGeneration } from '../../../../../shared/hostHookGeneration'
import { getHostExecutionPreferences, getHostExecutionRevision, HOST_EXECUTION_CHANGED, refreshHostExecutionPreferences, saveHostExecutionPreference } from '../../services/hostExecutionClient'
import { localApi } from '../../utils/api'

type Availability = { provider: string; modelName: string; openAiStatus: string; claudeInstalled: boolean }

export function HookGenerationSettings() {
  const [draft, setDraft] = useState<HostHookGeneration>(() => getHostExecutionPreferences()?.hookGeneration ?? DEFAULT_HOST_HOOK_GENERATION)
  const baseRevision = useRef(getHostExecutionRevision('hookGeneration'))
  const dirty = useRef(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [availability, setAvailability] = useState<Availability>()
  const refreshStatus = () => localApi.get<Availability>('/headless/ygg-hooks/status').then(setAvailability).catch(() => setAvailability(undefined))
  useEffect(() => {
    let live = true
    const refresh = () => {
      if (!live) return
      if (dirty.current) {
        if (getHostExecutionRevision('hookGeneration') !== baseRevision.current) setMessage('Hook settings changed. Save will check your edit version; reload to discard your draft.')
        return
      }
      setDraft(getHostExecutionPreferences()?.hookGeneration ?? DEFAULT_HOST_HOOK_GENERATION)
      baseRevision.current = getHostExecutionRevision('hookGeneration')
      void refreshStatus()
    }
    window.addEventListener(HOST_EXECUTION_CHANGED, refresh)
    void refreshHostExecutionPreferences().then(refresh).catch(() => { if (live) setMessage('Hook settings are unavailable. Reload settings to retry.') })
    return () => { live = false; window.removeEventListener(HOST_EXECUTION_CHANGED, refresh) }
  }, [])
  const edit = (patch: Partial<HostHookGeneration>) => { dirty.current = true; setDraft(value => ({ ...value, ...patch })); setMessage('') }
  const save = async () => {
    setSaving(true)
    try {
      await saveHostExecutionPreference({ hookGeneration: draft }, baseRevision.current)
      dirty.current = false
      baseRevision.current = getHostExecutionRevision('hookGeneration')
      setMessage('Hook generation settings saved.')
      await refreshStatus()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save hook settings.') }
    finally { setSaving(false) }
  }
  const reload = async () => {
    setSaving(true)
    try {
      await refreshHostExecutionPreferences()
      dirty.current = false
      setDraft(getHostExecutionPreferences()?.hookGeneration ?? DEFAULT_HOST_HOOK_GENERATION)
      baseRevision.current = getHostExecutionRevision('hookGeneration')
      setMessage('')
      await refreshStatus()
    } catch { setMessage('Could not reload hook settings; your draft was kept.') }
    finally { setSaving(false) }
  }
  const fieldClass = 'rounded-lg border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-600'
  return <div className='space-y-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700'>
    <label className='flex flex-wrap items-center gap-3 text-sm'>Hook generation provider
      <select aria-label='Hook generation provider' className={fieldClass} value={draft.provider} disabled={saving}
        onChange={event => edit({ provider: event.target.value as HostHookGeneration['provider'] })}>
        <option value='auto'>Auto</option><option value='openaichatgpt'>OpenAI / ChatGPT</option><option value='claudecode'>Claude Code</option>
      </select>
    </label>
    {draft.provider !== 'claudecode' && <label className='flex flex-wrap items-center gap-3 text-sm'>OpenAI hook model
      <input aria-label='OpenAI hook model' className={fieldClass} value={draft.openAiModel} disabled={saving} onChange={event => edit({ openAiModel: event.target.value })} />
    </label>}
    {draft.provider !== 'openaichatgpt' && <label className='flex flex-wrap items-center gap-3 text-sm'>Claude hook model
      <input aria-label='Claude hook model' className={fieldClass} placeholder='CLI default' value={draft.claudeModel} disabled={saving} onChange={event => edit({ claudeModel: event.target.value })} />
    </label>}
    <p className='text-sm text-neutral-500 dark:text-neutral-400'>Independent of the chat provider. Auto uses a configured OpenAI connection, otherwise Claude. Claude requires an installed, signed-in CLI on the host. Provider errors do not trigger fallback.</p>
    {availability && <p className='text-sm' role='status'>Saved selection: {availability.provider === 'claudecode' ? `Claude Code${availability.claudeInstalled ? ' (login checked when generating)' : ' (CLI not found)'}` : `OpenAI / ChatGPT (${availability.openAiStatus})`}{availability.modelName ? ` · ${availability.modelName}` : ' · CLI default'}</p>}
    <div className='flex gap-3'>
      <button type='button' className={fieldClass} onClick={save} disabled={saving || baseRevision.current === undefined}>Save hook provider</button>
      <button type='button' className={fieldClass} onClick={reload} disabled={saving}>Reload hook settings</button>
    </div>
    {message && <p role='status' className='text-sm'>{message}</p>}
  </div>
}
