import { randomUUID } from 'node:crypto'
import { hostEpoch } from './hostEpoch.js'
import { validateHostPrompts, type HostPromptSnapshot } from '../../../shared/hostPrompts.js'
import { getSettingsStore } from './headlessServer/config/settingsStore.js'
import type { KeyValueStore } from './hostCapabilities.js'
const KEY = 'host_prompts_v1'
type Stored = Omit<HostPromptSnapshot, 'hostId' | 'epoch'> & { imported?: boolean }

export class HostPromptStore {
  constructor(private readonly store: KeyValueStore) {}
  private read(): Stored {
    const value = this.store.get(KEY) as Stored | undefined
    if (!value) return { schema: 1, revision: 0, prompts: [] }
    try {
      if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Unsupported host prompt schema')
      return { ...value, prompts: validateHostPrompts(value.prompts) }
    } catch {
      return { schema: 1, revision: Number.isSafeInteger(value.revision) ? value.revision : 0, prompts: [],
        repairNeeded: 'Saved host prompts need repair or a newer Graviton version. Original data is preserved; saving is disabled.' }
    }
  }
  snapshot(): HostPromptSnapshot {
    const { schema, revision, prompts, repairNeeded } = this.read()
    let hostId = this.store.get('host_client_id')
    if (typeof hostId !== 'string') { hostId = randomUUID(); this.store.set('host_client_id', hostId) }
    return { schema, revision, prompts, hostId: hostId as string, epoch: hostEpoch, ...(repairNeeded ? { repairNeeded } : {}) }
  }
  save(expectedRevision: number, input: unknown, identity: Pick<HostPromptSnapshot, 'hostId' | 'epoch'>): HostPromptSnapshot {
    const currentIdentity = this.snapshot()
    if (currentIdentity.repairNeeded) throw new Error(currentIdentity.repairNeeded)
    if (identity?.hostId !== currentIdentity.hostId || identity?.epoch !== currentIdentity.epoch)
      throw Object.assign(new Error('The host changed. Reload and reconcile before saving prompts.'), { status: 409 })
    const prompts = validateHostPrompts(input)
    const current = this.read()
    if (JSON.stringify(prompts) === JSON.stringify(current.prompts)) return this.snapshot()
    if (expectedRevision !== current.revision) throw Object.assign(new Error('Prompts changed on another client. Your edits have not been saved.'), { status: 409, snapshot: this.snapshot() })
    const next: Stored = { ...current, revision: current.revision + 1, prompts }
    this.store.set(KEY, next)
    return this.snapshot()
  }
  /** Called only by trusted main-frame IPC, never HTTP or browser bootstrap. */
  importLegacy(input: unknown): HostPromptSnapshot {
    const current = this.read()
    if (current.imported || current.repairNeeded) return this.snapshot()
    let incoming
    try {
      const raw = typeof input === 'string' ? JSON.parse(input) : input ?? []
      if (!Array.isArray(raw) || raw.length > 1000) throw new Error('Invalid legacy collection')
      const now = new Date().toISOString()
      incoming = raw.flatMap(row => {
        try {
          if (!row || typeof row.id !== 'string') return []
          return validateHostPrompts([{ ...row, id: row.id.startsWith('local-') ? row.id : `local-${row.id}`,
            owner_id: typeof row.owner_id === 'string' && row.owner_id.trim() ? row.owner_id : 'local',
            created_at: row.created_at || now, updated_at: row.updated_at || now, is_default: Boolean(row.is_default) }])
        } catch { return [] }
      })
      if (incoming.length !== raw.length) console.warn(`[HostPrompts] ${raw.length - incoming.length} invalid legacy prompts retained in original storage.`)
    }
    catch {
      // Do not mark corrupt legacy data imported or block the entire application.
      // The original renderer value remains intact for recovery.
      console.warn('[HostPrompts] Legacy prompt import needs repair; original data retained.')
      return this.snapshot()
    }
    const ids = new Set(current.prompts.map(prompt => prompt.id))
    let hasDefault = current.prompts.some(prompt => prompt.is_default)
    const added = incoming.filter(prompt => {
      if (ids.has(prompt.id)) return false
      ids.add(prompt.id); return true
    }).map(prompt => {
      const next = { ...prompt, is_default: prompt.is_default && !hasDefault }
      hasDefault ||= next.is_default
      return next
    })
    let prompts
    try { prompts = validateHostPrompts([...current.prompts, ...added]) }
    catch { return { ...this.snapshot(), repairNeeded: 'Legacy prompt import exceeds capacity. Original prompts remain in desktop storage.' } }
    this.store.set(KEY, { ...current, revision: current.revision + 1, prompts, imported: true })
    return this.snapshot()
  }
}
export const getHostPromptStore = () => new HostPromptStore(getSettingsStore())
