import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Buffer } from 'buffer'
import path from 'path'
import { readTextFile } from '../tools/readFile.js'
import type { LspFileContext, LspFileContextDiagnostic, LspFileContextSymbol, LspResolveResult } from './types.js'

const DIRECT_REQUEST_TIMEOUT_MS = 4000
const DIAGNOSTIC_SETTLE_MS = 150
const MAX_CONTEXT_SYMBOLS = 50
const MAX_CONTEXT_DIAGNOSTICS = 25
const FULL_FILE_READ_MAX_BYTES = Number.MAX_SAFE_INTEGER

function frameJsonRpcMessage(jsonPayload: string): Buffer {
  const body = Buffer.from(jsonPayload, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

function shouldSpawnWithShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  const extension = path.extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function simplifyRange(range: any) {
  return {
    startLine: Number(range?.start?.line ?? 0) + 1,
    startCharacter: Number(range?.start?.character ?? 0) + 1,
    endLine: Number(range?.end?.line ?? 0) + 1,
    endCharacter: Number(range?.end?.character ?? 0) + 1,
  }
}

function simplifyDocumentSymbol(symbol: any): LspFileContextSymbol {
  return {
    name: String(symbol?.name ?? ''),
    kind: typeof symbol?.kind === 'number' ? symbol.kind : null,
    detail: typeof symbol?.detail === 'string' ? symbol.detail : null,
    range: simplifyRange(symbol?.range || symbol?.location?.range),
    children: Array.isArray(symbol?.children)
      ? symbol.children.slice(0, MAX_CONTEXT_SYMBOLS).map((child: any) => simplifyDocumentSymbol(child))
      : undefined,
  }
}

function simplifyDiagnostic(diagnostic: any): LspFileContextDiagnostic {
  return {
    message: String(diagnostic?.message ?? ''),
    severity: typeof diagnostic?.severity === 'number' ? diagnostic.severity : null,
    source: typeof diagnostic?.source === 'string' ? diagnostic.source : null,
    code:
      typeof diagnostic?.code === 'string' || typeof diagnostic?.code === 'number' ? diagnostic.code : null,
    range: simplifyRange(diagnostic?.range),
  }
}

function simplifySymbols(symbols: any): LspFileContextSymbol[] {
  const list = Array.isArray(symbols) ? symbols : []
  return list.slice(0, MAX_CONTEXT_SYMBOLS).map((symbol: any) => simplifyDocumentSymbol(symbol))
}

function buildDirectInitializeCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      configuration: true,
      workspaceFolders: true,
    },
    textDocument: {
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
      },
      documentSymbol: {
        hierarchicalDocumentSymbolSupport: true,
      },
    },
  }
}

class DirectLspToolClient {
  private childProcess: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private stdoutBuffer = Buffer.alloc(0)
  private readonly pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (reason?: unknown) => void; timer: NodeJS.Timeout }>()
  private nextRequestId = 1
  private initialized = false
  private readonly diagnosticsByUri = new Map<string, any[]>()
  private closed = false

  constructor(private readonly resolveResult: LspResolveResult) {}

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.childProcess || this.childProcess.stdin.destroyed) {
      throw new Error('Direct LSP tool client is not connected.')
    }

    this.childProcess.stdin.write(frameJsonRpcMessage(JSON.stringify(message)))
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  private sendResponse(id: string | number, result: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      result,
    })
  }

  private sendRequest(method: string, params: unknown): Promise<any> {
    const requestId = `tool-${Date.now()}-${this.nextRequestId++}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Timed out waiting for LSP response to ${method}.`))
      }, DIRECT_REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(requestId, { resolve, reject, timer })

      try {
        this.writeMessage({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        })
      } catch (error) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        reject(error)
      }
    })
  }

  private rejectPendingRequests(error: Error): void {
    const pendingEntries = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    pendingEntries.forEach(entry => {
      clearTimeout(entry.timer)
      entry.reject(error)
    })
  }

  private async handleServerRequest(message: any): Promise<void> {
    const requestId = message?.id
    const method = String(message?.method || '')

    switch (method) {
      case 'workspace/configuration': {
        const items = Array.isArray(message?.params?.items) ? message.params.items : []
        const settings = this.resolveResult.settings ?? null
        this.sendResponse(requestId, items.map(() => settings))
        return
      }
      case 'workspace/workspaceFolders': {
        const workspaceFolders =
          this.resolveResult.workspacePath && this.resolveResult.workspaceUri
            ? [
                {
                  uri: this.resolveResult.workspaceUri,
                  name: path.basename(this.resolveResult.workspacePath),
                },
              ]
            : []
        this.sendResponse(requestId, workspaceFolders)
        return
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create': {
        this.sendResponse(requestId, null)
        return
      }
      case 'workspace/applyEdit': {
        this.sendResponse(requestId, {
          applied: false,
          failureReason: 'Workspace edits are not applied in direct LSP tool context mode.',
        })
        return
      }
      default: {
        this.sendResponse(requestId, null)
      }
    }
  }

  private async handleServerMessage(payload: string): Promise<void> {
    const message = JSON.parse(payload)

    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !Object.prototype.hasOwnProperty.call(message, 'method')) {
      const requestId = String(message.id)
      const pendingRequest = this.pendingRequests.get(requestId)
      if (!pendingRequest) return

      this.pendingRequests.delete(requestId)
      clearTimeout(pendingRequest.timer)
      if (message.error) {
        pendingRequest.reject(new Error(String(message.error?.message || 'LSP request failed.')))
        return
      }
      pendingRequest.resolve(message.result)
      return
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'method')) {
      await this.handleServerRequest(message)
      return
    }

    const method = String(message?.method || '')
    if (method === 'textDocument/publishDiagnostics') {
      const uri = String(message?.params?.uri || '').trim()
      const diagnostics = Array.isArray(message?.params?.diagnostics) ? message.params.diagnostics : []
      if (uri) {
        this.diagnosticsByUri.set(uri, diagnostics)
      }
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])

    while (this.stdoutBuffer.length > 0) {
      const headerEndIndex = this.stdoutBuffer.indexOf('\r\n\r\n')
      if (headerEndIndex === -1) return

      const headerText = this.stdoutBuffer.subarray(0, headerEndIndex).toString('utf8')
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText)
      if (!contentLengthMatch) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEndIndex + 4)
        continue
      }

      const contentLength = Number(contentLengthMatch[1])
      const totalFrameLength = headerEndIndex + 4 + contentLength
      if (this.stdoutBuffer.length < totalFrameLength) return

      const payload = this.stdoutBuffer.subarray(headerEndIndex + 4, totalFrameLength).toString('utf8')
      this.stdoutBuffer = this.stdoutBuffer.subarray(totalFrameLength)
      void this.handleServerMessage(payload)
    }
  }

  async start(): Promise<void> {
    if (this.childProcess && !this.closed) return
    if (this.startPromise) return this.startPromise
    if (!this.resolveResult.command) {
      throw new Error('LSP command is unavailable for direct tool context.')
    }

    this.closed = false
    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.resolveResult.command!, this.resolveResult.args || [], {
        cwd: this.resolveResult.workspacePath || process.cwd(),
        env: {
          ...process.env,
        },
        stdio: 'pipe',
        windowsHide: true,
        shell: shouldSpawnWithShell(this.resolveResult.command!),
      })

      this.childProcess = child
      let settled = false

      child.once('spawn', () => {
        settled = true
        resolve()
      })

      child.stdout.on('data', chunk => {
        this.handleStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })

      child.once('error', error => {
        this.childProcess = null
        this.startPromise = null
        this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)))
        if (!settled) reject(error)
      })

      child.once('exit', (code, signal) => {
        this.childProcess = null
        this.startPromise = null
        this.closed = true
        this.rejectPendingRequests(new Error(`LSP tool context process exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`))
        if (!settled) {
          reject(new Error(`LSP tool context process exited before initialization completed.`))
        }
      })
    })

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.start()

    const initializeResult = await this.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: {
        name: 'ygg-chat-tool-context',
        version: '1',
      },
      rootUri: this.resolveResult.workspaceUri,
      workspaceFolders:
        this.resolveResult.workspacePath && this.resolveResult.workspaceUri
          ? [
              {
                uri: this.resolveResult.workspaceUri,
                name: path.basename(this.resolveResult.workspacePath),
              },
            ]
          : null,
      initializationOptions: this.resolveResult.initializationOptions,
      capabilities: buildDirectInitializeCapabilities(),
    })

    this.initialized = true
    this.sendNotification('initialized', {})
    if (this.resolveResult.settings) {
      this.sendNotification('workspace/didChangeConfiguration', {
        settings: this.resolveResult.settings,
      })
    }

    void initializeResult
  }

  async openDocument(fileUri: string, languageId: string, text: string): Promise<void> {
    await this.initialize()
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: fileUri,
        languageId,
        version: 1,
        text,
      },
    })
  }

  async closeDocument(fileUri: string): Promise<void> {
    if (!this.initialized) return
    this.sendNotification('textDocument/didClose', {
      textDocument: {
        uri: fileUri,
      },
    })
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.initialize()
    return this.sendRequest(method, params)
  }

  getDiagnostics(fileUri: string): any[] {
    return this.diagnosticsByUri.get(fileUri) || []
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true

    try {
      if (this.initialized) {
        await this.sendRequest('shutdown', null).catch(() => null)
        this.sendNotification('exit', null)
      }
    } catch {
      // Ignore shutdown errors.
    }

    if (this.childProcess) {
      const child = this.childProcess
      this.childProcess = null
      await new Promise<void>(resolve => {
        const timeoutId = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Ignore forced termination errors.
          }
          resolve()
        }, 1000)

        child.once('exit', () => {
          clearTimeout(timeoutId)
          resolve()
        })

        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(timeoutId)
          resolve()
        }
      })
    }
  }
}

export async function collectLspFileContext(resolveResult: LspResolveResult): Promise<LspFileContext | null> {
  if (
    !resolveResult.available ||
    !resolveResult.command ||
    !resolveResult.filePath ||
    !resolveResult.fileUri ||
    !resolveResult.workspacePath ||
    !resolveResult.lspLanguageId
  ) {
    return {
      available: false,
      filePath: resolveResult.filePath,
      fileUri: resolveResult.fileUri,
      serverId: resolveResult.serverId,
      lspLanguageId: resolveResult.lspLanguageId,
      workspacePath: resolveResult.workspacePath,
      command: resolveResult.command,
      commandSource: resolveResult.commandSource,
      symbols: [],
      diagnostics: [],
      reason: resolveResult.reason || 'LSP server is unavailable for this file.',
    }
  }

  const fileData = await readTextFile(resolveResult.filePath, {
    cwd: resolveResult.workspacePath,
    maxBytes: FULL_FILE_READ_MAX_BYTES,
    includeHash: false,
  })

  if (fileData.truncated) {
    return {
      available: false,
      filePath: resolveResult.filePath,
      fileUri: resolveResult.fileUri,
      serverId: resolveResult.serverId,
      lspLanguageId: resolveResult.lspLanguageId,
      workspacePath: resolveResult.workspacePath,
      command: resolveResult.command,
      commandSource: resolveResult.commandSource,
      symbols: [],
      diagnostics: [],
      reason: 'File content was truncated before LSP context could be collected.',
    }
  }

  const client = new DirectLspToolClient(resolveResult)
  try {
    await client.openDocument(resolveResult.fileUri, resolveResult.lspLanguageId, fileData.content)
    const symbolsResponse = await client
      .request('textDocument/documentSymbol', {
        textDocument: {
          uri: resolveResult.fileUri,
        },
      })
      .catch(() => [])

    await delay(DIAGNOSTIC_SETTLE_MS)

    return {
      available: true,
      filePath: resolveResult.filePath,
      fileUri: resolveResult.fileUri,
      serverId: resolveResult.serverId,
      lspLanguageId: resolveResult.lspLanguageId,
      workspacePath: resolveResult.workspacePath,
      command: resolveResult.command,
      commandSource: resolveResult.commandSource,
      symbols: simplifySymbols(symbolsResponse),
      diagnostics: client.getDiagnostics(resolveResult.fileUri).slice(0, MAX_CONTEXT_DIAGNOSTICS).map(simplifyDiagnostic),
      reason: null,
    }
  } finally {
    await client.closeDocument(resolveResult.fileUri).catch(() => undefined)
    await client.dispose().catch(() => undefined)
  }
}
