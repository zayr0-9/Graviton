type JsonRpcId = number | string | null

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: any
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: any
  error?: {
    code: number
    message: string
    data?: any
  }
}

type LegacyIframeRequest = {
  type: string
  requestId: string
  options?: Record<string, any>
}

type BridgeContext = {
  toolName?: string | null
  userId?: string | null
  rootPath?: string | null
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest => {
  if (!isRecord(value)) return false
  return value.jsonrpc === '2.0' && typeof value.method === 'string'
}

const isLegacyRequest = (value: unknown): value is LegacyIframeRequest => {
  if (!isRecord(value)) return false
  return typeof value.type === 'string' && typeof value.requestId === 'string'
}

const toLegacyErrorResponse = (request: LegacyIframeRequest, message: string) => ({
  type: `${request.type}_RESPONSE`,
  requestId: request.requestId,
  success: false,
  error: message,
})

const mapLegacyToRpc = (message: LegacyIframeRequest, context: BridgeContext): JsonRpcRequest | null => {
  const options = isRecord(message.options) ? message.options : {}

  switch (message.type) {
    case 'CUSTOM_TOOL_EXECUTE':
      return {
        jsonrpc: '2.0',
        id: message.requestId,
        method: 'customTool.invoke',
        params: {
          name: options.name,
          toolPath: options.toolPath,
          args: isRecord(options.args) ? options.args : {},
          bustCache: options.bustCache === true,
          rootPath: context.rootPath ?? null,
        },
      }

    case 'FS_READ_FILE':
      return {
        jsonrpc: '2.0',
        id: message.requestId,
        method: 'fs.readFile',
        params: {
          path: typeof options.path === 'string' ? options.path : options.filePath,
          cwd: options.cwd,
          maxBytes: options.maxBytes,
          startLine: options.startLine,
          endLine: options.endLine,
          ranges: options.ranges,
          includeHash: options.includeHash,
          rootPath: context.rootPath ?? null,
        },
      }

    case 'AUTH_CONTEXT':
      return {
        jsonrpc: '2.0',
        id: message.requestId,
        method: 'auth.context',
        params: {
          tenantId: context.userId ?? null,
        },
      }

    case 'HTTP_REQUEST':
      return {
        jsonrpc: '2.0',
        id: message.requestId,
        method: 'http.request',
        params: {
          url: options.url,
          method: options.method,
          headers: options.headers,
          body: options.body,
          timeout: options.timeout,
        },
      }

    default:
      return null
  }
}

const normalizeLegacyResponse = (request: LegacyIframeRequest, response: JsonRpcResponse) => {
  if (response.error) {
    return toLegacyErrorResponse(request, response.error.message || 'JSON-RPC request failed')
  }

  const result = response.result
  if (isRecord(result)) {
    return {
      type: `${request.type}_RESPONSE`,
      requestId: request.requestId,
      ...result,
    }
  }

  return {
    type: `${request.type}_RESPONSE`,
    requestId: request.requestId,
    success: true,
    result,
  }
}

const callRpc = async (request: JsonRpcRequest, context: BridgeContext): Promise<JsonRpcResponse> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (context.toolName) headers['x-tool-name'] = context.toolName
  if (context.userId) headers['x-user-id'] = context.userId
  if (context.rootPath) headers['x-root-path'] = context.rootPath

  const res = await fetch('/api/headless/custom-tools/rpc', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })

  let payload: JsonRpcResponse | null = null
  try {
    payload = (await res.json()) as JsonRpcResponse
  } catch {
    payload = null
  }

  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32000,
        message: payload?.error?.message || `HTTP ${res.status}`,
      },
    }
  }

  if (!payload || payload.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32000,
        message: 'Invalid JSON-RPC response payload',
      },
    }
  }

  return payload
}

export const attachCustomToolIframeBridge = (
  iframe: HTMLIFrameElement,
  context: BridgeContext
): (() => void) => {
  const handleMessage = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return

    const data = event.data

    try {
      if (isJsonRpcRequest(data)) {
        const request = data
        if (request.id === undefined || request.id === null) return

        const response = await callRpc(request, context)
        iframe.contentWindow?.postMessage(response, '*')
        return
      }

      if (isLegacyRequest(data)) {
        const request = data
        const mapped = mapLegacyToRpc(request, context)
        if (!mapped) {
          iframe.contentWindow?.postMessage(
            toLegacyErrorResponse(request, `Unsupported legacy bridge type: ${request.type}`),
            '*'
          )
          return
        }

        const response = await callRpc(mapped, context)
        iframe.contentWindow?.postMessage(normalizeLegacyResponse(request, response), '*')
      }
    } catch (error) {
      if (isLegacyRequest(data)) {
        iframe.contentWindow?.postMessage(
          toLegacyErrorResponse(data, error instanceof Error ? error.message : String(error)),
          '*'
        )
        return
      }

      if (isJsonRpcRequest(data) && data.id !== undefined && data.id !== null) {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id: data.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          },
          '*'
        )
      }
    }
  }

  window.addEventListener('message', handleMessage)

  return () => {
    window.removeEventListener('message', handleMessage)
  }
}
