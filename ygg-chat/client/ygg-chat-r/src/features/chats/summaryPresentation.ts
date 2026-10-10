// Lightweight display helpers: never replace content on canonical message rows.
export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const SUMMARY_PLACEHOLDER = 'Conversation summarised. Earlier context is preserved for the model.'

export const isCompactionSummary = (message: { note?: string | null } | null | undefined): boolean =>
  message?.note === AUTO_COMPACTION_NOTE

export const getTreeMessageText = (message: { content: string; note?: string | null }): string =>
  isCompactionSummary(message) ? SUMMARY_PLACEHOLDER : message.content
