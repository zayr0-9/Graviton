import { useCallback, useEffect, useRef, useState } from 'react'
import type { BranchModelSelection } from '../features/chats/branchModelSelection'

export function needsModelSwitchConfirmation(current: BranchModelSelection | null, next: BranchModelSelection): boolean {
  return Boolean(current && (current.provider !== next.provider || (next.model !== null && current.model !== next.model)))
}

/** Keep proposed changes out of Redux/cache/storage until explicitly confirmed. */
export function useModelSwitchConfirmation(scope: string, current: BranchModelSelection | null) {
  const [pending, setPending] = useState<{
    scope: string; from: BranchModelSelection; to: BranchModelSelection; apply: () => void
  } | null>(null)
  const latest = useRef({ scope, current })
  latest.current = { scope, current }
  useEffect(() => { setPending(null) }, [scope])

  const request = useCallback((to: BranchModelSelection, apply: () => void, originScope = scope) => {
    if (latest.current.scope !== originScope) return
    const from = latest.current.current
    if (needsModelSwitchConfirmation(from, to)) setPending({ scope: originScope, from: from!, to, apply })
    else apply()
  }, [scope])
  const cancel = useCallback(() => setPending(null), [])
  const confirm = useCallback(() => {
    setPending(null)
    if (pending && pending.scope === latest.current.scope &&
      pending.from.provider === latest.current.current?.provider && pending.from.model === latest.current.current?.model) pending.apply()
  }, [pending])
  return { pending: pending?.scope === scope ? pending : null, request, cancel, confirm }
}
