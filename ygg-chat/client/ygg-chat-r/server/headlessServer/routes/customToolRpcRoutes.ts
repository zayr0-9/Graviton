import type { Express, Request } from 'express'
import path from 'node:path'
// Resolves to this program's fetch body type (undici under Node, DOM under Electron)
type BodyInit = NonNullable<RequestInit['body']>
import { execute as executeCustomToolManager } from '../../tools/customToolManager.js'
import { toolOrchestrator } from '../../tools/orchestrator/index.js'

type JsonRpcId = number | string | null

type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: any
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: any
  error?: { code: number; message: string; data?: any }
}

type ToolExecutionContext = {
  timeoutMs?: number
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  conversationId?: string | null
  messageId?: string | null
  streamId?: string | null
}

const METHOD_NOT_FOUND = -32601
const INVALID_REQUEST = -32600
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32000

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeHeaderValue = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) return normalizeHeaderValue(value[0])
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const toJsonRpcError = (id: JsonRpcId, code: number, message: string, data?: any): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, data },
})

const toJsonRpcResult = (id: JsonRpcId, result: any): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
})

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

const executeToolViaOrchestrator = async (
  toolName: string,
  args: Record<string, any>,
  context: ToolExecutionContext
): Promise<any> => {
  const timeoutMs = Math.max(1_000, Math.min(context.timeoutMs ?? 120_000, 600_000))

  const job = toolOrchestrator.submit(toolName, args, {
    timeoutMs,
    rootPath: context.rootPath ?? null,
    operationMode: context.operationMode ?? 'execute',
    conversationId: context.conversationId ?? null,
    messageId: context.messageId ?? null,
    streamId: context.streamId ?? null,
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const current = toolOrchestrator.getJob(job.id)
    if (!current) {
      throw new Error(`Tool job disappeared: ${job.id}`)
    }

    if (current.status === 'completed') {
      return current.result
    }

    if (current.status === 'failed') {
      throw new Error(current.error || `Tool execution failed: ${toolName}`)
    }

    if (current.status === 'cancelled') {
      throw new Error(`Tool execution cancelled: ${toolName}`)
    }

    await sleep(80)
  }

  toolOrchestrator.cancel(job.id)
  throw new Error(`Tool execution timed out after ${timeoutMs}ms: ${toolName}`)
}

const resolveInvokeToolName = async (requested: {
  name?: unknown
  toolPath?: unknown
  contextToolName?: string | null
}): Promise<string | null> => {
  const directName = typeof requested.name === 'string' ? requested.name.trim() : ''
  if (directName) return directName

  if (requested.contextToolName) return requested.contextToolName

  const toolPath = typeof requested.toolPath === 'string' ? requested.toolPath.trim() : ''
  if (!toolPath) return null

  const normalized = toolPath.replace(/[\\/]+$/, '')
  const directoryName = path.basename(normalized)
  if (!directoryName) return null

  try {
    const listed = await executeCustomToolManager({ action: 'list' }, {})
    if (listed?.success && Array.isArray(listed.tools)) {
      const match = listed.tools.find(
        (tool: any) => tool?.directoryName === directoryName || (typeof tool?.name === 'string' && tool.name === directoryName)
      )
      if (match?.name && typeof match.name === 'string') {
        return match.name
      }
    }
  } catch {
    // Fallback to basename below.
  }

  return directoryName
}

const executeHttpRequest = async (params: Record<string, any>): Promise<any> => {
  const url = typeof params.url === 'string' ? params.url.trim() : ''
  if (!url) {
    throw new Error('Missing url')
  }

  const method = typeof params.method === 'string' ? params.method.toUpperCase() : 'GET'
  const timeoutMs =
    typeof params.timeout === 'number' && Number.isFinite(params.timeout) ? Math.max(100, Math.floor(params.timeout)) : 15_000

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers = isRecord(params.headers) ? { ...params.headers } : {}
    const canHaveBody = method !== 'GET' && method !== 'HEAD'
    let body: BodyInit | undefined

    if (canHaveBody && params.body !== undefined) {
      if (typeof params.body === 'string') {
        body = params.body
      } else if (params.body instanceof Uint8Array) {
        body = params.body
      } else {
        body = JSON.stringify(params.body)
        const lowered = Object.keys(headers).map(key => key.toLowerCase())
        if (!lowered.includes('content-type')) {
          ;(headers as any)['content-type'] = 'application/json'
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') || ''
    let data: any = null
    if (contentType.includes('application/json')) {
      try {
        data = await response.json()
      } catch {
        data = null
      }
    } else {
      data = await response.text()
    }

    return {
      success: true,
      status: response.status,
      ok: response.ok,
      // forEach rather than entries(): this project compiles with lib ES2022 and no
      // DOM, where the ambient Headers type does not declare an entries() iterator.
      headers: (() => {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          headers[key] = value
        })
        return headers
      })(),
      data,
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

const getExecutionContext = (req: Request, params: Record<string, any>): ToolExecutionContext => {
  const headerRootPath = normalizeHeaderValue(req.headers['x-root-path'])
  const rootPath =
    (typeof params.rootPath === 'string' && params.rootPath.trim()) ||
    (typeof params.cwd === 'string' && params.cwd.trim()) ||
    headerRootPath ||
    null

  return {
    timeoutMs:
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? Math.max(1_000, Math.floor(params.timeoutMs))
        : undefined,
    rootPath,
    operationMode: params.operationMode === 'plan' ? 'plan' : 'execute',
    conversationId: typeof params.conversationId === 'string' ? params.conversationId : null,
    messageId: typeof params.messageId === 'string' ? params.messageId : null,
    streamId: typeof params.streamId === 'string' ? params.streamId : null,
  }
}

export function registerCustomToolRpcRoutes(app: Express): void {
  app.post('/api/headless/custom-tools/rpc', async (req, res) => {
    const body = req.body as JsonRpcRequest
    const id: JsonRpcId = body && 'id' in body ? ((body.id as JsonRpcId) ?? null) : null

    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      res.json(toJsonRpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC request'))
      return
    }

    const method = body.method
    const params = isRecord(body.params) ? body.params : {}

    try {
      switch (method) {
        case 'auth.context': {
          const tenantId =
            (typeof params.tenantId === 'string' && params.tenantId) ||
            normalizeHeaderValue(req.headers['x-user-id']) ||
            normalizeHeaderValue(req.headers['x-tenant-id']) ||
            null
          res.json(
            toJsonRpcResult(id, {
              success: true,
              tenantId,
            })
          )
          return
        }

        case 'customTool.invoke': {
          const contextToolName = normalizeHeaderValue(req.headers['x-tool-name'])
          const resolvedToolName = await resolveInvokeToolName({
            name: params.name,
            toolPath: params.toolPath,
            contextToolName,
          })

          if (!resolvedToolName) {
            res.json(toJsonRpcError(id, INVALID_PARAMS, 'Missing custom tool name'))
            return
          }

          if (contextToolName && resolvedToolName !== contextToolName) {
            res.json(
              toJsonRpcError(id, INVALID_PARAMS, 'Cross-tool invocation is not allowed', {
                contextToolName,
                attemptedToolName: resolvedToolName,
              })
            )
            return
          }

          const invokeArgs = isRecord(params.args) ? { ...params.args } : {}
          if (params.bustCache === true) {
            invokeArgs._bustCache = true
          }

          const executionContext = getExecutionContext(req, params)
          const result = await executeCustomToolManager(
            {
              action: 'invoke',
              name: resolvedToolName,
              args: invokeArgs,
            },
            {
              cwd: executionContext.rootPath ?? undefined,
              rootPath: executionContext.rootPath ?? undefined,
              operationMode: executionContext.operationMode,
              conversationId: executionContext.conversationId,
              messageId: executionContext.messageId,
              streamId: executionContext.streamId,
            }
          )

          res.json(toJsonRpcResult(id, result))
          return
        }

        case 'fs.readFile': {
          const requestedPath =
            (typeof params.path === 'string' && params.path.trim()) ||
            (typeof params.filePath === 'string' && params.filePath.trim()) ||
            ''
          if (!requestedPath) {
            res.json(toJsonRpcError(id, INVALID_PARAMS, 'Missing path'))
            return
          }

          const executionContext = getExecutionContext(req, params)
          const toolArgs: Record<string, any> = {
            path: requestedPath,
          }

          if (typeof params.cwd === 'string' && params.cwd.trim()) {
            toolArgs.cwd = params.cwd.trim()
          } else if (executionContext.rootPath) {
            toolArgs.cwd = executionContext.rootPath
          }

          if (typeof params.maxBytes === 'number' && Number.isFinite(params.maxBytes)) {
            toolArgs.maxBytes = params.maxBytes
          }
          if (typeof params.startLine === 'number' && Number.isFinite(params.startLine)) {
            toolArgs.startLine = params.startLine
          }
          if (typeof params.endLine === 'number' && Number.isFinite(params.endLine)) {
            toolArgs.endLine = params.endLine
          }
          if (Array.isArray(params.ranges)) {
            toolArgs.ranges = params.ranges
          }
          if (params.includeHash === true) {
            toolArgs.includeHash = true
          }

          const result = await executeToolViaOrchestrator('read_file', toolArgs, executionContext)
          res.json(toJsonRpcResult(id, result))
          return
        }

        case 'http.request': {
          const result = await executeHttpRequest(params)
          res.json(toJsonRpcResult(id, result))
          return
        }

        default:
          res.json(toJsonRpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`))
          return
      }
    } catch (error) {
      res.json(
        toJsonRpcError(
          id,
          INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error)
        )
      )
    }
  })
}
