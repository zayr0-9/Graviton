import type { TopLevelUserMessageSearchHit } from '../hooks/useQueries'

export function getSearchResultHref(
  result: Pick<TopLevelUserMessageSearchHit, 'project_id' | 'conversation_id' | 'message_id' | 'match_type'>
): string {
  // Title-only fallback results use the conversation id as a synthetic message id.
  const hash = result.match_type !== 'fallback' && result.message_id ? `#${result.message_id}` : ''
  return `/chat/${result.project_id || 'unknown'}/${result.conversation_id}${hash}`
}
