import React from 'react'
import { useNavigate } from 'react-router-dom'

interface MarkdownLinkProps {
  href?: string
  children?: React.ReactNode
  [key: string]: any
}

export const MarkdownLink: React.FC<MarkdownLinkProps> = ({ href, children, ...props }) => {
  const navigate = useNavigate()

  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return

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
      onClick={handleClick}
      className='text-blue-600 dark:text-blue-400 hover:underline'
      {...props}
    >
      {children}
    </a>
  )
}
