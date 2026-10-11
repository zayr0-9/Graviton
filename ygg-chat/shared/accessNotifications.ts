import { parseMessageMeta, renderSystemReminder } from './contextInjection.js'

export const FULL_ACCESS_NOTIFICATION_KIND = 'full_access_change'

export function isFullAccessNotification(message: unknown): boolean {
  return parseMessageMeta((message as { meta?: unknown } | null)?.meta)?.kind === FULL_ACCESS_NOTIFICATION_KIND
}

/** Presentation-only notices are not user prompts or operation-mode selections. */
export function isRunSettingsNotification(message: unknown): boolean {
  const kind = parseMessageMeta((message as { meta?: unknown } | null)?.meta)?.kind
  return kind === 'operation_mode_change' || kind === FULL_ACCESS_NOTIFICATION_KIND
}

export function fullAccessNotificationContent(): string {
  return renderSystemReminder([
    'Full access enabled for this new run. Tools may access paths outside the working directory. ' +
    'Relative paths still use the working directory. Operation mode, tool approvals, and OS permissions still apply. ' +
    'This is an access notification, not a request for a response. Enabling Full access does not change any already-running run. ' +
    'If a restricted run needs access outside the working directory, ask the user to enable Full access and send a new message or use Branch; do not continue as though access has changed mid-run.',
  ])
}
