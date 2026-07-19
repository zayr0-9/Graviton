import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localApi, environment } from '../../utils/api'
import {
  buildCspValue,
  buildIframeAllow,
  decodeResourceHtml,
  injectCspMeta,
  type McpUiMeta,
  type McpUiPermissions,
  type McpUiResource,
} from '../../utils/mcpApps'
import type { ToolDefinition } from '../../features/chats/toolDefinitions'
import { getMcpTools } from '../../features/chats/toolDefinitions'
import { normalizeMcpAppToolResult, type McpAppToolResultEnvelope } from '../../utils/mcpAppToolResult'

type McpAppIframeProps = {
  serverName: string
  qualifiedToolName: string
  resourceUri: string
  toolArgs?: Record<string, any> | null
  toolResult?: McpAppToolResultEnvelope | null
  toolDefinition?: ToolDefinition
  className?: string
  reloadToken?: number
}

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: any
}

type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: any
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string
  result?: any
  error?: { code: number; message: string; data?: any }
}

const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
const BASE_ALLOW =
  'fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'

const buildHostContext = (toolDefinition?: ToolDefinition, fallbackToolName?: string) => {
  const isDark = document.documentElement.classList.contains('dark')
  const theme = isDark ? 'dark' : 'light'
  const locale = typeof navigator !== 'undefined' ? navigator.language : undefined
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    toolInfo: toolDefinition
      ? {
          tool: {
            name: toolDefinition.name,
            description: toolDefinition.description,
            inputSchema: toolDefinition.inputSchema,
          },
        }
      : fallbackToolName
        ? { tool: { name: fallbackToolName } }
        : undefined,
    theme,
    platform: environment === 'electron' ? 'desktop' : 'web',
    locale,
    timeZone,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    displayMode: 'inline',
    containerDimensions: {
      width: typeof window !== 'undefined' ? window.innerWidth : undefined,
      maxHeight: 600,
    },
  }
}

const buildHostCapabilities = (uiMeta?: McpUiMeta) => {
  const sandboxPermissions = uiMeta?.permissions
  const csp = uiMeta?.csp
  return {
    openLinks: {},
    serverTools: {},
    serverResources: {},
    logging: {},
    sandbox: {
      permissions: sandboxPermissions,
      csp,
    },
  }
}

export const McpAppIframe: React.FC<McpAppIframeProps> = ({
  serverName,
  qualifiedToolName,
  resourceUri,
  toolArgs,
  toolResult,
  toolDefinition,
  className,
  reloadToken,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [uiMeta, setUiMeta] = useState<McpUiMeta | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const appReadyRef = useRef(false)
  const toolInputSentRef = useRef(false)
  const lastResultHashRef = useRef<string | null>(null)
  const hostRequestIdRef = useRef(1)

  const hostContext = useMemo(
    () => buildHostContext(toolDefinition, qualifiedToolName),
    [qualifiedToolName, toolDefinition]
  )

  const sendMessage = useCallback((payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => {
    iframeRef.current?.contentWindow?.postMessage(payload, '*')
  }, [])

  const sendNotification = useCallback(
    (method: string, params?: any) => {
      sendMessage({ jsonrpc: '2.0', method, params })
    },
    [sendMessage]
  )

  const sendRequest = useCallback(
    (method: string, params?: any) => {
      const id = hostRequestIdRef.current++
      sendMessage({ jsonrpc: '2.0', id, method, params })
    },
    [sendMessage]
  )

  const sendToolInput = useCallback(() => {
    if (toolInputSentRef.current) return
    sendNotification('ui/notifications/tool-input', { arguments: toolArgs || {} })
    toolInputSentRef.current = true
  }, [sendNotification, toolArgs])

  const sendToolResult = useCallback(
    (result: { content: any; is_error?: boolean } | null) => {
      if (!result) return
      const normalized = normalizeMcpAppToolResult(result)
      if (!normalized) return
      const hash = JSON.stringify(normalized)
      if (lastResultHashRef.current === hash) return
      sendNotification('ui/notifications/tool-result', normalized)
      lastResultHashRef.current = hash
    },
    [sendNotification]
  )

  const ensureReadyAndSend = useCallback(() => {
    if (!appReadyRef.current) return
    sendToolInput()
    sendToolResult(toolResult ?? null)
  }, [sendToolInput, sendToolResult, toolResult])

  useEffect(() => {
    let cancelled = false
    const loadResource = async () => {
      try {
        setLoadError(null)
        const response = await localApi.post<{ success: boolean; result?: { contents?: McpUiResource[] } }>(
          '/mcp/resources/read',
          { serverName, uri: resourceUri }
        )
        if (!response?.success) {
          throw new Error('Failed to read MCP resource')
        }
        const resource = response.result?.contents?.[0]
        if (!resource) {
          throw new Error('No resource content returned')
        }
        const resourceHtml = decodeResourceHtml(resource)
        if (!resourceHtml) {
          throw new Error('Resource HTML missing or invalid')
        }
        if (resource.mimeType && resource.mimeType !== MCP_APP_MIME_TYPE) {
          console.warn(`[McpApp] Unexpected mimeType: ${resource.mimeType}`)
        }
        const resourceUi = resource._meta?.ui
        const cspValue = buildCspValue(resourceUi?.csp)
        const htmlWithCsp = injectCspMeta(resourceHtml, cspValue)
        if (!cancelled) {
          setUiMeta(resourceUi)
          setHtml(htmlWithCsp)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void loadResource()
    return () => {
      cancelled = true
    }
  }, [resourceUri, serverName, reloadToken])

  useEffect(() => {
    if (!appReadyRef.current) return
    sendToolResult(toolResult ?? null)
  }, [toolResult, sendToolResult])

  useEffect(() => {
    if (!html) return
    appReadyRef.current = false
    toolInputSentRef.current = false
    lastResultHashRef.current = null
  }, [html])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      const message = event.data as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
      if (!message || (message as any).jsonrpc !== '2.0') return

      if ('method' in message) {
        if ('id' in message && message.id !== undefined) {
          void handleRequest(message as JsonRpcRequest)
        } else {
          handleNotification(message as JsonRpcNotification)
        }
        return
      }
    }

    const handleRequest = async (request: JsonRpcRequest) => {
      const respond = (payload: JsonRpcResponse) => sendMessage(payload)
      const fail = (id: number | string, messageText: string) =>
        respond({ jsonrpc: '2.0', id, error: { code: -32000, message: messageText } })

      switch (request.method) {
        case 'ui/initialize': {
          const result = {
            protocolVersion: request.params?.protocolVersion || '2025-06-18',
            hostCapabilities: buildHostCapabilities(uiMeta),
            hostInfo: { name: 'ygg-chat', version: '1.0.0' },
            hostContext,
          }
          respond({ jsonrpc: '2.0', id: request.id, result })
          return
        }

        case 'tools/call': {
          const name = request.params?.name
          const args = request.params?.arguments ?? {}
          if (!name || typeof name !== 'string') {
            fail(request.id, 'Missing tool name')
            return
          }
          const qualified =
            name.startsWith('mcp__') ? name : `mcp__${serverName}__${name}`
          if (!qualified.startsWith(`mcp__${serverName}__`)) {
            fail(request.id, 'Cross-server tool calls are not allowed')
            return
          }
          const toolMeta = getMcpTools().find(t => t.name === qualified)
          const visibility = toolMeta?.mcpUi?.visibility
          if (Array.isArray(visibility) && !visibility.includes('app')) {
            fail(request.id, 'Tool not available to app')
            return
          }
          try {
            const response = await localApi.post<{ success: boolean; result?: any; error?: string }>(
              '/mcp/tools/call',
              { name: qualified, arguments: args }
            )
            if (!response?.success) {
              fail(request.id, response?.error || 'Tool call failed')
              return
            }
            respond({ jsonrpc: '2.0', id: request.id, result: response.result })
          } catch (err) {
            fail(request.id, err instanceof Error ? err.message : String(err))
          }
          return
        }

        case 'tools/list': {
          try {
            const response = await localApi.get<{ success: boolean; tools?: any[] }>('/mcp/tools')
            if (!response?.success || !Array.isArray(response.tools)) {
              fail(request.id, 'Failed to list tools')
              return
            }
            const tools = response.tools
              .filter(tool => tool.serverName === serverName)
              .filter(tool => {
                const visibility = tool?._meta?.ui?.visibility
                return !Array.isArray(visibility) || visibility.includes('app')
              })
              .map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                _meta: tool._meta,
              }))
            respond({ jsonrpc: '2.0', id: request.id, result: { tools } })
          } catch (err) {
            fail(request.id, err instanceof Error ? err.message : String(err))
          }
          return
        }

        case 'resources/read': {
          const uri = request.params?.uri
          if (!uri || typeof uri !== 'string') {
            fail(request.id, 'Missing resource uri')
            return
          }
          try {
            const response = await localApi.post<{ success: boolean; result?: any; error?: string }>(
              '/mcp/resources/read',
              { serverName, uri }
            )
            if (!response?.success) {
              fail(request.id, response?.error || 'Resource read failed')
              return
            }
            respond({ jsonrpc: '2.0', id: request.id, result: response.result })
          } catch (err) {
            fail(request.id, err instanceof Error ? err.message : String(err))
          }
          return
        }

        case 'resources/list': {
          try {
            const response = await localApi.get<{ success: boolean; resources?: any[] }>('/mcp/resources')
            if (!response?.success || !Array.isArray(response.resources)) {
              fail(request.id, 'Failed to list resources')
              return
            }
            const resources = response.resources.filter(r => r.serverName === serverName)
            respond({ jsonrpc: '2.0', id: request.id, result: { resources } })
          } catch (err) {
            fail(request.id, err instanceof Error ? err.message : String(err))
          }
          return
        }

        case 'ui/open-link': {
          const url = request.params?.url
          if (!url || typeof url !== 'string') {
            fail(request.id, 'Invalid URL')
            return
          }
          try {
            const electronApi = (window as any).electronAPI
            if (electronApi?.auth?.openExternal) {
              await electronApi.auth.openExternal(url)
            } else {
              window.open(url, '_blank', 'noopener')
            }
            respond({ jsonrpc: '2.0', id: request.id, result: {} })
          } catch (err) {
            fail(request.id, err instanceof Error ? err.message : String(err))
          }
          return
        }

        case 'ui/request-display-mode': {
          respond({ jsonrpc: '2.0', id: request.id, result: { mode: 'inline' } })
          return
        }

        case 'ui/message':
        case 'ui/update-model-context':
          respond({ jsonrpc: '2.0', id: request.id, result: {} })
          return

        case 'ping':
          respond({ jsonrpc: '2.0', id: request.id, result: {} })
          return

        case 'ui/resource-teardown':
          respond({ jsonrpc: '2.0', id: request.id, result: {} })
          return

        default:
          fail(request.id, `Unsupported method: ${request.method}`)
      }
    }

    const handleNotification = (notification: JsonRpcNotification) => {
      switch (notification.method) {
        case 'ui/notifications/initialized':
          appReadyRef.current = true
          ensureReadyAndSend()
          break
        case 'ui/notifications/size-changed': {
          const iframe = iframeRef.current
          if (!iframe) break
          const { width, height } = notification.params || {}
          if (typeof width === 'number') {
            iframe.style.width = `${width}px`
          }
          if (typeof height === 'number') {
            iframe.style.height = `${height}px`
          }
          break
        }
        case 'notifications/message':
          console.log('[McpApp] message', notification.params)
          break
        default:
          // Ignore other notifications
          break
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [ensureReadyAndSend, hostContext, sendMessage, serverName, uiMeta])

  useEffect(() => {
    return () => {
      if (!iframeRef.current) return
      sendRequest('ui/resource-teardown', { reason: 'unmount' })
    }
  }, [sendRequest])

  const permissions = uiMeta?.permissions
  const allowAttr = useMemo(() => buildIframeAllow(permissions as McpUiPermissions | undefined, BASE_ALLOW), [permissions])

  if (loadError) {
    return (
      <div className='rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-700/60 dark:bg-red-900/20 dark:text-red-200'>
        MCP App failed to load: {loadError}
      </div>
    )
  }

  if (!html) {
    return (
      <div className='rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'>
        Loading MCP App…
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      className={className ?? 'w-full min-h-[600px] rounded-lg bg-white'}
      style={{ border: 'none' }}
      title='MCP App'
      allow={allowAttr}
      allowFullScreen
      referrerPolicy='strict-origin-when-cross-origin'
      sandbox='allow-scripts allow-same-origin'
    />
  )
}
