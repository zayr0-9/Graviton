import { parseId } from '../../utils/helpers'
import type { MessageId } from '../../../../../shared/types'

export type HeimdallSearchRole = 'all' | 'user' | 'assistant'

export const HEIMDALL_SEARCH_ROLES: { value: HeimdallSearchRole; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
]

export interface HeimdallSearchSource {
  id: unknown
  role?: unknown
  content?: unknown
  content_plain_text?: unknown
  plain_text_content?: unknown
}

export interface HeimdallSearchResult {
  id: MessageId
  role: string
  plain: string
}

export interface HeimdallSearchOutcome {
  results: HeimdallSearchResult[]
  counts: Record<HeimdallSearchRole, number>
}

const plainTextOf = (message: HeimdallSearchSource): string => {
  for (const value of [message.content_plain_text, message.plain_text_content, message.content]) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** Maps a stored message role onto the panel's user/assistant filter. */
export const heimdallSearchRoleOf = (role: unknown): Exclude<HeimdallSearchRole, 'all'> | null => {
  if (role === 'user') return 'user'
  if (role === 'assistant' || role === 'ex_agent') return 'assistant'
  return null
}

export const tokenizeHeimdallSearch = (query: string): string[] => query.trim().split(/\s+/).filter(Boolean)

/**
 * Case-insensitive phrase match over the plain-text projection. Counts are per role for the
 * current query, so each filter chip can show how many matches it would reveal.
 */
export function searchHeimdallMessages(
  messages: readonly HeimdallSearchSource[],
  query: string,
  role: HeimdallSearchRole
): HeimdallSearchOutcome {
  const counts: Record<HeimdallSearchRole, number> = { all: 0, user: 0, assistant: 0 }
  const needle = query.trim().toLowerCase()
  if (!needle) return { results: [], counts }
  const results: HeimdallSearchResult[] = []
  for (const message of messages) {
    if (!message) continue
    const plain = plainTextOf(message)
    if (!plain.toLowerCase().includes(needle)) continue
    const group = heimdallSearchRoleOf(message.role)
    counts.all += 1
    if (group) counts[group] += 1
    if (role !== 'all' && group !== role) continue
    results.push({ id: parseId(message.id as any), role: typeof message.role === 'string' ? message.role : '', plain })
  }
  return { results, counts }
}
