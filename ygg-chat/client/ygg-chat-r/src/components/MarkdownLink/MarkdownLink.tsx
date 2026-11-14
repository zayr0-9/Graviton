import { isBrowserClient } from '../../platform/clientCapabilities'
import { OPEN_HOST_FILE } from '../../helpers/hostFileNavigation'
import { classifyLinkHref, gravitonNavigationRoute, type LinkTarget } from '../../helpers/linkTargets'
import { isBlockedScheme, urlScheme } from '../../../shared/linkPolicy'
import React from 'react'
import { useOptionalChatNavigate } from '../ChatSelection/ChatSelectionProvider'
import { useMarkdownLinkRoot } from './markdownLinkRoot'
import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

/**
 * Keep ReactMarkdown's sanitization, but let anchors keep the links MarkdownLink knows how to open:
 * `file:`, supported `graviton:` routes, and editor/app schemes that are not on the blocked list.
 * Scheme-less paths are already left alone by the default transform.
 */
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (node.tagName === 'a' && key === 'href') {
    const scheme = urlScheme(url)
    if (scheme === 'file') return url
    if (scheme === 'graviton') return gravitonNavigationRoute(url) ?? ''
    if (scheme && scheme !== 'http' && scheme !== 'https' && !isBlockedScheme(scheme, 'win32')) return url
  }
  return defaultUrlTransform(url)
}

function openHostFile(path: string) {
  window.dispatchEvent(new CustomEvent(OPEN_HOST_FILE, { detail: { path } }))
}

async function openWithShell(kind: 'openPath' | 'openExternal', value: string, label: string) {
  const shell = window.electronAPI?.shell
  if (!shell?.[kind]) {
    console.error(`Opening ${label} requires the desktop app`)
    return
  }
  try {
    const result = await shell[kind](value) as { success: boolean; error?: string; cancelled?: boolean }
    if (!result.success && !result.cancelled) console.error(`Failed to open ${label}:`, result.error)
  } catch (error) {
    console.error(`Error opening ${label}:`, error)
  }
}

/** Opens a classified link. Exported for tests; the anchor's click handler is the only caller. */
export async function openLinkTarget(target: LinkTarget, navigate: ((route: string) => void) | null): Promise<void> {
  switch (target.kind) {
    case 'route':
      if (navigate) navigate(target.route)
      else console.warn('App links need the chat router:', target.route)
      return
    case 'web':
      // Electron: OS default browser. Never window.open there; main would deny it anyway.
      if (window.electronAPI?.shell?.openExternal) await openWithShell('openExternal', target.url, 'external link')
      else window.open(target.url, '_blank', 'noopener,noreferrer')
      return
    case 'mail':
      if (window.electronAPI?.shell?.openExternal) await openWithShell('openExternal', target.url, 'mail link')
      else window.location.assign(target.url)
      return
    case 'file':
      // Browser clients view host files in the shared editor; the desktop opens the OS default app.
      if (isBrowserClient) openHostFile(target.path)
      else await openWithShell('openPath', target.fileUrl ?? target.path, 'local file')
      return
    case 'app':
      if (isBrowserClient) {
        // The link names a file on the host, not on this device.
        if (target.editorPath) openHostFile(target.editorPath)
        return
      }
      await openWithShell('openExternal', target.url, 'app link')
      return
    case 'unresolved':
      console.warn('Relative link has no working directory to resolve against:', target.path)
      return
    case 'hash':
    case 'blocked':
      return
  }
}

interface MarkdownLinkProps {
  href?: string
  children?: React.ReactNode
  [key: string]: any
}

export const MarkdownLink: React.FC<MarkdownLinkProps> = ({ href, children, node: _node, ...props }) => {
  // ReactMarkdown's syntax-tree node is not a DOM attribute.
  void _node
  const navigate = useOptionalChatNavigate()
  const root = useMarkdownLinkRoot()

  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    const target = classifyLinkHref(href, { cwd: root })
    // In-page anchors keep their default scrolling; nothing else may navigate the app document.
    if (target.kind === 'hash') return
    e.preventDefault()
    await openLinkTarget(target, navigate)
  }

  // Middle-click would otherwise ask Chromium for a new window with the document-relative URL.
  const handleAuxClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button === 1) void handleClick(e)
  }

  return (
    <a
      href={href}
      className='text-blue-600 dark:text-blue-400 hover:underline'
      {...props}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
    >
      {children}
    </a>
  )
}
