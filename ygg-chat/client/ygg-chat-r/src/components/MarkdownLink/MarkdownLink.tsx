import { isBrowserClient } from '../../platform/clientCapabilities'
import { OPEN_HOST_FILE, hostPathFromFileUrl } from '../../helpers/hostFileNavigation'
import React from 'react'
import { useChatNavigate as useNavigate } from '../ChatSelection/ChatSelectionProvider'
import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

// Only tool-generated chat/project routes are supported; never hand these to the OS.
function gravitonNavigationRoute(href: string): string | null {
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

// Keep ReactMarkdown's sanitization; extra schemes are allowed only as clickable links.
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (node.tagName === 'a' && key === 'href') {
    if (/^file:/i.test(url)) return url
    if (/^graviton:/i.test(url)) return gravitonNavigationRoute(url) ?? ''
  }
  return defaultUrlTransform(url)
}

interface MarkdownLinkProps {
  href?: string
  children?: React.ReactNode
  [key: string]: any
}

export const MarkdownLink: React.FC<MarkdownLinkProps> = ({ href, children, ...props }) => {
  const navigate = useNavigate()

  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) {
      e.preventDefault()
      return
    }

    if (/^graviton:/i.test(href)) {
      e.preventDefault()
      const route = gravitonNavigationRoute(href)
      if (route) navigate(route)
      return
    }

    if (/^file:/i.test(href)) {
      e.preventDefault()
      if (isBrowserClient) {
        const path = hostPathFromFileUrl(href)
        if (path) window.dispatchEvent(new CustomEvent(OPEN_HOST_FILE, { detail: { path } }))
        return
      }
      if (!window.electronAPI?.shell?.openPath) {
        console.error('Opening local file links requires the desktop app')
        return
      }

      try {
        const result = await window.electronAPI.shell.openPath(href)
        if (!result.success) {
          console.error('Failed to open local file:', result.error)
        }
      } catch (error) {
        console.error('Error opening local file:', error)
      }
      return
    }

    // Special protocol links (mailto:, tel:) - let them through normally
    if (href.startsWith('mailto:') || href.startsWith('tel:')) {
      return
    }

    // Check if it's an external link (starts with http://, https://, or //)
    const isExternal = /^(https?:)?\/\//.test(href)

    if (isExternal) {
      e.preventDefault()
      const externalHref = href.startsWith('//') ? `https:${href}` : href

      if (window.electronAPI?.auth?.openExternal) {
        // Electron: use the OS default browser. Never fall back to window.open here,
        // because Chromium turns that into another Electron BrowserWindow.
        try {
          const result = await window.electronAPI.auth.openExternal(externalHref)
          if (!result.success) {
            console.error('Failed to open external link:', result.error)
          }
        } catch (error) {
          console.error('Error opening external link:', error)
        }
      } else {
        window.open(externalHref, '_blank', 'noopener,noreferrer')
      }
    } else if (href.startsWith('/')) {
      // Internal absolute path - use React Router
      e.preventDefault()
      navigate(href)
    }
    // Relative paths and hash links: let default behavior handle them
  }

  return (
    <a
      href={href}
      className='text-blue-600 dark:text-blue-400 hover:underline'
      {...props}
      onClick={handleClick}
    >
      {children}
    </a>
  )
}
