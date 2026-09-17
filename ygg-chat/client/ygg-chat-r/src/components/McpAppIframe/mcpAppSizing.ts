/**
 * Height contract for inline MCP app iframes.
 *
 * The chat list is virtualized, so a row whose height changes after mount shifts scrollTop
 * for every row above the viewport. An MCP app used to go through three heights per mount:
 * the loading box, the `min-h-[600px]` floor, then whatever `ui/notifications/size-changed`
 * asked for. This module remembers the settled height per tool call so the second and every
 * later mount render at the right size on the first frame, and the row estimator can match.
 *
 * Keys are `${messageId}-${toolCallId}-mcp-app`, the same key the fullscreen viewer uses.
 * Message ids are unique per branch, so parallel forks never share a height.
 */

export const MCP_APP_MIN_HEIGHT = 240
/** Also advertised to the app as `containerDimensions.maxHeight`, so the two cannot disagree. */
export const MCP_APP_MAX_HEIGHT = 600
/** Height before the app reports one. Matches the previous floor, so untouched apps look the same. */
export const MCP_APP_DEFAULT_HEIGHT = 600

const STORAGE_KEY = 'chat:mcpAppHeights'
const STORAGE_LIMIT = 300

export const buildMcpAppEntryKey = (messageId: string, toolCallId: string): string =>
  `${messageId}-${toolCallId}-mcp-app`

export const clampMcpAppHeight = (height: number): number =>
  Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, Math.round(height)))

// Insertion order doubles as recency: a remembered key is deleted and re-set on every write.
let heights: Map<string, number> | null = null

const load = (): Map<string, number> => {
  if (heights) return heights
  heights = new Map()
  if (typeof window === 'undefined') return heights
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          heights.set(entry[0], clampMcpAppHeight(entry[1]))
        }
      }
    }
  } catch {
    // Storage can be unavailable or hold stale JSON. Start empty either way.
  }
  return heights
}

const persist = (map: Map<string, number>) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(map.entries())))
  } catch {
    // Quota or private mode. The in-memory map still serves this session.
  }
}

/** Last height the app at `key` asked for, or the default when it never has. */
export const getMcpAppHeight = (key: string | null | undefined): number => {
  if (!key) return MCP_APP_DEFAULT_HEIGHT
  return load().get(key) ?? MCP_APP_DEFAULT_HEIGHT
}

export const rememberMcpAppHeight = (key: string | null | undefined, height: number): number => {
  const clamped = clampMcpAppHeight(height)
  if (!key) return clamped
  const map = load()
  if (map.get(key) === clamped) return clamped
  map.delete(key)
  map.set(key, clamped)
  while (map.size > STORAGE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  persist(map)
  return clamped
}
