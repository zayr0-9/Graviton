import { isRunSettingsNotification } from '../../../../../shared/accessNotifications'
import { isContextInjectionMessage, parseMessageMeta } from '../../../../../shared/contextInjection'

/** Persisted control rows can follow a final assistant response without another reply. */
export function isStreamContinuationTail(message: unknown): boolean {
  if (isRunSettingsNotification(message) || isContextInjectionMessage(message)) return true
  const kind = parseMessageMeta((message as { meta?: unknown } | null)?.meta)?.kind
  return kind === 'compaction_instruction' || kind === 'compaction_resume'
}
