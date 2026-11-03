import { isRunSettingsNotification } from './accessNotifications.js'
import { claudeMessageMetadata, isClaudeProvider } from './claudeProvider.js'
import { isContextInjectionMessage, parseMessageMeta } from './contextInjection.js'
import { executionPathAfterHandoff, portableSummaryText } from './summaryHandoff.js'

/**
 * Copy, move and New Chat From Here never carry a Claude native session. A Claude branch can
 * be transferred only up to a committed summary; the copy then continues through the normal
 * summary handoff, which starts a fresh session from the summary text.
 */
export const CLAUDE_TRANSFER_REFUSED = 'claude_transfer_requires_summary'
export const CLAUDE_TRANSFER_REFUSED_MESSAGE =
  'Claude messages can only be copied or moved up to a summary. Run /compact on that branch, then select up to the summary.'
export const CLAUDE_TRANSFERRED_SOURCE_MESSAGE =
  'This message was copied from another chat, so Claude has no session to continue from it. Continue from the copied summary instead.'

export interface TransferRow {
  id: string | number
  parent_id?: string | number | null
  role?: string
  meta?: unknown
  content?: unknown
  note?: unknown
}

/** Provenance written on every copied row. */
export interface MessageTransferMeta {
  sourceConversationId?: string
  sourceMessageId: string
}

export function messageTransferMeta(message: { meta?: unknown } | null | undefined): MessageTransferMeta | null {
  const transfer = parseMessageMeta(message?.meta)?.transfer as MessageTransferMeta | undefined
  return transfer && typeof transfer === 'object' && typeof transfer.sourceMessageId === 'string' ? transfer : null
}

export function isTransferredMessage(message: { meta?: unknown } | null | undefined): boolean {
  return messageTransferMeta(message) !== null
}

/** Rows that can follow a summary without starting new work, as in `resolveSummaryContinuation`. */
function isSummaryTrailer(row: TransferRow): boolean {
  return isContextInjectionMessage(row) || isRunSettingsNotification(row) || parseMessageMeta(row.meta)?.kind === 'compaction_resume'
}

/** The committed summary a tip continues from, skipping trailing context/settings rows. */
export function summaryAtTip<T extends TransferRow>(tip: T | undefined, rowOf: (id: string) => T | undefined, within?: ReadonlySet<string>): T | null {
  const seen = new Set<string>()
  for (let row = tip; row && !seen.has(String(row.id)) && (!within || within.has(String(row.id))); row = row.parent_id == null ? undefined : rowOf(String(row.parent_id))) {
    seen.add(String(row.id))
    if (portableSummaryText(row)) return row
    if (!isSummaryTrailer(row)) return null
  }
  return null
}

/** A copied summary has no native session, so every continuation from it is a summary handoff. */
export function transferredSummaryAtTip<T extends TransferRow>(tip: T | undefined, rowOf: (id: string) => T | undefined): T | null {
  const summary = summaryAtTip(tip, rowOf)
  return summary && isTransferredMessage(summary) ? summary : null
}

/** Whether continuing from a row runs on Claude: the nearest provider record after the last handoff. */
export function isClaudeExecutionTip<T extends TransferRow>(tip: T, rowOf: (id: string) => T | undefined): boolean {
  const path: T[] = []
  const seen = new Set<string>()
  for (let row: T | undefined = tip; row && !seen.has(String(row.id)); row = row.parent_id == null ? undefined : rowOf(String(row.parent_id))) {
    seen.add(String(row.id))
    path.unshift(row)
  }
  for (const row of [...executionPathAfterHandoff(path)].reverse()) {
    const meta = claudeMessageMetadata(row.meta)
    if (typeof meta.modelSelection?.provider === 'string') return isClaudeProvider(meta.modelSelection.provider)
    if (meta.claude) return true
  }
  return false
}

/**
 * Null when the selection may be transferred. Every selected branch tip that continues on Claude
 * must be a committed summary (or context/settings rows directly after one), and the summary must
 * be part of the selection.
 */
export function claudeTransferRefusal<T extends TransferRow>(rows: Iterable<T>, selectedIds: Iterable<string | number>): string | null {
  const byId = new Map<string, T>()
  for (const row of rows) byId.set(String(row.id), row)
  const selected = new Set([...selectedIds].map(String).filter(id => byId.has(id)))
  const hasSelectedChild = new Set<string>()
  for (const id of selected) {
    const parent = byId.get(id)?.parent_id
    if (parent != null && selected.has(String(parent))) hasSelectedChild.add(String(parent))
  }
  const rowOf = (id: string) => byId.get(id)
  for (const id of selected) {
    if (hasSelectedChild.has(id)) continue
    const tip = byId.get(id)!
    if (isClaudeExecutionTip(tip, rowOf) && !summaryAtTip(tip, rowOf, selected)) return CLAUDE_TRANSFER_REFUSED_MESSAGE
  }
  return null
}
