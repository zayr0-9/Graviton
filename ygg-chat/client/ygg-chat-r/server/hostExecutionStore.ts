import { DEFAULT_HOST_SUBAGENT_PREFERENCES, validateHostSubagentPreferences } from '../../../shared/hostSubagentPreferences.js'
import { DEFAULT_HOST_PROVIDER_PREFERENCES, validateHostProviderPreferences } from '../../../shared/hostProviderPreferences.js'
import { normalizeHostExecutionPreferences, type HostExecutionPreferences, type HostExecutionSnapshot } from '../../../shared/hostExecutionPreferences.js'
import { getHostPromptStore } from './hostPromptStore.js'
import { getSettingsStore } from './headlessServer/config/settingsStore.js'
const KEY = 'host_execution_preferences_v1'
type Stored = { revisions?: Partial<Record<keyof HostExecutionPreferences, number>>; revision: number; values: Partial<HostExecutionPreferences>; imported?: boolean; importedKeys?: string[] }
const initialLmStudioBaseUrl = process.env.LMSTUDIO_BASE_URL
export function applyHostProviderEnvironment(): void {
  const snapshot = readHostExecutionPreferences()
  if (snapshot.repairNeeded) return
  const stored = getSettingsStore().get(KEY) as Stored | undefined
  if (!stored?.values.provider) return
  const provider = snapshot.values.provider
  if (provider.lmStudioBaseUrl) process.env.LMSTUDIO_BASE_URL = `${provider.lmStudioBaseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`
  else if (initialLmStudioBaseUrl !== undefined) process.env.LMSTUDIO_BASE_URL = initialLmStudioBaseUrl
  else delete process.env.LMSTUDIO_BASE_URL
  process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = String(provider.openAiChatGptMaxContextTokens)
}
export function readHostExecutionPreferences(): HostExecutionSnapshot {
  const current = getSettingsStore().get(KEY) as Stored | undefined
  const { hostId, epoch } = getHostPromptStore().snapshot()
  let values: HostExecutionPreferences
  let repairNeeded: string | undefined
  try { values = normalizeHostExecutionPreferences(current?.values ?? {}) }
  catch { values = normalizeHostExecutionPreferences({}); repairNeeded = 'Host execution settings need repair or a newer version. Original settings are preserved; saving is disabled.' }
  return { hostId, epoch, revision: current?.revision ?? 0, revisions: Object.fromEntries(Object.keys(values).map(key => [key, current?.revisions?.[key as keyof HostExecutionPreferences] ?? current?.revision ?? 0])), values, ...(repairNeeded ? { repairNeeded } : {}) }
}
export function saveHostExecutionPreferences(request: { hostId: string; epoch: string; expectedRevision: number; expectedRevisions?: HostExecutionSnapshot['revisions']; patch: Partial<HostExecutionPreferences> }): HostExecutionSnapshot {
  const current = readHostExecutionPreferences()
  if (current.repairNeeded) throw new Error(current.repairNeeded)
  if (!request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch)) throw new Error('Invalid settings patch')
  const domains = Object.keys(request.patch) as Array<keyof HostExecutionPreferences>
  const stale = request.expectedRevisions ? domains.some(key => request.expectedRevisions?.[key] !== current.revisions?.[key]) : request.expectedRevision !== current.revision
  if (request.hostId !== current.hostId || request.epoch !== current.epoch || stale)
    throw new Error('Host settings changed. Reload settings before saving; your edits have not been applied.')
  const values = normalizeHostExecutionPreferences({ ...current.values, ...request.patch,
    ...(request.patch.tools ? { tools: { ...current.values.tools, ...request.patch.tools } } : {}) })
  const prior = getSettingsStore().get(KEY) as Stored | undefined
  const revisions = { ...current.revisions }
  for (const key of domains) revisions[key] = (revisions[key] ?? 0) + 1
  const persistedValues = { ...prior?.values }
  for (const key of domains) Object.assign(persistedValues, { [key]: values[key] })
  getSettingsStore().set(KEY, { ...prior, revision: current.revision + 1, revisions, values: persistedValues })
  if (request.patch.provider) applyHostProviderEnvironment()
  return readHostExecutionPreferences()
}
/** Trusted native import only; omitted values never overwrite existing defaults. */
export function importHostExecutionPreferences(raw: Record<string, string | null>): HostExecutionSnapshot {
  const store = getSettingsStore()
  const current = store.get(KEY) as Stored | undefined
  if (readHostExecutionPreferences().repairNeeded) return readHostExecutionPreferences()
  const importedKeys = new Set(current?.importedKeys ?? (current?.imported ? ['toolAutoApprove', 'longTermMemoryContextEnabled', 'contextDirectories', 'planModeVerbosity'] : []))
  const values: Partial<HostExecutionPreferences> = {}
  const mapping = { autoCompactionEnabled: 'chat:autoCompactionEnabled', toolAutoApprove: 'chat:defaultToolAutoApprove', longTermMemoryContextEnabled: 'chat:longTermMemoryContextEnabled',
    contextDirectories: 'chat:contextDirectories', planModeVerbosity: 'ygg_plan_mode_response_settings', provider: 'ygg_provider_settings', tools: 'ygg_tool_settings', subagent: 'ygg_subagent_tool_settings', modePrompts: 'ygg_operation_mode_prompt_settings', toolTimeouts: 'ygg_tool_execution_settings' } as const
  for (const [field, key] of Object.entries(mapping)) {
    if (importedKeys.has(field)) continue
    if (raw[key] == null) { importedKeys.add(field); continue }
    try {
      const parsed = JSON.parse(raw[key]!)
      let value = field === 'planModeVerbosity' ? parsed.verbosity : parsed
      if (field === 'toolTimeouts') value = Object.fromEntries(Object.entries(parsed).filter(([key]) => key === 'toolCallTimeoutMs' || key === 'bashTimeoutMs'))
      if (field === 'subagent') {
        const known: Record<string, unknown> = {}
        for (const [key, candidate] of Object.entries(parsed)) {
          if (!Object.hasOwn(DEFAULT_HOST_SUBAGENT_PREFERENCES, key)) continue
          try { validateHostSubagentPreferences({ [key]: candidate }); known[key] = candidate } catch { /* Original legacy value remains available for recovery. */ }
        }
        value = known
      }
      if (field === 'modePrompts') value = Object.fromEntries(Object.entries(parsed).filter(([key]) => ['selectedChatPromptId', 'chatPrompts', 'agentModePromptOverride', 'subagentModePromptOverride'].includes(key)))
      if (field === 'provider') {
        const known: Record<string, unknown> = {}
        let skipped = 0
        for (const [key, candidate] of Object.entries(parsed)) {
          if (key === 'showProviderSelector') continue
          if (!Object.hasOwn(DEFAULT_HOST_PROVIDER_PREFERENCES, key)) { skipped++; continue }
          try { validateHostProviderPreferences({ [key]: candidate }); known[key] = candidate }
          catch { skipped++ }
        }
        value = known
        if (skipped) console.warn(`[HostSettings] ${skipped} unsupported legacy provider fields retained in original storage.`)
      }
      normalizeHostExecutionPreferences({ [field]: value })
      Object.assign(values, { [field]: value })
      importedKeys.add(field)
    } catch { console.warn('[HostSettings] Invalid legacy preference retained:', key) }
  }
  if (Object.keys(values).length === 0 && importedKeys.size === current?.importedKeys?.length) return readHostExecutionPreferences()
  const revisions = { ...readHostExecutionPreferences().revisions }
  for (const key of Object.keys(values) as Array<keyof HostExecutionPreferences>) {
    if (current?.values[key] === undefined) revisions[key] = (revisions[key] ?? 0) + 1
  }
  store.set(KEY, { ...current, revisions, revision: (current?.revision ?? 0) + 1, imported: true, importedKeys: [...importedKeys], values: { ...values, ...current?.values } })
  applyHostProviderEnvironment()
  return readHostExecutionPreferences()
}
