import { useQueryClient } from '@tanstack/react-query'
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ContentBlock, Message } from '../../features/chats/chatTypes'
import { getMcpTools, getToolByName, type ToolDefinition } from '../../features/chats/toolDefinitions'
import type { Conversation } from '../../features/conversations/conversationTypes'
import { useAuth } from '../../hooks/useAuth'
import {
  getHtmlToolsFromCache,
  htmlToolsQueryKey,
  useHtmlToolsCache,
  type HtmlToolRecord,
} from '../../hooks/useQueries'
import { buildCachedLocalApiUrl, environment, localApi } from '../../utils/api'
import { attachMessageBridge as attachSharedMessageBridge } from '../../utils/iframeBridge'
import {
  buildCspValue,
  buildIframeAllow,
  decodeResourceHtml,
  injectCspMeta,
  type McpUiMeta,
  type McpUiPermissions,
  type McpUiResource,
} from '../../utils/mcpApps'
import { normalizeMcpAppToolResult } from '../../utils/mcpAppToolResult'
import { McpAppIframe } from '../McpAppIframe/McpAppIframe'

type HtmlIframeEntryBase = {
  key: string
  label: string | null
  favorite: boolean
  status: 'active' | 'hibernated'
  sizeBytes: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  conversationId?: string | null
  projectId?: string | null
  toolName?: string | null
  kind: 'html' | 'mcp'
}

type HtmlIframeHtmlEntry = HtmlIframeEntryBase & {
  kind: 'html'
  html: string
  src?: string | null
}

type HtmlIframeMcpEntry = HtmlIframeEntryBase & {
  kind: 'mcp'
  serverName: string
  resourceUri: string
  qualifiedToolName: string
  toolArgs?: Record<string, any> | null
  toolResult?: { content: any; is_error?: boolean } | null
  toolDefinition?: ToolDefinition
  reloadToken?: number
}

type HtmlIframeEntry = HtmlIframeHtmlEntry | HtmlIframeMcpEntry

type HtmlToolsSettings = {
  maxActive: number
  maxCached: number
  maxBytes: number
  ttlMinutes: number
  hibernateAfterMinutes: number
}

type HtmlIframeRegistryContextValue = {
  entries: HtmlIframeEntry[]
  registerEntry: (
    key: string,
    html: string,
    label?: string | null,
    meta?: { conversationId?: string | null; projectId?: string | null; toolName?: string | null }
  ) => void
  registerMcpEntry: (
    key: string,
    payload: {
      serverName: string
      resourceUri: string
      qualifiedToolName: string
      toolArgs?: Record<string, any> | null
      toolResult?: { content: any; is_error?: boolean } | null
      toolDefinition?: ToolDefinition
      reloadToken?: number
    },
    label?: string | null,
    meta?: { conversationId?: string | null; projectId?: string | null }
  ) => void
  updateIframe: (
    key: string,
    html: string,
    fullHeight: boolean,
    label?: string | null,
    meta?: { conversationId?: string | null; projectId?: string | null; toolName?: string | null }
  ) => void
  updateMcpIframe: (
    key: string,
    payload: {
      serverName: string
      resourceUri: string
      qualifiedToolName: string
      toolArgs?: Record<string, any> | null
      toolResult?: { content: any; is_error?: boolean } | null
      toolDefinition?: ToolDefinition
      reloadToken?: number
      className?: string
    }
  ) => void
  setTarget: (key: string, target: HTMLElement | null, ownerId: string, priority?: number) => void
  isModalOpen: boolean
  focusKey: string | null
  openModal: (focusKey?: string | null) => void
  closeModal: () => void
  isHomepageFullscreen: boolean
  setHomepageFullscreen: (open: boolean) => void
  touchEntry: (key: string) => void
  toggleFavorite: (key: string) => void
  hibernateEntry: (key: string) => void
  restoreEntry: (key: string) => void
  removeEntry: (key: string) => void
  bootstrapFromLocalCache: (userId: string) => Promise<void>
  settings: HtmlToolsSettings
  updateSettings: (updates: Partial<HtmlToolsSettings>) => void
}

type IframeRecord = {
  iframe: HTMLIFrameElement
  html: string
  src?: string | null
  fullHeight: boolean
  toolName?: string | null
  cleanup: () => void
  positionCleanup?: () => void
  activeTarget?: HTMLElement | null
}

type McpIframeRecord = {
  iframe: HTMLIFrameElement
  cleanup: () => void
  positionCleanup?: () => void
  activeTarget?: HTMLElement | null
  serverName: string
  resourceUri: string
  qualifiedToolName: string
  toolArgs?: Record<string, any> | null
  toolResult?: { content: any; is_error?: boolean } | null
  toolDefinition?: ToolDefinition
  reloadToken?: number
  className?: string
  uiMeta?: McpUiMeta
  appReady: boolean
  toolInputSent: boolean
  lastResultHash: string | null
  hostRequestId: number
  loadSeq: number
  sendToolResult: (result: { content: any; is_error?: boolean } | null) => void
  ensureReadyAndSend: () => void
  sendRequest: (method: string, params?: any) => void
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

type TargetEntry = { target: HTMLElement; priority: number; order: number }

const HtmlIframeRegistryContext = createContext<HtmlIframeRegistryContextValue | null>(null)

export const useHtmlIframeRegistry = () => useContext(HtmlIframeRegistryContext)

const DEFAULT_SETTINGS: HtmlToolsSettings = {
  maxActive: 6,
  maxCached: 20,
  maxBytes: 8 * 1024 * 1024,
  ttlMinutes: 12 * 60,
  hibernateAfterMinutes: 720,
}

const HTML_TOOLS_SETTINGS_KEY = 'html-tools-settings'

const loadSettingsFromStorage = (): HtmlToolsSettings => {
  try {
    const stored = localStorage.getItem(HTML_TOOLS_SETTINGS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        maxActive: normalizeLimit(parsed.maxActive ?? DEFAULT_SETTINGS.maxActive),
        maxCached: normalizeLimit(parsed.maxCached ?? DEFAULT_SETTINGS.maxCached),
        maxBytes: normalizeLimit(parsed.maxBytes ?? DEFAULT_SETTINGS.maxBytes),
        ttlMinutes: normalizeLimit(parsed.ttlMinutes ?? DEFAULT_SETTINGS.ttlMinutes),
        hibernateAfterMinutes: normalizeLimit(parsed.hibernateAfterMinutes ?? DEFAULT_SETTINGS.hibernateAfterMinutes),
      }
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_SETTINGS
}

const saveSettingsToStorage = (settings: HtmlToolsSettings) => {
  try {
    localStorage.setItem(HTML_TOOLS_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // ignore storage errors
  }
}

const isElectronEnv = (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || environment === 'electron'

const LOG_HTML_TOOLS = true

const logHtmlTools = (...args: any[]) => {
  if (!LOG_HTML_TOOLS) return
  console.debug('[HtmlTools]', ...args)
}

const getHtmlSizeBytes = (html: string) => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(html).length
  }
  return html.length
}

const normalizeLimit = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

const isHtmlEntry = (entry: HtmlIframeEntry): entry is HtmlIframeHtmlEntry => entry.kind !== 'mcp'

const isMcpEntry = (entry: HtmlIframeEntry): entry is HtmlIframeMcpEntry => entry.kind === 'mcp'

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

const toCacheRecord = (entry: HtmlIframeHtmlEntry, userId: string): HtmlToolRecord => ({
  key: entry.key,
  html: entry.html,
  label: entry.label,
  tool_name: entry.toolName ?? null,
  favorite: entry.favorite ? 1 : 0,
  status: entry.status,
  size_bytes: entry.sizeBytes,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
  last_used_at: entry.lastUsedAt,
  user_id: userId,
  conversation_id: entry.conversationId ?? null,
  project_id: entry.projectId ?? null,
})

const fromCacheRecord = (record: HtmlToolRecord): HtmlIframeHtmlEntry => ({
  key: record.key,
  kind: 'html',
  html: record.html,
  label: record.label ?? null,
  toolName: record.tool_name ?? null,
  favorite: Boolean(record.favorite),
  status: record.status === 'hibernated' ? 'hibernated' : 'active',
  sizeBytes: Number.isFinite(record.size_bytes) ? record.size_bytes : getHtmlSizeBytes(record.html),
  createdAt: Number.isFinite(record.created_at) ? record.created_at : Date.now(),
  updatedAt: Number.isFinite(record.updated_at) ? record.updated_at : Date.now(),
  lastUsedAt: Number.isFinite(record.last_used_at) ? record.last_used_at : Date.now(),
  conversationId: record.conversation_id ?? null,
  projectId: record.project_id ?? null,
})

type ToolCallRenderGroup = {
  id: string
  name?: string
  args?: Record<string, any> | null
  results: Array<{ content: any; is_error?: boolean }>
  anchorIndex: number
}

const parseContentBlocks = (raw?: Message['content_blocks']): ContentBlock[] => {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') return [raw as ContentBlock]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as ContentBlock[]
      if (parsed && typeof parsed === 'object') return [parsed as ContentBlock]
    } catch {
      return []
    }
  }
  return []
}

const buildToolCallGroupsFromBlocks = (blocks?: ContentBlock[]) => {
  if (!blocks || blocks.length === 0) return new Map<number, ToolCallRenderGroup>()

  const groupsById = new Map<string, ToolCallRenderGroup>()
  const mapByIndex = new Map<number, ToolCallRenderGroup>()

  blocks.forEach((block, idx) => {
    if (block.type === 'tool_use') {
      const id = block.id || `tool-${idx}`
      if (!groupsById.has(id)) {
        const group: ToolCallRenderGroup = {
          id,
          name: block.name,
          args: block.input,
          results: [],
          anchorIndex: idx,
        }
        groupsById.set(id, group)
        mapByIndex.set(idx, group)
      }
    } else if (block.type === 'tool_result') {
      const id = block.tool_use_id || `tool-result-${idx}`
      const target = groupsById.get(id)
      if (target) {
        target.results.push({ content: block.content, is_error: block.is_error })
      } else {
        const fallback: ToolCallRenderGroup = {
          id,
          name: 'Tool Result',
          args: null,
          results: [{ content: block.content, is_error: block.is_error }],
          anchorIndex: idx,
        }
        mapByIndex.set(idx, fallback)
      }
    }
  })

  return mapByIndex
}

const extractHtmlFromToolResult = (content: any): { html: string; toolName?: string | null } | null => {
  if (!content) return null

  let resolved = content
  if (typeof resolved === 'string') {
    try {
      resolved = JSON.parse(resolved)
    } catch {
      return null
    }
  }

  if (typeof resolved === 'object' && resolved !== null && 'html' in resolved) {
    return {
      html: (resolved as any).html,
      toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
    }
  }

  if (
    typeof resolved === 'object' &&
    resolved !== null &&
    (resolved as any).type === 'text/html' &&
    typeof (resolved as any).content === 'string'
  ) {
    return {
      html: (resolved as any).content,
      toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
    }
  }

  return null
}

const buildHtmlEntriesFromMessages = (messages: Message[]) => {
  const entries: Array<{
    key: string
    html: string
    label: string
    conversationId?: string | null
    toolName?: string | null
  }> = []

  const normalizeHtml = (html: string) => html.trim()

  messages.forEach(message => {
    const blocks = parseContentBlocks(message.content_blocks)
    if (!blocks.length) return

    const groupsSource = buildToolCallGroupsFromBlocks(blocks)
    const seen = new Set<string>()

    groupsSource.forEach(group => {
      if (seen.has(group.id)) return
      seen.add(group.id)

      const htmlSeen = new Set<string>()
      const toolLabel = group.name || 'Tool Result'
      const toolName = group.name ?? null
      const isHtmlRenderer = (group.name ?? '').toLowerCase() === 'html_renderer'
      if (isHtmlRenderer && typeof group.args?.html === 'string') {
        const normalized = normalizeHtml(group.args.html)
        if (normalized.length > 0) {
          htmlSeen.add(normalized)
          entries.push({
            key: `${message.id}-html-renderer-${group.id}`,
            html: normalized,
            label: toolLabel,
            conversationId: message.conversation_id ?? null,
            toolName,
          })
        }
      }

      group.results.forEach((result, resultIdx) => {
        const maybeHtml = extractHtmlFromToolResult(result.content)
        if (!maybeHtml?.html) return
        const normalized = normalizeHtml(maybeHtml.html)
        if (!normalized || htmlSeen.has(normalized)) return
        htmlSeen.add(normalized)
        entries.push({
          key: `${message.id}-${group.id}-result-${resultIdx}`,
          html: normalized,
          label: `${toolLabel} result ${resultIdx + 1}`,
          conversationId: message.conversation_id ?? null,
          toolName: maybeHtml.toolName ?? toolName,
        })
      })
    })
  })

  return entries
}

const getIframeClassName = (fullHeight: boolean) =>
  fullHeight ? 'w-full h-full bg-white' : 'w-full min-h-[800px] rounded-lg bg-white'

const configureIframeElement = (iframe: HTMLIFrameElement) => {
  iframe.style.border = 'none'
  iframe.title = 'HTML Preview'
  iframe.className = getIframeClassName(false)
  iframe.setAttribute(
    'allow',
    'fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
  )
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
}

// Uses shared iframeBridge for consistent IPC support
const attachMessageBridge = (
  iframe: HTMLIFrameElement,
  getAuthContext?: () => { tenantId?: string | null },
  getToolContext?: () => { toolName?: string | null }
) => {
  return attachSharedMessageBridge(
    () => iframe,
    () => getAuthContext?.()?.tenantId ?? null,
    getToolContext
  )
}

const createIframeRecord = (
  html: string,
  fullHeight: boolean,
  getAuthContext?: () => { tenantId?: string | null },
  toolName?: string | null
): IframeRecord => {
  const iframe = document.createElement('iframe')
  configureIframeElement(iframe)
  iframe.className = getIframeClassName(fullHeight)
  const customTool = toolName ? getToolByName(toolName) : undefined
  const src = customTool?.isCustom && customTool.ui?.entry
    ? buildCachedLocalApiUrl(`/headless/custom-tools/ui/${encodeURIComponent(customTool.name)}/`)
    : null
  if (src) {
    iframe.src = src
  } else {
    iframe.srcdoc = html
  }
  const record: IframeRecord = {
    iframe,
    html,
    src,
    fullHeight,
    toolName,
    cleanup: () => {},
  }
  const cleanup = attachMessageBridge(iframe, getAuthContext, () => ({ toolName: record.toolName ?? null }))
  record.cleanup = cleanup

  return record
}

const configureMcpIframeElement = (iframe: HTMLIFrameElement, className?: string) => {
  iframe.style.border = 'none'
  iframe.title = 'MCP App'
  iframe.className = className ?? 'w-full h-full bg-white'
  iframe.setAttribute('allow', BASE_ALLOW)
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation')
}

const createMcpIframeRecord = (payload: {
  serverName: string
  resourceUri: string
  qualifiedToolName: string
  toolArgs?: Record<string, any> | null
  toolResult?: { content: any; is_error?: boolean } | null
  toolDefinition?: ToolDefinition
  reloadToken?: number
  className?: string
}): McpIframeRecord => {
  const iframe = document.createElement('iframe')
  configureMcpIframeElement(iframe, payload.className)

  const record: McpIframeRecord = {
    iframe,
    serverName: payload.serverName,
    resourceUri: payload.resourceUri,
    qualifiedToolName: payload.qualifiedToolName,
    toolArgs: payload.toolArgs ?? null,
    toolResult: payload.toolResult ?? null,
    toolDefinition: payload.toolDefinition,
    reloadToken: payload.reloadToken,
    className: payload.className,
    uiMeta: undefined,
    appReady: false,
    toolInputSent: false,
    lastResultHash: null,
    hostRequestId: 1,
    loadSeq: 0,
    sendToolResult: () => {},
    ensureReadyAndSend: () => {},
    sendRequest: () => {},
    cleanup: () => {},
  }

  const sendMessage = (msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => {
    iframe.contentWindow?.postMessage(msg, '*')
  }

  const sendNotification = (method: string, params?: any) => {
    sendMessage({ jsonrpc: '2.0', method, params })
  }

  const sendRequest = (method: string, params?: any) => {
    const id = record.hostRequestId++
    sendMessage({ jsonrpc: '2.0', id, method, params })
  }

  const sendToolInput = () => {
    if (record.toolInputSent) return
    sendNotification('ui/notifications/tool-input', { arguments: record.toolArgs || {} })
    record.toolInputSent = true
  }

  const sendToolResult = (result: { content: any; is_error?: boolean } | null) => {
    if (!result) return
    const normalized = normalizeMcpAppToolResult(result)
    if (!normalized) return
    const hash = JSON.stringify(normalized)
    if (record.lastResultHash === hash) return
    sendNotification('ui/notifications/tool-result', normalized)
    record.lastResultHash = hash
  }

  const ensureReadyAndSend = () => {
    if (!record.appReady) return
    sendToolInput()
    sendToolResult(record.toolResult ?? null)
  }

  const handleRequest = async (request: JsonRpcRequest) => {
    const respond = (payload: JsonRpcResponse) => sendMessage(payload)
    const fail = (id: number | string, messageText: string) =>
      respond({ jsonrpc: '2.0', id, error: { code: -32000, message: messageText } })

    switch (request.method) {
      case 'ui/initialize': {
        const result = {
          protocolVersion: request.params?.protocolVersion || '2025-06-18',
          hostCapabilities: buildHostCapabilities(record.uiMeta),
          hostInfo: { name: 'ygg-chat', version: '1.0.0' },
          hostContext: buildHostContext(record.toolDefinition, record.qualifiedToolName),
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
        const qualified = name.startsWith('mcp__') ? name : `mcp__${record.serverName}__${name}`
        if (!qualified.startsWith(`mcp__${record.serverName}__`)) {
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
          const response = await localApi.post<{ success: boolean; result?: any; error?: string }>('/mcp/tools/call', {
            name: qualified,
            arguments: args,
          })
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
            .filter(tool => tool.serverName === record.serverName)
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
            { serverName: record.serverName, uri }
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
          const resources = response.resources.filter(r => r.serverName === record.serverName)
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
        record.appReady = true
        ensureReadyAndSend()
        break
      case 'notifications/message':
        console.log('[McpApp] message', notification.params)
        break
      default:
        break
    }
  }

  const handleMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return
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

  window.addEventListener('message', handleMessage)

  record.cleanup = () => {
    sendRequest('ui/resource-teardown', { reason: 'unmount' })
    window.removeEventListener('message', handleMessage)
  }

  record.sendToolResult = sendToolResult
  record.ensureReadyAndSend = ensureReadyAndSend
  record.sendRequest = sendRequest

  return record
}

export const HtmlIframeRegistryProvider: React.FC<{
  children: React.ReactNode
  resetKey?: string | number | null
}> = ({ children, resetKey }) => {
  const recordsRef = useRef<Map<string, IframeRecord>>(new Map())
  const mcpRecordsRef = useRef<Map<string, McpIframeRecord>>(new Map())
  const targetsRef = useRef<Map<string, Map<string, TargetEntry>>>(new Map())
  const targetOrderRef = useRef(0)
  const entriesRef = useRef<Map<string, HtmlIframeEntry>>(new Map())
  const [entries, setEntries] = useState<HtmlIframeEntry[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isHomepageFullscreen, setIsHomepageFullscreen] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [settings, setSettings] = useState<HtmlToolsSettings>(loadSettingsFromStorage)
  const hiddenHostRef = useRef<HTMLDivElement | null>(null)
  const bootstrapInFlightRef = useRef(false)
  const queryClient = useQueryClient()
  const { userId } = useAuth()
  const authContextRef = useRef<{ tenantId?: string | null }>({ tenantId: userId ?? null })
  const getAuthContext = useCallback(() => authContextRef.current, [])
  const toolsQuery = useHtmlToolsCache(userId, isElectronEnv)
  const pendingUpsertsRef = useRef<Map<string, HtmlIframeHtmlEntry>>(new Map())
  const pendingDeletesRef = useRef<Set<string>>(new Set())
  const flushTimeoutRef = useRef<number | null>(null)
  const lastQuerySyncRef = useRef<string | null>(null)

  useEffect(() => {
    authContextRef.current = { tenantId: userId ?? null }
  }, [userId])

  const syncEntries = useCallback((nextEntries?: HtmlIframeEntry[]) => {
    setEntries(nextEntries ?? Array.from(entriesRef.current.values()))
  }, [])

  const updateCacheEntry = useCallback(
    (entry: HtmlIframeEntry) => {
      if (!isHtmlEntry(entry)) return
      if (!userId) return
      queryClient.setQueryData<HtmlToolRecord[]>(htmlToolsQueryKey(userId), prev => {
        const next = prev ? [...prev] : []
        const record = toCacheRecord(entry, userId)
        const index = next.findIndex(item => item.key === entry.key)
        if (index >= 0) {
          next[index] = { ...next[index], ...record }
        } else {
          next.push(record)
        }
        return next
      })
    },
    [queryClient, userId]
  )

  const removeCacheEntry = useCallback(
    (key: string) => {
      if (!userId) return
      queryClient.setQueryData<HtmlToolRecord[]>(htmlToolsQueryKey(userId), prev =>
        prev ? prev.filter(item => item.key !== key) : []
      )
    },
    [queryClient, userId]
  )

  const syncEntriesFromCache = useCallback(
    (records: HtmlToolRecord[]) => {
      if (!Array.isArray(records) || records.length === 0) return
      const nextEntries = records.map(fromCacheRecord)
      // MERGE: only add entries that don't already exist - never overwrite existing entries
      let added = false
      nextEntries.forEach(entry => {
        if (!entriesRef.current.has(entry.key)) {
          entriesRef.current.set(entry.key, entry)
          added = true
        }
      })
      // Only trigger state sync if we actually added new entries
      if (added) {
        syncEntries()
      }
    },
    [syncEntries]
  )

  const flushPersist = useCallback(async () => {
    if (!userId || !isElectronEnv) return
    const pendingUpserts = Array.from(pendingUpsertsRef.current.values())
    const pendingDeletes = Array.from(pendingDeletesRef.current.values())
    pendingUpsertsRef.current.clear()
    pendingDeletesRef.current.clear()

    try {
      if (pendingUpserts.length > 0) {
        await localApi.post('/local/tools/bulk', {
          userId,
          tools: pendingUpserts.map(entry => ({
            key: entry.key,
            html: entry.html,
            label: entry.label,
            toolName: entry.toolName ?? null,
            favorite: entry.favorite,
            status: entry.status,
            sizeBytes: entry.sizeBytes,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            lastUsedAt: entry.lastUsedAt,
            conversationId: entry.conversationId ?? null,
            projectId: entry.projectId ?? null,
          })),
        })
      }

      if (pendingDeletes.length > 0) {
        await Promise.all(
          pendingDeletes.map(key =>
            localApi.delete(`/local/tools/${encodeURIComponent(key)}?userId=${encodeURIComponent(userId)}`)
          )
        )
      }
    } catch (err) {
      console.error('[HtmlTools] persist failed', err)
    }
  }, [userId])

  const queuePersistUpsert = useCallback(
    (entry: HtmlIframeEntry) => {
      if (!isHtmlEntry(entry)) return
      if (!userId || !isElectronEnv) return
      pendingUpsertsRef.current.set(entry.key, entry)
      pendingDeletesRef.current.delete(entry.key)
      if (flushTimeoutRef.current) return
      flushTimeoutRef.current = window.setTimeout(() => {
        flushTimeoutRef.current = null
        void flushPersist()
      }, 800)
    },
    [flushPersist, userId]
  )

  const queuePersistDelete = useCallback(
    (key: string) => {
      if (!userId || !isElectronEnv) return
      pendingUpsertsRef.current.delete(key)
      pendingDeletesRef.current.add(key)
      if (flushTimeoutRef.current) return
      flushTimeoutRef.current = window.setTimeout(() => {
        flushTimeoutRef.current = null
        void flushPersist()
      }, 800)
    },
    [flushPersist, userId]
  )

  const removeRecord = useCallback((key: string) => {
    const htmlRecord = recordsRef.current.get(key)
    if (htmlRecord) {
      logHtmlTools('iframe-remove', { key })
      htmlRecord.positionCleanup?.()
      htmlRecord.cleanup()
      htmlRecord.iframe.remove()
      recordsRef.current.delete(key)
    }

    const mcpRecord = mcpRecordsRef.current.get(key)
    if (mcpRecord) {
      logHtmlTools('iframe-remove', { key })
      mcpRecord.positionCleanup?.()
      mcpRecord.cleanup()
      mcpRecord.iframe.remove()
      mcpRecordsRef.current.delete(key)
    }
  }, [])

  useEffect(() => {
    recordsRef.current.forEach(record => {
      record.positionCleanup?.()
      record.cleanup()
      record.iframe.remove()
    })
    recordsRef.current.clear()
    mcpRecordsRef.current.forEach(record => {
      record.positionCleanup?.()
      record.cleanup()
      record.iframe.remove()
    })
    mcpRecordsRef.current.clear()
    targetsRef.current.clear()
    entriesRef.current.clear()
    pendingUpsertsRef.current.clear()
    pendingDeletesRef.current.clear()
    if (flushTimeoutRef.current) {
      window.clearTimeout(flushTimeoutRef.current)
      flushTimeoutRef.current = null
    }
    setEntries([])
    setFocusKey(null)
    setIsModalOpen(false)
  }, [resetKey])

  useEffect(() => {
    if (!userId || entriesRef.current.size > 0) return
    if (!toolsQuery.data || toolsQuery.data.length === 0) return
    syncEntriesFromCache(toolsQuery.data)
  }, [syncEntriesFromCache, toolsQuery.data, userId])

  useEffect(() => {
    if (!userId || entries.length > 0) return
    const cached = getHtmlToolsFromCache(queryClient, userId)
    if (cached.length === 0) return
    syncEntriesFromCache(cached)
  }, [entries.length, queryClient, syncEntriesFromCache, userId])

  useEffect(() => {
    if (!userId || !isElectronEnv) return
    const htmlEntries = entries.filter(isHtmlEntry)
    const signature = htmlEntries.map(entry => `${entry.key}:${entry.updatedAt}`).join('|')
    if (signature === lastQuerySyncRef.current) return
    lastQuerySyncRef.current = signature
    queryClient.setQueryData<HtmlToolRecord[]>(
      htmlToolsQueryKey(userId),
      htmlEntries.map(entry => toCacheRecord(entry, userId))
    )
  }, [entries, queryClient, userId])

  useEffect(() => {
    return () => {
      if (flushTimeoutRef.current) {
        window.clearTimeout(flushTimeoutRef.current)
        flushTimeoutRef.current = null
      }
      void flushPersist()
    }
  }, [flushPersist])

  const removeEntryInternal = useCallback(
    (key: string) => {
      const entry = entriesRef.current.get(key)
      if (!entry) return false
      removeRecord(key)
      entriesRef.current.delete(key)
      targetsRef.current.delete(key)
      if (isHtmlEntry(entry)) {
        removeCacheEntry(key)
        queuePersistDelete(key)
      }
      if (focusKey === key) {
        setFocusKey(null)
      }
      return true
    },
    [focusKey, queuePersistDelete, removeCacheEntry, removeRecord]
  )

  const enforceLimits = useCallback(
    (now = Date.now()) => {
      const currentEntries = Array.from(entriesRef.current.values())
      if (currentEntries.length === 0) return false

      const removeKeys = new Set<string>()
      const hibernateKeys = new Set<string>()
      let changed = false

      if (settings.ttlMinutes > 0) {
        const cutoff = now - settings.ttlMinutes * 60 * 1000
        currentEntries.forEach(entry => {
          if (!entry.favorite && entry.lastUsedAt < cutoff) {
            removeKeys.add(entry.key)
          }
        })
      }

      const remainingEntries = currentEntries.filter(entry => !removeKeys.has(entry.key))

      if (settings.hibernateAfterMinutes > 0) {
        const cutoff = now - settings.hibernateAfterMinutes * 60 * 1000
        remainingEntries.forEach(entry => {
          // Skip favorites - they should never be auto-hibernated
          if (!entry.favorite && entry.status === 'active' && entry.lastUsedAt < cutoff) {
            hibernateKeys.add(entry.key)
          }
        })
      }

      if (settings.maxActive > 0) {
        const activeEntries = remainingEntries.filter(
          entry => entry.status === 'active' && !hibernateKeys.has(entry.key)
        )
        if (activeEntries.length > settings.maxActive) {
          // Only hibernate non-favorites when over the limit
          const evictableActive = [...activeEntries].filter(entry => !entry.favorite)
          const sorted = evictableActive.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
          let remainingActive = activeEntries.length
          for (const entry of sorted) {
            if (remainingActive <= settings.maxActive) break
            hibernateKeys.add(entry.key)
            remainingActive -= 1
          }
        }
      }

      hibernateKeys.forEach(key => {
        const entry = entriesRef.current.get(key)
        if (!entry || entry.status === 'hibernated') return
        const nextEntry: HtmlIframeEntry = {
          ...entry,
          status: 'hibernated',
          updatedAt: now,
        }
        entriesRef.current.set(key, nextEntry)
        targetsRef.current.set(key, null)
        removeRecord(key)
        updateCacheEntry(nextEntry)
        queuePersistUpsert(nextEntry)
        changed = true
      })

      removeKeys.forEach(key => {
        if (removeEntryInternal(key)) {
          changed = true
        }
      })

      if (settings.maxCached > 0) {
        const nextEntries = Array.from(entriesRef.current.values())
        if (nextEntries.length > settings.maxCached) {
          const evictable = nextEntries.filter(entry => !entry.favorite).sort((a, b) => a.lastUsedAt - b.lastUsedAt)
          for (const entry of evictable) {
            if (entriesRef.current.size <= settings.maxCached) break
            if (removeEntryInternal(entry.key)) {
              changed = true
            }
          }
        }
      }

      if (settings.maxBytes > 0) {
        let totalBytes = Array.from(entriesRef.current.values()).reduce((sum, entry) => sum + entry.sizeBytes, 0)
        if (totalBytes > settings.maxBytes) {
          const evictable = Array.from(entriesRef.current.values())
            .filter(entry => !entry.favorite)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
          for (const entry of evictable) {
            if (totalBytes <= settings.maxBytes) break
            if (removeEntryInternal(entry.key)) {
              changed = true
              totalBytes -= entry.sizeBytes
            }
          }
        }
      }

      if (changed) {
        syncEntries()
      }

      return changed
    },
    [queuePersistUpsert, removeEntryInternal, removeRecord, settings, syncEntries, updateCacheEntry]
  )

  const registerEntry = useCallback(
    (
      key: string,
      html: string,
      label?: string | null,
      meta?: { conversationId?: string | null; projectId?: string | null; toolName?: string | null }
    ) => {
      const now = Date.now()
      const existingEntry = entriesRef.current.get(key)
      const existingHtmlEntry = existingEntry && isHtmlEntry(existingEntry) ? existingEntry : null
      const nextLabel = label ?? existingEntry?.label ?? null
      const nextToolName = meta?.toolName ?? existingEntry?.toolName ?? null
      const sizeBytes = getHtmlSizeBytes(html)
      const lastUsedAt =
        existingHtmlEntry && existingHtmlEntry.html === html
          ? existingHtmlEntry.lastUsedAt
          : (existingEntry?.lastUsedAt ?? now)
      const nextSrc = (() => {
        const customTool = nextToolName ? getToolByName(nextToolName) : undefined
        return customTool?.isCustom && customTool.ui?.entry
          ? buildCachedLocalApiUrl(`/headless/custom-tools/ui/${encodeURIComponent(customTool.name)}/`)
          : null
      })()
      const nextEntry: HtmlIframeHtmlEntry = {
        key,
        kind: 'html',
        html,
        src: nextSrc,
        label: nextLabel,
        favorite: existingEntry?.favorite ?? false,
        status: existingEntry?.status ?? 'active',
        sizeBytes,
        createdAt: existingEntry?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existingHtmlEntry && existingHtmlEntry.html === html ? lastUsedAt : now,
        conversationId: meta?.conversationId ?? existingEntry?.conversationId ?? null,
        projectId: meta?.projectId ?? existingEntry?.projectId ?? null,
        toolName: nextToolName,
      }
      if (
        !existingHtmlEntry ||
        existingHtmlEntry.html !== html ||
        existingEntry?.label !== nextLabel ||
        existingEntry?.toolName !== nextEntry.toolName ||
        existingEntry?.favorite !== nextEntry.favorite ||
        existingEntry?.status !== nextEntry.status ||
        existingEntry?.sizeBytes !== nextEntry.sizeBytes ||
        existingEntry?.lastUsedAt !== nextEntry.lastUsedAt ||
        existingEntry?.conversationId !== nextEntry.conversationId ||
        existingEntry?.projectId !== nextEntry.projectId
      ) {
        entriesRef.current.set(key, nextEntry)
        updateCacheEntry(nextEntry)
        queuePersistUpsert(nextEntry)
        syncEntries()
        enforceLimits(now)
      }
    },
    [enforceLimits, getAuthContext, queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const registerMcpEntry = useCallback(
    (
      key: string,
      payload: {
        serverName: string
        resourceUri: string
        qualifiedToolName: string
        toolArgs?: Record<string, any> | null
        toolResult?: { content: any; is_error?: boolean } | null
        toolDefinition?: ToolDefinition
        reloadToken?: number
      },
      label?: string | null,
      meta?: { conversationId?: string | null; projectId?: string | null }
    ) => {
      const now = Date.now()
      const existingEntry = entriesRef.current.get(key)
      const existingMcpEntry = existingEntry && isMcpEntry(existingEntry) ? existingEntry : null
      const nextLabel = label ?? existingEntry?.label ?? null
      const nextEntry: HtmlIframeMcpEntry = {
        key,
        kind: 'mcp',
        label: nextLabel,
        favorite: existingEntry?.favorite ?? false,
        status: existingEntry?.status ?? 'active',
        sizeBytes: existingEntry?.sizeBytes ?? 0,
        createdAt: existingEntry?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existingEntry?.lastUsedAt ?? now,
        conversationId: meta?.conversationId ?? existingEntry?.conversationId ?? null,
        projectId: meta?.projectId ?? existingEntry?.projectId ?? null,
        serverName: payload.serverName,
        resourceUri: payload.resourceUri,
        qualifiedToolName: payload.qualifiedToolName,
        toolArgs: payload.toolArgs ?? null,
        toolResult: payload.toolResult ?? null,
        toolDefinition: payload.toolDefinition,
        reloadToken: payload.reloadToken,
      }

      const changed =
        !existingMcpEntry ||
        existingMcpEntry.label !== nextLabel ||
        existingMcpEntry.favorite !== nextEntry.favorite ||
        existingMcpEntry.status !== nextEntry.status ||
        existingMcpEntry.conversationId !== nextEntry.conversationId ||
        existingMcpEntry.projectId !== nextEntry.projectId ||
        existingMcpEntry.serverName !== nextEntry.serverName ||
        existingMcpEntry.resourceUri !== nextEntry.resourceUri ||
        existingMcpEntry.qualifiedToolName !== nextEntry.qualifiedToolName ||
        existingMcpEntry.toolArgs !== nextEntry.toolArgs ||
        existingMcpEntry.toolResult !== nextEntry.toolResult ||
        existingMcpEntry.toolDefinition !== nextEntry.toolDefinition ||
        existingMcpEntry.reloadToken !== nextEntry.reloadToken

      if (changed) {
        entriesRef.current.set(key, nextEntry)
        updateCacheEntry(nextEntry)
        queuePersistUpsert(nextEntry)
        syncEntries()
        enforceLimits(now)
      }
    },
    [enforceLimits, queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const setTarget = useCallback((key: string, target: HTMLElement | null, ownerId: string, priority = 0) => {
    const map = targetsRef.current.get(key) ?? new Map<string, TargetEntry>()
    if (target) {
      const order = ++targetOrderRef.current
      map.set(ownerId, { target, priority, order })
    } else {
      map.delete(ownerId)
    }
    if (map.size > 0) {
      targetsRef.current.set(key, map)
    } else {
      targetsRef.current.delete(key)
    }

    const record = recordsRef.current.get(key) ?? mcpRecordsRef.current.get(key)
    if (!record) return

    let activeTarget: HTMLElement | null = null
    let activePriority = Number.NEGATIVE_INFINITY
    let activeOrder = Number.NEGATIVE_INFINITY
    map.forEach(entry => {
      if (entry.priority > activePriority || (entry.priority === activePriority && entry.order > activeOrder)) {
        activeTarget = entry.target
        activePriority = entry.priority
        activeOrder = entry.order
      }
    })

    if (record.activeTarget === activeTarget) {
      if (!activeTarget) return
    }

    // Clean up previous position tracking
    record.positionCleanup?.()
    record.positionCleanup = undefined
    record.activeTarget = activeTarget

    // Always keep iframe in hidden container (never inside slot to avoid unmount issues)
    if (!record.iframe.parentElement || record.iframe.parentElement !== hiddenHostRef.current) {
      hiddenHostRef.current?.appendChild(record.iframe)
    }

    if (!activeTarget) {
      // No target slot - hide iframe
      record.iframe.style.display = 'none'
      record.iframe.style.position = ''
      record.iframe.style.left = ''
      record.iframe.style.top = ''
      record.iframe.style.width = ''
      record.iframe.style.height = ''
      record.iframe.style.zIndex = ''
      logHtmlTools('iframe-hide', { key })
      return
    }

    // Position iframe over the target slot using fixed positioning
    const updatePosition = () => {
      const rect = activeTarget.getBoundingClientRect()
      record.iframe.style.position = 'fixed'
      record.iframe.style.left = `${rect.left}px`
      record.iframe.style.top = `${rect.top}px`
      record.iframe.style.width = `${rect.width}px`
      record.iframe.style.height = `${rect.height}px`
      record.iframe.style.zIndex = '1450'
      record.iframe.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none'
    }

    updatePosition()
    logHtmlTools('iframe-position', { key })

    // Track position changes with ResizeObserver and scroll/resize events
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(activeTarget)

    const scrollHandler = () => requestAnimationFrame(updatePosition)
    window.addEventListener('scroll', scrollHandler, true)
    window.addEventListener('resize', scrollHandler)

    record.positionCleanup = () => {
      resizeObserver.disconnect()
      window.removeEventListener('scroll', scrollHandler, true)
      window.removeEventListener('resize', scrollHandler)
    }
  }, [])

  const updateIframe = useCallback(
    (
      key: string,
      html: string,
      fullHeight: boolean,
      label?: string | null,
      meta?: { conversationId?: string | null; projectId?: string | null; toolName?: string | null }
    ) => {
      let record = recordsRef.current.get(key)
      if (!record) {
        record = createIframeRecord(html, fullHeight, getAuthContext, meta?.toolName ?? null)
        recordsRef.current.set(key, record)
        // Initially hidden until a slot targets it
        record.iframe.style.display = 'none'
        // Append to hidden container initially (will be moved to slot when targeted)
        hiddenHostRef.current?.appendChild(record.iframe)
        logHtmlTools('iframe-create', { key, fullHeight })
      } else {
        record.toolName = meta?.toolName ?? record.toolName ?? null
        const customTool = record.toolName ? getToolByName(record.toolName) : undefined
        const nextSrc = customTool?.isCustom && customTool.ui?.entry
          ? buildCachedLocalApiUrl(`/headless/custom-tools/ui/${encodeURIComponent(customTool.name)}/`)
          : null
        if (record.src !== nextSrc) {
          record.src = nextSrc
          if (nextSrc) {
            record.iframe.src = nextSrc
          } else {
            record.iframe.srcdoc = html
          }
        }
        if (!record.src && record.html !== html) {
          record.iframe.srcdoc = html
          record.html = html
        } else {
          record.html = html
        }
        if (record.fullHeight !== fullHeight) {
          record.iframe.className = getIframeClassName(fullHeight)
          record.fullHeight = fullHeight
        }
      }

      const now = Date.now()
      const existingEntry = entriesRef.current.get(key)
      const existingHtmlEntry = existingEntry && isHtmlEntry(existingEntry) ? existingEntry : null
      const nextLabel = label ?? existingEntry?.label ?? null
      const nextToolName = meta?.toolName ?? existingEntry?.toolName ?? null
      const sizeBytes = getHtmlSizeBytes(html)
      const nextSrc = (() => {
        const customTool = nextToolName ? getToolByName(nextToolName) : undefined
        return customTool?.isCustom && customTool.ui?.entry
          ? buildCachedLocalApiUrl(`/headless/custom-tools/ui/${encodeURIComponent(customTool.name)}/`)
          : null
      })()
      const nextEntry: HtmlIframeHtmlEntry = {
        key,
        kind: 'html',
        html,
        src: nextSrc,
        label: nextLabel,
        favorite: existingEntry?.favorite ?? false,
        status: existingEntry?.status === 'hibernated' ? 'active' : (existingEntry?.status ?? 'active'),
        sizeBytes,
        createdAt: existingEntry?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existingEntry?.lastUsedAt ?? now,
        conversationId: meta?.conversationId ?? existingEntry?.conversationId ?? null,
        projectId: meta?.projectId ?? existingEntry?.projectId ?? null,
        toolName: nextToolName,
      }
      if (
        !existingHtmlEntry ||
        existingHtmlEntry.html !== html ||
        existingEntry?.label !== nextLabel ||
        existingEntry?.toolName !== nextEntry.toolName ||
        existingEntry?.favorite !== nextEntry.favorite ||
        existingEntry?.status !== nextEntry.status ||
        existingEntry?.sizeBytes !== nextEntry.sizeBytes ||
        existingEntry?.conversationId !== nextEntry.conversationId ||
        existingEntry?.projectId !== nextEntry.projectId
      ) {
        entriesRef.current.set(key, nextEntry)
        updateCacheEntry(nextEntry)
        queuePersistUpsert(nextEntry)
        syncEntries()
        enforceLimits(now)
      }

      // Iframes stay in overlayHostRef permanently - no DOM movement needed
      // Positioning is handled by setTarget via CSS overlay
    },
    [enforceLimits, getAuthContext, queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const loadMcpResource = useCallback(async (record: McpIframeRecord) => {
    const loadId = ++record.loadSeq
    try {
      const response = await localApi.post<{ success: boolean; result?: { contents?: McpUiResource[] } }>(
        '/mcp/resources/read',
        { serverName: record.serverName, uri: record.resourceUri }
      )
      if (!response?.success) {
        throw new Error('Failed to read MCP resource')
      }
      const resource = response.result?.contents?.[0]
      if (!resource) {
        throw new Error('No resource content returned')
      }
      if (record.loadSeq !== loadId) return
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
      record.uiMeta = resourceUi
      const allowAttr = buildIframeAllow(resourceUi?.permissions as McpUiPermissions | undefined, BASE_ALLOW)
      record.iframe.setAttribute('allow', allowAttr)
      record.iframe.srcdoc = htmlWithCsp
      record.appReady = false
      record.toolInputSent = false
      record.lastResultHash = null
    } catch (err) {
      console.error('[McpApp] Failed to load resource', err)
    }
  }, [])

  const updateMcpIframe = useCallback(
    (
      key: string,
      payload: {
        serverName: string
        resourceUri: string
        qualifiedToolName: string
        toolArgs?: Record<string, any> | null
        toolResult?: { content: any; is_error?: boolean } | null
        toolDefinition?: ToolDefinition
        reloadToken?: number
        className?: string
      }
    ) => {
      let record = mcpRecordsRef.current.get(key)
      const isNew = !record
      if (!record) {
        record = createMcpIframeRecord(payload)
        mcpRecordsRef.current.set(key, record)
        record.iframe.style.display = 'none'
        hiddenHostRef.current?.appendChild(record.iframe)
        logHtmlTools('mcp-iframe-create', { key })
      }

      if (payload.className && record.className !== payload.className) {
        record.className = payload.className
        record.iframe.className = payload.className
      }

      const shouldReload =
        isNew ||
        record.serverName !== payload.serverName ||
        record.resourceUri !== payload.resourceUri ||
        record.reloadToken !== payload.reloadToken

      record.serverName = payload.serverName
      record.resourceUri = payload.resourceUri
      record.qualifiedToolName = payload.qualifiedToolName
      record.toolArgs = payload.toolArgs ?? null
      record.toolResult = payload.toolResult ?? null
      record.toolDefinition = payload.toolDefinition
      record.reloadToken = payload.reloadToken

      if (shouldReload) {
        record.appReady = false
        record.toolInputSent = false
        record.lastResultHash = null
        void loadMcpResource(record)
      } else if (record.appReady) {
        record.sendToolResult(record.toolResult ?? null)
      }
    },
    [loadMcpResource]
  )

  const touchEntry = useCallback(
    (key: string) => {
      const entry = entriesRef.current.get(key)
      if (!entry) return
      const now = Date.now()
      const nextEntry: HtmlIframeEntry = {
        ...entry,
        lastUsedAt: now,
        updatedAt: now,
      }
      entriesRef.current.set(key, nextEntry)
      updateCacheEntry(nextEntry)
      queuePersistUpsert(nextEntry)
      syncEntries()
    },
    [queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const toggleFavorite = useCallback(
    (key: string) => {
      const entry = entriesRef.current.get(key)
      if (!entry) return
      const nextEntry: HtmlIframeEntry = {
        ...entry,
        favorite: !entry.favorite,
        updatedAt: Date.now(),
      }
      entriesRef.current.set(key, nextEntry)
      updateCacheEntry(nextEntry)
      queuePersistUpsert(nextEntry)
      syncEntries()
    },
    [queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const hibernateEntry = useCallback(
    (key: string) => {
      const entry = entriesRef.current.get(key)
      if (!entry || entry.status === 'hibernated') return
      const nextEntry: HtmlIframeEntry = {
        ...entry,
        status: 'hibernated',
        updatedAt: Date.now(),
      }
      entriesRef.current.set(key, nextEntry)
      logHtmlTools('entry-hibernate', { key })
      targetsRef.current.set(key, null)
      removeRecord(key)
      updateCacheEntry(nextEntry)
      queuePersistUpsert(nextEntry)
      syncEntries()
    },
    [queuePersistUpsert, removeRecord, syncEntries, updateCacheEntry]
  )

  const restoreEntry = useCallback(
    (key: string) => {
      const entry = entriesRef.current.get(key)
      if (!entry) return
      const now = Date.now()
      const nextEntry: HtmlIframeEntry = {
        ...entry,
        status: 'active',
        lastUsedAt: now,
        updatedAt: now,
      }
      entriesRef.current.set(key, nextEntry)
      logHtmlTools('entry-restore', { key })
      updateCacheEntry(nextEntry)
      queuePersistUpsert(nextEntry)
      syncEntries()
      enforceLimits(now)
    },
    [enforceLimits, queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const removeEntry = useCallback(
    (key: string) => {
      if (removeEntryInternal(key)) {
        logHtmlTools('entry-remove', { key })
        syncEntries()
      }
    },
    [removeEntryInternal, syncEntries]
  )

  const bootstrapFromLocalCache = useCallback(
    async (userId: string) => {
      if (!userId || bootstrapInFlightRef.current) return
      bootstrapInFlightRef.current = true
      try {
        if (entriesRef.current.size > 0) return
        const cachedTools = getHtmlToolsFromCache(queryClient, userId)
        if (cachedTools.length > 0) {
          syncEntriesFromCache(cachedTools)
          return
        }

        if (isElectronEnv) {
          const tools = await localApi.get<HtmlToolRecord[]>(`/local/tools?userId=${userId}`)
          if (Array.isArray(tools) && tools.length > 0) {
            queryClient.setQueryData(htmlToolsQueryKey(userId), tools)
            syncEntriesFromCache(tools)
            return
          }
        }

        logHtmlTools('bootstrap-start', { userId })
        const conversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`)
        if (!Array.isArray(conversations) || conversations.length === 0) return
        const sorted = [...conversations].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )
        const maxEntries = settings.maxCached > 0 ? settings.maxCached : Number.POSITIVE_INFINITY
        let added = 0
        const seenKeys = new Set<string>()

        for (const conversation of sorted) {
          if (!conversation?.id) continue
          if (added >= maxEntries) break
          try {
            logHtmlTools('bootstrap-conversation', { id: conversation.id })
            const result = await localApi.get<{ messages: Message[] }>(
              `/app/conversations/${conversation.id}/messages/tree`
            )
            const messages = Array.isArray(result?.messages) ? result.messages : []
            const cachedEntries = buildHtmlEntriesFromMessages(messages)
            cachedEntries.forEach(entry => {
              if (added >= maxEntries) return
              if (seenKeys.has(entry.key) || entriesRef.current.has(entry.key)) return
              seenKeys.add(entry.key)
              registerEntry(entry.key, entry.html, entry.label, {
                conversationId: entry.conversationId ?? null,
                toolName: entry.toolName ?? null,
              })
              added += 1
            })
          } catch (err) {
            console.error('[HtmlTools] bootstrap conversation failed', conversation.id, err)
          }
        }

        logHtmlTools('bootstrap-entries', { count: added })
      } catch (err) {
        console.error('[HtmlTools] bootstrap failed', err)
      } finally {
        bootstrapInFlightRef.current = false
      }
    },
    [queryClient, registerEntry, settings.maxCached, syncEntriesFromCache]
  )

  const openModal = useCallback(
    (key?: string | null) => {
      if (key) {
        const entry = entriesRef.current.get(key)
        if (entry) {
          const now = Date.now()
          const nextEntry: HtmlIframeEntry = {
            ...entry,
            status: 'active',
            lastUsedAt: now,
            updatedAt: now,
          }
          entriesRef.current.set(key, nextEntry)
          updateCacheEntry(nextEntry)
          queuePersistUpsert(nextEntry)
          syncEntries()
          enforceLimits(now)
        }
        setFocusKey(key)
      } else {
        setFocusKey(null)
      }
      setIsModalOpen(true)
    },
    [enforceLimits, queuePersistUpsert, syncEntries, updateCacheEntry]
  )

  const closeModal = useCallback(() => {
    setIsModalOpen(false)
    setFocusKey(null)
  }, [])

  const updateSettings = useCallback((updates: Partial<HtmlToolsSettings>) => {
    setSettings(prev => {
      const merged = { ...prev, ...updates }
      const next = {
        ...merged,
        maxActive: normalizeLimit(merged.maxActive),
        maxCached: normalizeLimit(merged.maxCached),
        maxBytes: normalizeLimit(merged.maxBytes),
        ttlMinutes: normalizeLimit(merged.ttlMinutes),
        hibernateAfterMinutes: normalizeLimit(merged.hibernateAfterMinutes),
      }
      saveSettingsToStorage(next)
      return next
    })
  }, [])

  useEffect(() => {
    enforceLimits()
  }, [enforceLimits, settings])

  useEffect(() => {
    const interval = window.setInterval(() => {
      enforceLimits()
    }, 60 * 1000)
    return () => window.clearInterval(interval)
  }, [enforceLimits])

  const contextValue = useMemo(
    () => ({
      entries,
      registerEntry,
      registerMcpEntry,
      updateIframe,
      updateMcpIframe,
      setTarget,
      isModalOpen,
      focusKey,
      openModal,
      closeModal,
      isHomepageFullscreen,
      setHomepageFullscreen: setIsHomepageFullscreen,
      touchEntry,
      toggleFavorite,
      hibernateEntry,
      restoreEntry,
      removeEntry,
      bootstrapFromLocalCache,
      settings,
      updateSettings,
    }),
    [
      bootstrapFromLocalCache,
      closeModal,
      entries,
      focusKey,
      hibernateEntry,
      isHomepageFullscreen,
      isModalOpen,
      openModal,
      registerEntry,
      registerMcpEntry,
      removeEntry,
      restoreEntry,
      setTarget,
      settings,
      toggleFavorite,
      touchEntry,
      updateIframe,
      updateMcpIframe,
      updateSettings,
    ]
  )

  return (
    <HtmlIframeRegistryContext.Provider value={contextValue}>
      {children}
      {/* Container for iframes - iframes use fixed positioning to overlay slots */}
      <div ref={hiddenHostRef} className='contents' aria-hidden='true' />
    </HtmlIframeRegistryContext.Provider>
  )
}

export const HtmlIframeSlot: React.FC<{
  iframeKey: string
  html: string
  fullHeight?: boolean
  className?: string
  priority?: number
  toolName?: string | null
}> = ({ iframeKey, html, fullHeight = false, className, priority, toolName = null }) => {
  const registry = useHtmlIframeRegistry()
  const registryRef = useRef(registry)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const ownerIdRef = useRef(`slot-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    registryRef.current = registry
  }, [registry])

  useEffect(() => {
    logHtmlTools('slot-mount', { key: iframeKey })
    return () => {
      logHtmlTools('slot-unmount', { key: iframeKey })
    }
  }, [iframeKey])

  // IMPORTANT: useLayoutEffect for updateIframe must run BEFORE the setTarget useLayoutEffect below.
  // This ensures the iframe record exists before we try to position it.
  useLayoutEffect(() => {
    if (!registryRef.current) return
    registryRef.current.updateIframe(iframeKey, html, fullHeight, undefined, { toolName })
  }, [iframeKey, html, fullHeight, toolName])

  useLayoutEffect(() => {
    const node = slotRef.current
    if (!node || !registryRef.current) return
    registryRef.current.setTarget(iframeKey, node, ownerIdRef.current, priority ?? 0)
    return () => {
      registryRef.current?.setTarget(iframeKey, null, ownerIdRef.current, priority ?? 0)
    }
  }, [iframeKey, priority])

  if (!registry) {
    return (
      <div className={className}>
        <iframe
          srcDoc={html}
          className={getIframeClassName(fullHeight)}
          style={{ border: 'none' }}
          title='HTML Preview'
          allow='fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
          referrerPolicy='strict-origin-when-cross-origin'
          sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-presentation'
        />
      </div>
    )
  }

  return <div ref={slotRef} className={className} />
}

export const McpAppIframeSlot: React.FC<{
  iframeKey: string
  serverName: string
  resourceUri: string
  qualifiedToolName: string
  toolArgs?: Record<string, any> | null
  toolResult?: { content: any; is_error?: boolean } | null
  toolDefinition?: ToolDefinition
  reloadToken?: number
  className?: string
  label?: string | null
  meta?: { conversationId?: string | null; projectId?: string | null }
  priority?: number
}> = ({
  iframeKey,
  serverName,
  resourceUri,
  qualifiedToolName,
  toolArgs,
  toolResult,
  toolDefinition,
  reloadToken,
  className,
  label,
  meta,
  priority,
}) => {
  const registry = useHtmlIframeRegistry()
  const registryRef = useRef(registry)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const ownerIdRef = useRef(`mcp-slot-${Math.random().toString(36).slice(2)}`)
  const payloadHash = useMemo(() => {
    const safeStringify = (value: unknown) => {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return [
      serverName,
      resourceUri,
      qualifiedToolName,
      reloadToken ?? '',
      label ?? '',
      meta?.conversationId ?? '',
      meta?.projectId ?? '',
      safeStringify(toolArgs ?? null),
      safeStringify(toolResult ?? null),
    ].join('|')
  }, [
    label,
    meta?.conversationId,
    meta?.projectId,
    qualifiedToolName,
    reloadToken,
    resourceUri,
    serverName,
    toolArgs,
    toolResult,
  ])

  useEffect(() => {
    registryRef.current = registry
  }, [registry])

  useEffect(() => {
    if (!registryRef.current) return
    registryRef.current.registerMcpEntry(
      iframeKey,
      {
        serverName,
        resourceUri,
        qualifiedToolName,
        toolArgs,
        toolResult,
        toolDefinition,
        reloadToken,
      },
      label,
      meta
    )
  }, [iframeKey, payloadHash])

  useEffect(() => {
    logHtmlTools('mcp-slot-mount', { key: iframeKey })
    return () => {
      logHtmlTools('mcp-slot-unmount', { key: iframeKey })
    }
  }, [iframeKey])

  useLayoutEffect(() => {
    if (!registryRef.current) return
    registryRef.current.updateMcpIframe(iframeKey, {
      serverName,
      resourceUri,
      qualifiedToolName,
      toolArgs,
      toolResult,
      toolDefinition,
      reloadToken,
      className,
    })
  }, [
    className,
    iframeKey,
    qualifiedToolName,
    reloadToken,
    resourceUri,
    serverName,
    toolArgs,
    toolDefinition,
    toolResult,
  ])

  useLayoutEffect(() => {
    const node = slotRef.current
    if (!node || !registryRef.current) return
    registryRef.current.setTarget(iframeKey, node, ownerIdRef.current, priority ?? 0)
    return () => {
      registryRef.current?.setTarget(iframeKey, null, ownerIdRef.current, priority ?? 0)
    }
  }, [iframeKey, priority])

  if (!registry) {
    return (
      <McpAppIframe
        serverName={serverName}
        qualifiedToolName={qualifiedToolName}
        resourceUri={resourceUri}
        toolArgs={toolArgs ?? undefined}
        toolResult={toolResult ?? undefined}
        toolDefinition={toolDefinition}
        reloadToken={reloadToken}
        className={className}
      />
    )
  }

  return <div ref={slotRef} className={className} />
}
