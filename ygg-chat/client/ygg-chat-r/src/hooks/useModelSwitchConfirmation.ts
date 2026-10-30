import { useCallback, useEffect, useRef, useState } from 'react'
import type { BranchModelSelection } from '../features/chats/branchModelSelection'

/** Provider prompt caches expire within minutes; an idle branch has nothing left to invalidate. */
export const MODEL_SWITCH_CACHE_TTL_MS = 10 * 60 * 1000

export function needsModelSwitchConfirmation(current: BranchModelSelection | null, next: BranchModelSelection): boolean {
  return Boolean(current && (current.provider !== next.provider || (next.model !== null && current.model !== next.model)))
}

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker; Date would read it as local time.
function parseActivityTime(value: string): number {
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
  return new Date(sqlite ? `${value.replace(' ', 'T')}Z` : value).getTime()
}

/** `null` means the branch has no cacheable history (new chat, fresh post-summary handoff).
 * An unparseable timestamp is treated as recent so the warning errs on the side of showing. */
export function isPromptCacheAtStake(lastActivityAt: string | null | undefined, now = Date.now()): boolean {
  if (lastActivityAt === null) return false
  if (lastActivityAt === undefined) return true
  const time = parseActivityTime(lastActivityAt)
  return !Number.isFinite(time) || now - time < MODEL_SWITCH_CACHE_TTL_MS
}

/** Keep proposed changes out of Redux/cache/storage until explicitly confirmed. */
export function useModelSwitchConfirmation(scope: string, current: BranchModelSelection | null, lastActivityAt?: string | null) {
  const [pending, setPending] = useState<{
    scope: string; from: BranchModelSelection; to: BranchModelSelection; apply: () => void
  } | null>(null)
  const latest = useRef({ scope, current, lastActivityAt })
  latest.current = { scope, current, lastActivityAt }
  useEffect(() => { setPending(null) }, [scope])

  const request = useCallback((to: BranchModelSelection, apply: () => void, originScope = scope) => {
    if (latest.current.scope !== originScope) return
    const from = latest.current.current
    // Age is checked at request time: an idle branch may not have re-rendered since it went cold.
    if (needsModelSwitchConfirmation(from, to) && isPromptCacheAtStake(latest.current.lastActivityAt)) {
      setPending({ scope: originScope, from: from!, to, apply })
    } else apply()
  }, [scope])
  const cancel = useCallback(() => setPending(null), [])
  const confirm = useCallback(() => {
    setPending(null)
    if (pending && pending.scope === latest.current.scope &&
      pending.from.provider === latest.current.current?.provider && pending.from.model === latest.current.current?.model) pending.apply()
  }, [pending])
  return { pending: pending?.scope === scope ? pending : null, request, cancel, confirm }
}
