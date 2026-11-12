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
 *
 * Graviton's native constraints (the [MIN, MAX] range below) can be switched off in Chat
 * Settings. Heights are therefore stored as the app requested them and clamped on read, so the
 * setting applies to every app, mounted or not, the moment it changes.
 */

import { useSyncExternalStore } from 'react'

export const MCP_APP_MIN_HEIGHT = 240
/** Advertised to the app as `containerDimensions.maxHeight` while constraints are on, so the two cannot disagree. */
export const MCP_APP_MAX_HEIGHT = 600
/** Height before the app reports one. Matches the previous floor, so untouched apps look the same. */
export const MCP_APP_DEFAULT_HEIGHT = 600

const STORAGE_KEY = 'chat:mcpAppHeights'
const STORAGE_LIMIT = 300

export const buildMcpAppEntryKey = (messageId: string, toolCallId: string): string =>
  `${messageId}-${toolCallId}-mcp-app`

/**
 * Safety bounds that hold even with native constraints off. They only reject values no real
 * layout asks for (zero, negative, absurd), so a misbehaving app cannot zero out its row or
 * push the virtualized list millions of pixels tall.
 */
const UNCONSTRAINED_MIN_HEIGHT = 1
const UNCONSTRAINED_MAX_HEIGHT = 10_000

export const MCP_APP_CONSTRAINTS_KEY = 'chat:mcpAppNativeConstraints'
const CONSTRAINTS_CHANGE_EVENT = 'mcpAppNativeConstraintsChange'

/** On by default: apps are kept inside [MCP_APP_MIN_HEIGHT, MCP_APP_MAX_HEIGHT]. */
export const loadMcpAppConstraintsEnabled = (): boolean => {
  try {
    return localStorage.getItem(MCP_APP_CONSTRAINTS_KEY) !== 'false'
  } catch {
    return true
  }
}

export const saveMcpAppConstraintsEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(MCP_APP_CONSTRAINTS_KEY, String(enabled))
  } catch {
    // Storage unavailable; the event still updates this window.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONSTRAINTS_CHANGE_EVENT))
}

const subscribeConstraints = (onChange: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === MCP_APP_CONSTRAINTS_KEY || event.key === null) onChange()
  }
  window.addEventListener(CONSTRAINTS_CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CONSTRAINTS_CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export const useMcpAppConstraintsEnabled = (): boolean =>
  useSyncExternalStore(subscribeConstraints, loadMcpAppConstraintsEnabled, () => true)

/** `containerDimensions.maxHeight` to advertise; omitted when the app may size itself. */
export const getMcpAppAdvertisedMaxHeight = (
  constrained: boolean = loadMcpAppConstraintsEnabled()
): number | undefined => (constrained ? MCP_APP_MAX_HEIGHT : undefined)

/** `containerDimensions` for the MCP Apps host context. No maxHeight means the app sizes itself freely. */
export const buildMcpAppContainerDimensions = (constrained: boolean = loadMcpAppConstraintsEnabled()) => {
  const maxHeight = getMcpAppAdvertisedMaxHeight(constrained)
  return {
    width: typeof window !== 'undefined' ? window.innerWidth : undefined,
    ...(maxHeight !== undefined ? { maxHeight } : {}),
  }
}

const sanitizeMcpAppHeight = (height: number): number =>
  Math.min(UNCONSTRAINED_MAX_HEIGHT, Math.max(UNCONSTRAINED_MIN_HEIGHT, Math.round(height)))

export const clampMcpAppHeight = (height: number): number =>
  Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, Math.round(height)))

/** The height to render for a requested height under the current (or given) setting. */
export const resolveMcpAppHeight = (
  height: number,
  constrained: boolean = loadMcpAppConstraintsEnabled()
): number => (constrained ? clampMcpAppHeight(height) : sanitizeMcpAppHeight(height))

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
          heights.set(entry[0], sanitizeMcpAppHeight(entry[1]))
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

/** Height the app at `key` last asked for, as the current setting allows, or the default. */
export const getMcpAppHeight = (key: string | null | undefined, constrained?: boolean): number => {
  const requested = key ? load().get(key) : undefined
  return requested === undefined ? MCP_APP_DEFAULT_HEIGHT : resolveMcpAppHeight(requested, constrained)
}

/** Stores the requested height as asked and returns the height to render. */
export const rememberMcpAppHeight = (
  key: string | null | undefined,
  height: number,
  constrained?: boolean
): number => {
  const requested = sanitizeMcpAppHeight(height)
  const resolved = resolveMcpAppHeight(requested, constrained)
  if (!key) return resolved
  const map = load()
  if (map.get(key) === requested) return resolved
  map.delete(key)
  map.set(key, requested)
  while (map.size > STORAGE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  persist(map)
  return resolved
}
