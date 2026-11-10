import { isCommittedCompaction, isCompactionControl, isCompactionMessage, isCompactionResponse } from '../../../../../shared/compaction'
import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { isClaudeCheckpoint, isClaudeTranscriptMessage } from '../../../../../shared/claudeProvider'
import { isTransferredMessage } from '../../../../../shared/claudeTransfer'

// Lightweight display helpers: never replace content on canonical message rows.
export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const SUMMARY_PLACEHOLDER = 'Conversation summarised. Earlier context is preserved for the model.'
export const isCompactionSummary = isCommittedCompaction

/** Internal requests and unfinished summaries do not occupy transcript rows. */
export function isHiddenCompactionMessage(message: unknown): boolean {
  return parseMessageMeta((message as { meta?: unknown } | null)?.meta)?.kind === 'compaction_instruction' ||
    (isCompactionResponse(message) && !isCommittedCompaction(message))
}

export function getCompactionPlaceholder(message: unknown): string | null {
  if (isCompactionSummary(message)) return SUMMARY_PLACEHOLDER
  if (isCompactionControl(message)) {
    return parseMessageMeta((message as { meta?: unknown }).meta)?.kind === 'compaction_resume'
      ? 'Resuming after compaction' : 'Compaction requested'
  }
  if (isCompactionResponse(message)) return 'Compaction response'
  return null
}

export const getTreeMessageText = (message: { content: string; note?: string | null }): string =>
  getCompactionPlaceholder(message) ?? message.content

type AnchorRow = { id: string | number; parent_id?: string | number | null; role: string; meta?: unknown }

/**
 * The row a "branch before summary" continues from: the summary's nearest ancestor that is real
 * history, so the new branch keeps the uncompacted context. Compaction requests/responses are
 * skipped. Claude can only fork at a resumable checkpoint, so Claude rows walk back to the nearest
 * one. Null when there is no such row: an earlier summary is reached first, ancestry is missing,
 * or the history was copied from another chat (display only).
 */
export function resolveBranchBeforeSummaryAnchor(
  summaryId: string | number,
  messages: ReadonlyArray<AnchorRow>
): string | number | null {
  const byId = new Map(messages.map(message => [String(message.id), message]))
  const summary = byId.get(String(summaryId))
  if (!summary || !isCommittedCompaction(summary)) return null
  const claudeSummary = isClaudeTranscriptMessage(summary)
  const seen = new Set<string>()
  let row = summary.parent_id == null ? undefined : byId.get(String(summary.parent_id))
  while (row && !seen.has(String(row.id))) {
    seen.add(String(row.id))
    if (isTransferredMessage(row) || isCommittedCompaction(row)) return null
    const skip = isCompactionMessage(row) ||
      ((claudeSummary || isClaudeTranscriptMessage(row)) && !isClaudeCheckpoint(row))
    if (!skip) return row.id
    row = row.parent_id == null ? undefined : byId.get(String(row.parent_id))
  }
  return null
}
