import type { HtmlIframeEntry } from './HtmlIframeRegistry'

/**
 * Task Manager entries crossing between the main window and the detached apps window
 * (Electron IPC, structured clone). Entries go as plain JSON; anything else is dropped.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
const finiteOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null)

/** A JSON-only copy of an entry, or null when it cannot be serialized. */
export function toTransferableEntry(entry: HtmlIframeEntry): HtmlIframeEntry | null {
  try {
    return JSON.parse(JSON.stringify(entry)) as HtmlIframeEntry
  } catch {
    return null
  }
}

/** Validate an entry received from the other window. */
export function parseTransferredEntry(value: unknown, now = Date.now()): HtmlIframeEntry | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key) return null
  const base = {
    key: value.key,
    label: stringOrNull(value.label),
    favorite: value.favorite === true,
    status: value.status === 'hibernated' ? ('hibernated' as const) : ('active' as const),
    sizeBytes: finiteOr(value.sizeBytes, 0),
    createdAt: finiteOr(value.createdAt, now),
    updatedAt: finiteOr(value.updatedAt, now),
    lastUsedAt: finiteOr(value.lastUsedAt, now),
    conversationId: stringOrNull(value.conversationId),
    projectId: stringOrNull(value.projectId),
    toolName: stringOrNull(value.toolName),
  }
  if (value.kind === 'mcp') {
    if (typeof value.serverName !== 'string' || typeof value.resourceUri !== 'string' || typeof value.qualifiedToolName !== 'string') return null
    return {
      ...base,
      kind: 'mcp',
      serverName: value.serverName,
      resourceUri: value.resourceUri,
      qualifiedToolName: value.qualifiedToolName,
      toolArgs: isRecord(value.toolArgs) ? (value.toolArgs as Record<string, any>) : null,
      toolResult: isRecord(value.toolResult) ? (value.toolResult as { content: any; is_error?: boolean }) : null,
      toolDefinition: isRecord(value.toolDefinition) ? (value.toolDefinition as any) : undefined,
      reloadToken: typeof value.reloadToken === 'number' ? value.reloadToken : undefined,
    }
  }
  if (typeof value.html !== 'string') return null
  return { ...base, kind: 'html', html: value.html, src: stringOrNull(value.src) }
}

/**
 * An entry forwarded into a list that already has it: the sender's content and status win
 * (it was just opened there), the receiver keeps the favourite flag and creation time it owns.
 */
export function mergeTransferredEntry(existing: HtmlIframeEntry | undefined, incoming: HtmlIframeEntry): HtmlIframeEntry {
  if (!existing) return incoming
  return {
    ...incoming,
    favorite: existing.favorite,
    createdAt: existing.createdAt,
    lastUsedAt: Math.max(existing.lastUsedAt, incoming.lastUsedAt),
  }
}
