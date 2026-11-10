import { parseMessageMeta } from '../../../../../shared/contextInjection'
import type { OperationMode } from './chatTypes'

/** Chat or Agent mode, or Claude Code's native plan mode (`claude_plan`), which overrides both. */
export type ClaudeNoticeMode = OperationMode | 'claude_plan'
export interface ClaudeModeNotice { mode: ClaudeNoticeMode; initial: boolean }

/**
 * Claude turns record their mode on the user row instead of persisting a mode-notification row
 * (a row there would displace the resumable checkpoint). Derive the same notice the other
 * providers persist: on the first Claude user row of a branch and wherever the mode changes.
 * A turn run in native plan mode (`meta.claudePlanMode`) shows Plan mode instead of its
 * Chat/Agent mode, and the turn after it shows the mode it returned to.
 */
export function claudeModeNoticesByMessageId(path: ReadonlyArray<{ id: unknown; role?: string; meta?: unknown }>): Map<string, ClaudeModeNotice> {
  const notices = new Map<string, ClaudeModeNotice>()
  let current: ClaudeNoticeMode | null = null
  for (const row of path) {
    const meta = parseMessageMeta(row.meta)
    if (meta?.kind === 'operation_mode_change' && (meta.mode === 'plan' || meta.mode === 'execute')) {
      current = meta.mode
      continue
    }
    const operationMode = row.role === 'user' ? meta?.operationMode : undefined
    if (operationMode !== 'plan' && operationMode !== 'execute') continue
    const mode: ClaudeNoticeMode = meta?.claudePlanMode === true ? 'claude_plan' : operationMode
    if (mode !== current) notices.set(String(row.id), { mode, initial: current === null })
    current = mode
  }
  return notices
}
