import { parseMessageMeta } from '../../../../../shared/contextInjection'
import type { OperationMode } from './chatTypes'

export interface ClaudeModeNotice { mode: OperationMode; initial: boolean }

/**
 * Claude turns record their mode on the user row instead of persisting a mode-notification row
 * (a row there would displace the resumable checkpoint). Derive the same notice the other
 * providers persist: on the first Claude user row of a branch and wherever the mode changes.
 */
export function claudeModeNoticesByMessageId(path: ReadonlyArray<{ id: unknown; role?: string; meta?: unknown }>): Map<string, ClaudeModeNotice> {
  const notices = new Map<string, ClaudeModeNotice>()
  let current: OperationMode | null = null
  for (const row of path) {
    const meta = parseMessageMeta(row.meta)
    if (meta?.kind === 'operation_mode_change' && (meta.mode === 'plan' || meta.mode === 'execute')) {
      current = meta.mode
      continue
    }
    const mode = row.role === 'user' ? meta?.operationMode : undefined
    if (mode !== 'plan' && mode !== 'execute') continue
    if (mode !== current) notices.set(String(row.id), { mode, initial: current === null })
    current = mode
  }
  return notices
}
