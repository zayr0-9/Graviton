import React, { useEffect, useMemo, useRef, useState } from 'react'
import { attachCustomToolIframeBridge } from '../customToolIframeBridge'

interface CustomToolIframeProps {
  html?: string
  toolName?: string | null
  userId?: string | null
  rootPath?: string | null
  src?: string | null
  warning?: string | null
}

export const CustomToolIframe: React.FC<CustomToolIframeProps> = ({
  html,
  toolName = null,
  userId = null,
  rootPath = null,
  src = null,
  warning = null,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    const cleanup = attachCustomToolIframeBridge(iframe, {
      toolName,
      userId,
      rootPath,
    })

    return () => cleanup()
  }, [rootPath, toolName, userId])

  const shouldGate = Boolean(src && warning && !acknowledged)
  const resolvedSrc = useMemo(() => {
    if (src) return src
    if (!html) return undefined
    return undefined
  }, [src, html])

  return (
    <div className='mobile-custom-tool-iframe-wrap'>
      {shouldGate ? (
        <div className='mobile-custom-tool-warning'>
          <div className='mobile-custom-tool-warning-title'>Desktop-oriented custom app</div>
          <div className='mobile-custom-tool-warning-body'>{warning}</div>
          <button type='button' className='mobile-tool-app-toggle' onClick={() => setAcknowledged(true)}>
            Proceed anyway
          </button>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={resolvedSrc}
          srcDoc={!resolvedSrc ? html : undefined}
          className='mobile-custom-tool-iframe'
          style={{ border: 'none' }}
          title={toolName ? `Custom Tool: ${toolName}` : 'Custom Tool App'}
          allow='fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
          referrerPolicy='strict-origin-when-cross-origin'
          sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads'
        />
      )}
    </div>
  )
}
