// Link policy shared by the renderer (what a Markdown click may attempt) and Electron main
// (what it will actually hand to the OS). Main is the enforcement point; the renderer copy only
// keeps links clickable and avoids pointless IPC.

/** Editors and IDEs whose URL handlers open local files. These open without a prompt. */
export const EDITOR_SCHEMES: ReadonlySet<string> = new Set([
  'vscode', 'vscode-insiders', 'vscodium', 'cursor', 'windsurf', 'zed',
  'idea', 'jetbrains', 'pycharm', 'webstorm', 'phpstorm', 'goland', 'rider', 'clion', 'rubymine',
  'sublime', 'subl', 'txmt', 'mvim',
])

/** Schemes that run code, read local data or have a history of OS handler exploits. */
const ALWAYS_BLOCKED = new Set([
  'javascript', 'vbscript', 'data', 'blob', 'about', 'chrome', 'chrome-extension', 'devtools',
  'view-source', 'filesystem', 'ldap', 'ldaps', 'jar', 'res',
])
const WINDOWS_BLOCKED = new Set(['search', 'search-ms', 'smb', 'ms-officecmd', 'ms-msdt', 'ms-cxh', 'ms-cxh-full', 'ms-appinstaller'])

/** Lowercase URL scheme without the colon, or null for relative/scheme-less values. */
export function urlScheme(value: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim())
  if (!match) return null
  // A single letter followed by `:\` or `:/` is a Windows drive, not a scheme.
  if (match[1].length === 1 && /^[a-z]:[\\/]/i.test(value.trim())) return null
  return match[1].toLowerCase()
}

export function isEditorScheme(scheme: string | null): boolean {
  return Boolean(scheme && EDITOR_SCHEMES.has(scheme))
}

/** True for schemes never handed to the OS. `file:` is not blocked here; it goes through openPath. */
export function isBlockedScheme(scheme: string | null, platform: string): boolean {
  if (!scheme) return false
  if (ALWAYS_BLOCKED.has(scheme)) return true
  return platform === 'win32' && (WINDOWS_BLOCKED.has(scheme) || scheme.startsWith('ms-'))
}

export type ExternalLinkKind = 'web' | 'mail' | 'editor' | 'app' | 'file' | 'blocked'

export function externalLinkKind(url: string, platform: string): ExternalLinkKind {
  const scheme = urlScheme(url)
  if (!scheme) return 'blocked'
  if (scheme === 'http' || scheme === 'https') return 'web'
  if (scheme === 'mailto' || scheme === 'tel') return 'mail'
  if (scheme === 'file') return 'file'
  if (isBlockedScheme(scheme, platform)) return 'blocked'
  return isEditorScheme(scheme) ? 'editor' : 'app'
}

/** Removes `:12`, `:12:3`, `#L12` and `#L12-L20` style line anchors from a path. */
export function stripLineSuffix(path: string): string {
  return path.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, '').replace(/(?<=[^:\\/]):\d+(?::\d+)?$/, '')
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/**
 * Local file path named by an editor link, without its line suffix, or null.
 * Covers `vscode://file/<abs>:l:c` (and the VS Code family), `zed://file/<abs>`,
 * JetBrains `idea://open?file=<abs>&line=`, and `subl|txmt|mvim://open?url=file://<abs>`.
 */
export function editorFilePath(url: string): string | null {
  const scheme = urlScheme(url)
  if (!isEditorScheme(scheme)) return null
  const rest = url.trim().slice(scheme!.length + 1).replace(/^\/\//, '')
  const queryIndex = rest.indexOf('?')
  const location = queryIndex === -1 ? rest : rest.slice(0, queryIndex)
  const query = new URLSearchParams(queryIndex === -1 ? '' : rest.slice(queryIndex + 1))

  const fileParam = query.get('file') ?? query.get('path')
  if (fileParam) return stripLineSuffix(fileParam)
  const urlParam = query.get('url')
  if (urlParam && /^file:/i.test(urlParam)) {
    try {
      const parsed = new URL(urlParam)
      const pathname = safeDecode(parsed.pathname)
      return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname
    } catch { return null }
  }
  const fileMatch = /^file(\/.*)$/i.exec(location)
  if (!fileMatch) return null
  let path = safeDecode(fileMatch[1])
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1)
  return stripLineSuffix(path) || null
}
