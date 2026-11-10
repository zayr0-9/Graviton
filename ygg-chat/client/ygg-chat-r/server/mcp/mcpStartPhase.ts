// server/mcp/mcpStartPhase.ts
// Dependency-free so tools and routes can import it without loading the MCP manager.

/**
 * What a not-yet-connected server is waiting on. Two of these wait on the user, possibly
 * for minutes: `credentials` (the OS keychain prompt) and `authorizing` (browser sign-in).
 */
export type McpStartPhase = 'credentials' | 'connecting' | 'authorizing'

export const MCP_START_PHASE_MESSAGE: Record<McpStartPhase, string> = {
  credentials: 'Waiting for access to saved credentials. Check for a system keychain prompt; on macOS it can open on another display.',
  authorizing: 'Waiting for sign-in. Finish the authorization in your browser.',
  connecting: 'Still connecting.',
}

/**
 * Wait for `operation` for at most `budgetMs`. An operation that outlives the budget keeps
 * running; its outcome is then reported through server status, so its rejection is absorbed
 * here. Callers that answer an HTTP request must not hold it for an interactive sign-in:
 * the renderer has six connections per host and parked requests starve every other call.
 */
export async function settleWithin<T>(operation: Promise<T>, budgetMs: number): Promise<{ settled: true; value: T } | { settled: false }> {
  const timedOut = Symbol('timedOut')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      operation,
      new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), budgetMs) }),
    ])
    if (value !== timedOut) return { settled: true, value: value as T }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  operation.catch(() => {})
  return { settled: false }
}
