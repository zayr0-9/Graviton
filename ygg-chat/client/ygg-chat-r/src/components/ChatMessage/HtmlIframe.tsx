import React, { useEffect, useRef } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { attachMessageBridge } from '../../utils/iframeBridge'

interface HtmlIframeProps {
  html: string
  fullHeight?: boolean
  toolName?: string | null
}

export const HtmlIframe: React.FC<HtmlIframeProps> = ({ html, fullHeight = false, toolName = null }) => {
  const { userId } = useAuth()
  const userIdRef = useRef<string | null>(null)
  const toolNameRef = useRef<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    userIdRef.current = userId ?? null
  }, [userId])

  useEffect(() => {
    toolNameRef.current = toolName ?? null
  }, [toolName])

  useEffect(() => {
    const cleanup = attachMessageBridge(
      () => iframeRef.current,
      () => userIdRef.current,
      () => ({ toolName: toolNameRef.current })
    )
    return cleanup
  }, [])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      className={fullHeight ? 'w-full h-full bg-white' : 'w-full min-h-[800px] rounded-lg bg-white'}
      style={{ border: 'none' }}
      title='HTML Preview'
      allow='fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
      allowFullScreen
      referrerPolicy='strict-origin-when-cross-origin'
      sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-presentation'
    />
  )
}
