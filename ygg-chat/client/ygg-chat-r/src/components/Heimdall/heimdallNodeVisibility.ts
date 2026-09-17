export interface HeimdallNodeVisibilityInput {
  isContextInjection: boolean
  isEmpty: boolean
  hasSiblings: boolean
  filterEmptyMessages: boolean
}

/**
 * Persisted context-injection rows are model-history scaffolding, not conversation
 * turns. Heimdall always treats them as transparent and promotes their descendants.
 * The sibling exception remains only for ordinary empty messages that carry branch
 * structure users may need to inspect.
 */
export function shouldPromoteHeimdallNode({
  isContextInjection,
  isEmpty,
  hasSiblings,
  filterEmptyMessages,
}: HeimdallNodeVisibilityInput): boolean {
  if (isContextInjection) return true
  return filterEmptyMessages && isEmpty && !hasSiblings
}
