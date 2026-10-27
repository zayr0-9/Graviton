import { isContextInjectionMessage, parseMessageMeta } from './contextInjection.js'
import { isCompactionMessage } from './compaction.js'
import { isRunSettingsNotification } from './accessNotifications.js'

type BranchRow = { id: string | number; parent_id?: string | number | null; role?: string; meta?: unknown }

/** Only known launch scaffolding may precede a fresh user prompt. Visibility is not an execution boundary. */
export function isCleanStartUserBranch(path: readonly BranchRow[]): boolean {
  const prompt = path.at(-1)
  const scaffolding = (row: BranchRow) =>
    (row.role === 'user' || row.role === 'system') && (isContextInjectionMessage(row) || isRunSettingsNotification(row))
  if (!prompt || prompt.role !== 'user' || scaffolding(prompt) || isCompactionMessage(prompt) ||
      parseMessageMeta(prompt.meta)?.kind === 'watcher_completion' || path[0].parent_id != null) return false
  return path.every((row, index) =>
    (index === 0 || String(row.parent_id) === String(path[index - 1].id)) &&
    (index === path.length - 1 || scaffolding(row)))
}
