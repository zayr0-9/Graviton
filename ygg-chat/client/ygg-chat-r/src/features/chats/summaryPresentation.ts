import { isCommittedCompaction, isCompactionControl, isCompactionResponse } from '../../../../../shared/compaction'
import { parseMessageMeta } from '../../../../../shared/contextInjection'

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
