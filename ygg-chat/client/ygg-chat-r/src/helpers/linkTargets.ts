import { editorFilePath, isBlockedScheme, stripLineSuffix, urlScheme } from '../../shared/linkPolicy'
import { hostPathFromFileUrl } from './hostFileNavigation'

/** What a Markdown link click should do. Main re-checks every external URL before opening it. */
export type LinkTarget =
  | { kind: 'route'; route: string }
  | { kind: 'hash' }
  | { kind: 'web'; url: string }
  | { kind: 'mail'; url: string }
  /**
   * `path` is a native absolute path (`~/…` is expanded by main). `fileUrl` keeps an original
   * `file:` URL without a line suffix, so main can apply native (Windows/UNC) URL decoding.
   */
  | { kind: 'file'; path: string; fileUrl?: string }
  | { kind: 'app'; url: string; editorPath: string | null }
  | { kind: 'unresolved'; path: string }
  | { kind: 'blocked' }

// The renderer does not know the host OS; apply the stricter Windows list everywhere.
const RENDERER_POLICY_PLATFORM = 'win32'

// Real app routes (see App.tsx). Any other absolute path is treated as a filesystem path.
const APP_ROUTE_PATTERNS = [
  /^\/chat\/[^/]+\/[^/]+(?:\/lineage\/[^/]+)?$/,
  /^\/conversationPage$/,
  /^\/homepage$/,
  /^\/settings(?:\/[^/]*)?$/,
  /^\/logging$/,
  /^\/projects\/[^/]+\/lineages\/recent$/,
]

function isAppRoute(href: string): boolean {
  const pathname = href.replace(/[?#].*$/, '')
  return APP_ROUTE_PATTERNS.some(pattern => pattern.test(pathname))
}

// Only tool-generated chat/project routes are supported; never hand these to the OS.
export function gravitonNavigationRoute(href: string): string | null {
  if (!/^graviton:\/\/\//i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.host || url.username || url.password) return null
    const isChat = /^\/chat\/[^/]+\/[^/]+$/.test(url.pathname)
    const isProject = url.pathname === '/conversationPage' && !!url.searchParams.get('projectId')?.trim()
    if (!isChat && !isProject) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

const isWindowsAbsolute = (path: string) => /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]/.test(path)

/** Joins a relative link path to an absolute root, resolving `.`/`..` and using the root's separators. */
export function joinLinkPath(root: string, relative: string): string {
  const windows = isWindowsAbsolute(root)
  const sep = windows ? '\\' : '/'
  let prefix: string
  let rest: string
  if (/^\\\\/.test(root)) { prefix = '\\\\'; rest = root.slice(2) }
  else if (/^[a-z]:/i.test(root)) { prefix = `${root.slice(0, 2).toUpperCase()}\\`; rest = root.slice(2) }
  else { prefix = '/'; rest = root }

  const segments: string[] = []
  for (const segment of `${rest}/${relative}`.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') { segments.pop(); continue }
    segments.push(segment)
  }
  return prefix + segments.join(sep)
}

function nativeAbsolute(path: string): string {
  // `C:/x` → `C:\x` so Windows shell APIs get native separators.
  return /^[a-z]:\//i.test(path) ? path.replace(/\//g, '\\') : path
}

export function classifyLinkHref(href: string | undefined, options: { cwd?: string | null } = {}): LinkTarget {
  const value = href?.trim()
  if (!value) return { kind: 'blocked' }
  if (value.startsWith('#')) return { kind: 'hash' }
  if (value.startsWith('//')) return { kind: 'web', url: `https:${value}` }

  const scheme = urlScheme(value)
  if (scheme) {
    if (scheme === 'graviton') {
      const route = gravitonNavigationRoute(value)
      return route ? { kind: 'route', route } : { kind: 'blocked' }
    }
    if (scheme === 'http' || scheme === 'https') return { kind: 'web', url: value }
    if (scheme === 'mailto' || scheme === 'tel') return { kind: 'mail', url: value }
    if (scheme === 'file') {
      const path = hostPathFromFileUrl(value)
      if (!path) return { kind: 'blocked' }
      const stripped = stripLineSuffix(path)
      return { kind: 'file', path: nativeAbsolute(stripped), ...(stripped === path && !/#/.test(value) ? { fileUrl: value } : {}) }
    }
    if (isBlockedScheme(scheme, RENDERER_POLICY_PLATFORM)) return { kind: 'blocked' }
    return { kind: 'app', url: value, editorPath: editorFilePath(value) }
  }

  if (value.startsWith('/') && isAppRoute(value)) return { kind: 'route', route: value }

  // Query strings and fragments (`#L12`, `#heading`) are not part of a filesystem path.
  const path = stripLineSuffix(safeDecode(value.replace(/[?#].*$/, '')))
  if (!path) return { kind: 'blocked' }
  if (path.startsWith('/') || isWindowsAbsolute(path) || path === '~' || /^~[\\/]/.test(path)) {
    return { kind: 'file', path: nativeAbsolute(path) }
  }
  const root = options.cwd?.trim()
  if (!root || !(root.startsWith('/') || isWindowsAbsolute(root))) return { kind: 'unresolved', path }
  return { kind: 'file', path: joinLinkPath(root, path) }
}
