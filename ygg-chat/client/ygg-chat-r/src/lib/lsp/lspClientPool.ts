import * as monaco from 'monaco-editor'
import { buildLocalWebSocketUrl, localApi } from '../../utils/api'
import { applyLspWorkspaceEdit } from './monacoMappings'
import { fromFileUri, getFilePathFromModel, toFileUriString } from './uri'

type JsonRpcId = string | number

type LspResolveResponse = {
  available: boolean
  filePath: string
  fileUri: string
  lspLanguageId: string | null
  serverId: string | null
  sessionKey: string | null
  workspacePath: string | null
  workspaceUri: string | null
  command: string | null
  commandSource: string | null
  args: string[]
  initializationOptions?: unknown
  settings?: unknown
  reason?: string | null
}

type TrackedDocument = {
  uri: string
  languageId: string
  version: number
  text: string
  openedGeneration: number
}

type PendingRequest = {
  method: string
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
}

type SessionContext = {
  descriptor: LspResolveResponse
  session: LspTransportSession
}

const SESSION_IDLE_DISCONNECT_MS = 15_000

function normalizeFileKey(filePath: string): string {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/')
  return /^(?:[a-z]:)/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function mapDiagnosticSeverity(severity?: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error
    case 2:
      return monaco.MarkerSeverity.Warning
    case 3:
      return monaco.MarkerSeverity.Info
    case 4:
      return monaco.MarkerSeverity.Hint
    default:
      return monaco.MarkerSeverity.Info
  }
}

function buildInitializeCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      applyEdit: true,
      configuration: true,
      workspaceFolders: true,
      executeCommand: {
        dynamicRegistration: false,
      },
    },
    textDocument: {
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
      },
      synchronization: {
        didSave: true,
        dynamicRegistration: false,
      },
      completion: {
        dynamicRegistration: false,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          resolveSupport: {
            properties: ['documentation', 'detail', 'additionalTextEdits', 'command'],
          },
        },
        completionItemKind: {
          valueSet: Array.from({ length: 25 }, (_, index) => index + 1),
        },
        contextSupport: true,
      },
      hover: {
        dynamicRegistration: false,
        contentFormat: ['markdown', 'plaintext'],
      },
      definition: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      implementation: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      typeDefinition: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      references: {
        dynamicRegistration: false,
      },
      documentHighlight: {
        dynamicRegistration: false,
      },
      documentSymbol: {
        dynamicRegistration: false,
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: {
          valueSet: Array.from({ length: 26 }, (_, index) => index + 1),
        },
      },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: {
            labelOffsetSupport: true,
          },
        },
        contextSupport: true,
      },
      rename: {
        dynamicRegistration: false,
        prepareSupport: true,
      },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              '',
              'quickfix',
              'refactor',
              'refactor.extract',
              'refactor.inline',
              'refactor.rewrite',
              'source',
              'source.organizeImports',
              'source.fixAll',
            ],
          },
        },
        resolveSupport: {
          properties: ['edit', 'command'],
        },
      },
      formatting: {
        dynamicRegistration: false,
      },
    },
  }
}

function getNestedCapability(capabilities: Record<string, any> | null, path: string): any {
  if (!capabilities || !path) return null

  return path.split('.').reduce<any>((currentValue, segment) => {
    if (!currentValue) return null
    return currentValue[segment]
  }, capabilities)
}

class LspTransportSession {
  private readonly documents = new Map<string, TrackedDocument>()
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>()
  private websocket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private nextRequestId = 1
  private initialized = false
  private connectionGeneration = 0
  private idleDisconnectTimer: number | null = null
  private serverCapabilities: Record<string, any> | null = null

  constructor(private readonly descriptor: LspResolveResponse) {}

  private get markerOwner(): string {
    return `ygg-lsp:${this.descriptor.serverId || 'unknown'}`
  }

  private clearIdleDisconnectTimer(): void {
    if (this.idleDisconnectTimer !== null) {
      window.clearTimeout(this.idleDisconnectTimer)
      this.idleDisconnectTimer = null
    }
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleDisconnectTimer()
    if (this.documents.size > 0) return
    this.idleDisconnectTimer = window.setTimeout(() => {
      void this.disconnect()
    }, SESSION_IDLE_DISCONNECT_MS)
  }

  private bindWebSocket(socket: WebSocket): void {
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data || '{}'))
        void this.handleServerMessage(message)
      } catch (error) {
        console.warn('[LSP] Failed to parse server message:', error)
      }
    })

    socket.addEventListener('close', event => {
      if (this.websocket !== socket) return
      this.websocket = null
      this.initialized = false
      this.connectPromise = null
      this.serverCapabilities = null
      this.rejectPendingRequests(new Error(event.reason || 'LSP websocket closed'))
    })
  }

  private rejectPendingRequests(error: Error): void {
    const pending = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    pending.forEach(request => request.reject(error))
  }

  private sendMessage(payload: Record<string, unknown>): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('LSP websocket is not connected.')
    }
    this.websocket.send(JSON.stringify(payload))
  }

  private sendNotification(method: string, params: unknown): void {
    this.sendMessage({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result,
    })
  }

  private sendRequest(method: string, params: unknown): Promise<any> {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { method, resolve, reject })
      try {
        this.sendMessage({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        })
      } catch (error) {
        this.pendingRequests.delete(requestId)
        reject(error)
      }
    })
  }

  private applyDiagnostics(params: any): void {
    const uri = String(params?.uri || '').trim()
    if (!uri) return

    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (!model) return

    const markers = Array.isArray(params?.diagnostics)
      ? params.diagnostics.map((diagnostic: any) => ({
          message: String(diagnostic?.message || 'Unknown diagnostic'),
          severity: mapDiagnosticSeverity(diagnostic?.severity),
          startLineNumber: Number(diagnostic?.range?.start?.line ?? 0) + 1,
          startColumn: Number(diagnostic?.range?.start?.character ?? 0) + 1,
          endLineNumber: Number(diagnostic?.range?.end?.line ?? 0) + 1,
          endColumn: Number(diagnostic?.range?.end?.character ?? 0) + 1,
          source: String(diagnostic?.source || this.descriptor.serverId || 'lsp'),
          code: diagnostic?.code,
        }))
      : []

    monaco.editor.setModelMarkers(model, this.markerOwner, markers)
  }

  private async handleServerRequest(message: any): Promise<void> {
    const requestId = message?.id as JsonRpcId
    const method = String(message?.method || '')

    switch (method) {
      case 'workspace/configuration': {
        const items = Array.isArray(message?.params?.items) ? message.params.items : []
        const settings = this.descriptor.settings ?? null
        this.sendResponse(
          requestId,
          items.map(() => settings)
        )
        return
      }
      case 'workspace/workspaceFolders': {
        const workspaceFolder = this.descriptor.workspacePath && this.descriptor.workspaceUri
          ? [
              {
                uri: this.descriptor.workspaceUri,
                name: this.descriptor.workspacePath.split(/[\\/]/).pop() || this.descriptor.workspacePath,
              },
            ]
          : []
        this.sendResponse(requestId, workspaceFolder)
        return
      }
      case 'workspace/applyEdit': {
        const result = await applyLspWorkspaceEdit(message?.params?.edit)
        this.sendResponse(requestId, result)
        return
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create': {
        this.sendResponse(requestId, null)
        return
      }
      default: {
        this.sendResponse(requestId, null)
      }
    }
  }

  private async handleServerMessage(message: any): Promise<void> {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !Object.prototype.hasOwnProperty.call(message, 'method')) {
      const requestId = message.id as JsonRpcId
      const request = this.pendingRequests.get(requestId)
      if (!request) return
      this.pendingRequests.delete(requestId)
      if (message.error) {
        request.reject(new Error(String(message.error?.message || `LSP ${request.method} request failed`)))
        return
      }
      request.resolve(message.result)
      return
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'method')) {
      await this.handleServerRequest(message)
      return
    }

    const method = String(message?.method || '')
    switch (method) {
      case 'textDocument/publishDiagnostics':
        this.applyDiagnostics(message.params)
        return
      case 'window/logMessage':
      case 'window/showMessage':
        if (message?.params?.message) {
          console.info(`[LSP ${this.descriptor.serverId}]`, message.params.message)
        }
        return
      default:
        return
    }
  }

  private async initializeConnection(): Promise<void> {
    const initializeResult = await this.sendRequest('initialize', {
      processId: null,
      clientInfo: {
        name: 'ygg-chat',
        version: 'phase-3',
      },
      rootUri: this.descriptor.workspaceUri,
      workspaceFolders:
        this.descriptor.workspacePath && this.descriptor.workspaceUri
          ? [
              {
                uri: this.descriptor.workspaceUri,
                name: this.descriptor.workspacePath.split(/[\\/]/).pop() || this.descriptor.workspacePath,
              },
            ]
          : null,
      initializationOptions: this.descriptor.initializationOptions,
      capabilities: buildInitializeCapabilities(),
    })

    this.serverCapabilities = initializeResult?.capabilities || {}
    this.initialized = true
    this.connectionGeneration += 1
    this.sendNotification('initialized', {})
    if (this.descriptor.settings) {
      this.sendNotification('workspace/didChangeConfiguration', {
        settings: this.descriptor.settings,
      })
    }

    this.replayTrackedDocuments()
  }

  private replayTrackedDocuments(): void {
    for (const document of this.documents.values()) {
      document.version = 1
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: document.uri,
          languageId: document.languageId,
          version: document.version,
          text: document.text,
        },
      })
      document.openedGeneration = this.connectionGeneration
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.clearIdleDisconnectTimer()
    if (this.initialized && this.websocket?.readyState === WebSocket.OPEN) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<void>(async (resolve, reject) => {
      let settled = false
      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        this.connectPromise = null
        reject(error)
      }

      try {
        const params = new URLSearchParams({
          serverId: String(this.descriptor.serverId || ''),
          workspacePath: String(this.descriptor.workspacePath || ''),
          clientId: 'renderer',
        })
        const websocketUrl = await buildLocalWebSocketUrl(`/lsp?${params.toString()}`)
        const socket = new WebSocket(websocketUrl)
        this.websocket = socket
        this.bindWebSocket(socket)

        socket.addEventListener('error', () => {
          settleReject(new Error('Failed to connect to the local LSP websocket.'))
        })

        socket.addEventListener('close', event => {
          if (!this.initialized) {
            settleReject(new Error(event.reason || 'LSP websocket closed before initialization completed.'))
          }
        })

        socket.addEventListener('open', async () => {
          try {
            await this.initializeConnection()
            if (!settled) {
              settled = true
              resolve()
            }
          } catch (error) {
            this.connectPromise = null
            this.initialized = false
            this.serverCapabilities = null
            settleReject(error)
            socket.close(1011, 'Failed to initialize LSP connection')
          }
        })
      } catch (error) {
        this.connectPromise = null
        reject(error)
      }
    })

    try {
      await this.connectPromise
    } finally {
      if (this.initialized) {
        this.connectPromise = null
      }
    }
  }

  getCapabilities(): Record<string, any> | null {
    return this.serverCapabilities
  }

  hasCapability(path: string): boolean {
    if (!path) return true
    if (!this.serverCapabilities) return true
    const capability = getNestedCapability(this.serverCapabilities, path)
    if (capability == null) return false
    if (typeof capability === 'boolean') return capability
    return true
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.ensureInitialized()
    return this.sendRequest(method, params)
  }

  async openDocument(filePath: string, text: string, languageId: string): Promise<void> {
    const uri = toFileUriString(filePath)
    let currentDocument = this.documents.get(uri)
    if (currentDocument) {
      currentDocument.text = text
      currentDocument.languageId = languageId
    } else {
      currentDocument = {
        uri,
        languageId,
        version: 1,
        text,
        openedGeneration: 0,
      }
      this.documents.set(uri, currentDocument)
    }

    await this.ensureInitialized()
    if (currentDocument.openedGeneration === this.connectionGeneration) {
      return
    }

    currentDocument.version = 1
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: currentDocument.uri,
        languageId: currentDocument.languageId,
        version: currentDocument.version,
        text: currentDocument.text,
      },
    })
    currentDocument.openedGeneration = this.connectionGeneration
  }

  async changeDocument(filePath: string, text: string, languageId: string): Promise<void> {
    const uri = toFileUriString(filePath)
    const currentDocument = this.documents.get(uri)
    if (!currentDocument) {
      await this.openDocument(filePath, text, languageId)
      return
    }

    currentDocument.text = text
    currentDocument.languageId = languageId

    await this.ensureInitialized()
    if (currentDocument.openedGeneration !== this.connectionGeneration) {
      return
    }

    currentDocument.version += 1
    this.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: currentDocument.uri,
        version: currentDocument.version,
      },
      contentChanges: [{ text: currentDocument.text }],
    })
  }

  async saveDocument(filePath: string, text: string): Promise<void> {
    const uri = toFileUriString(filePath)
    const currentDocument = this.documents.get(uri)
    if (!currentDocument) return
    currentDocument.text = text

    await this.ensureInitialized()
    if (currentDocument.openedGeneration !== this.connectionGeneration) return

    this.sendNotification('textDocument/didSave', {
      textDocument: { uri: currentDocument.uri },
      text,
    })
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = toFileUriString(filePath)
    const currentDocument = this.documents.get(uri)
    this.documents.delete(uri)

    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (model) {
      monaco.editor.setModelMarkers(model, this.markerOwner, [])
    }

    if (!currentDocument) {
      this.scheduleIdleDisconnect()
      return
    }

    if (this.initialized && currentDocument.openedGeneration === this.connectionGeneration) {
      this.sendNotification('textDocument/didClose', {
        textDocument: { uri: currentDocument.uri },
      })
    }

    this.scheduleIdleDisconnect()
  }

  async disconnect(): Promise<void> {
    this.clearIdleDisconnectTimer()
    const socket = this.websocket
    this.websocket = null
    this.initialized = false
    this.connectPromise = null
    this.serverCapabilities = null
    this.rejectPendingRequests(new Error('LSP connection disconnected'))

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, 'Idle LSP session closed')
    }
  }
}

class LspClientPool {
  private readonly sessions = new Map<string, LspTransportSession>()
  private readonly resolvedFiles = new Map<string, LspResolveResponse>()

  private async resolveFile(filePath: string): Promise<LspResolveResponse | null> {
    const normalizedFileKey = normalizeFileKey(filePath)
    const cachedDescriptor = this.resolvedFiles.get(normalizedFileKey)
    if (cachedDescriptor) return cachedDescriptor

    try {
      const response = await localApi.get<LspResolveResponse>(`/lsp/resolve?path=${encodeURIComponent(filePath)}`, {
        cache: 'no-store',
      })
      this.resolvedFiles.set(normalizedFileKey, response)
      return response
    } catch (error) {
      console.warn('[LSP] Failed to resolve LSP session for file:', filePath, error)
      return null
    }
  }

  private async getSessionForFile(filePath: string): Promise<SessionContext | null> {
    const descriptor = await this.resolveFile(filePath)
    if (!descriptor?.available || !descriptor.sessionKey || !descriptor.workspacePath || !descriptor.serverId || !descriptor.lspLanguageId) {
      return null
    }

    let session = this.sessions.get(descriptor.sessionKey)
    if (!session) {
      session = new LspTransportSession(descriptor)
      this.sessions.set(descriptor.sessionKey, session)
    }

    return { descriptor, session }
  }

  private async getSessionForUri(uri: string): Promise<SessionContext | null> {
    const filePath = fromFileUri(uri)
    if (!filePath) return null
    return this.getSessionForFile(filePath)
  }

  private async getSessionForModel(model: monaco.editor.ITextModel): Promise<SessionContext | null> {
    const filePath = getFilePathFromModel(model)
    if (!filePath) return null
    return this.getSessionForFile(filePath)
  }

  async requestForModel(
    model: monaco.editor.ITextModel,
    method: string,
    params: unknown,
    capabilityPath?: string
  ): Promise<any | null> {
    try {
      const sessionContext = await this.getSessionForModel(model)
      if (!sessionContext) return null
      if (capabilityPath && !sessionContext.session.hasCapability(capabilityPath)) return null
      return await sessionContext.session.request(method, params)
    } catch (error) {
      console.warn(`[LSP] ${method} failed for model:`, model.uri.toString(), error)
      return null
    }
  }

  async requestForUri(uri: string, method: string, params: unknown, capabilityPath?: string): Promise<any | null> {
    try {
      const sessionContext = await this.getSessionForUri(uri)
      if (!sessionContext) return null
      if (capabilityPath && !sessionContext.session.hasCapability(capabilityPath)) return null
      return await sessionContext.session.request(method, params)
    } catch (error) {
      console.warn(`[LSP] ${method} failed for uri:`, uri, error)
      return null
    }
  }

  async resolveCompletionItem(uri: string, item: any): Promise<any | null> {
    return this.requestForUri(uri, 'completionItem/resolve', item, 'completionProvider.resolveProvider')
  }

  async resolveCodeAction(uri: string, action: any): Promise<any | null> {
    return this.requestForUri(uri, 'codeAction/resolve', action, 'codeActionProvider.resolveProvider')
  }

  async executeCommandForUri(uri: string, command: string, args: unknown[] = []): Promise<any | null> {
    return this.requestForUri(
      uri,
      'workspace/executeCommand',
      {
        command,
        arguments: args,
      },
      'executeCommandProvider'
    )
  }

  async didOpenDocument(filePath: string, text: string): Promise<void> {
    try {
      const sessionInfo = await this.getSessionForFile(filePath)
      if (!sessionInfo) return
      await sessionInfo.session.openDocument(filePath, text, sessionInfo.descriptor.lspLanguageId!)
    } catch (error) {
      console.warn('[LSP] didOpen failed for file:', filePath, error)
    }
  }

  async didChangeDocument(filePath: string, text: string): Promise<void> {
    try {
      const sessionInfo = await this.getSessionForFile(filePath)
      if (!sessionInfo) return
      await sessionInfo.session.changeDocument(filePath, text, sessionInfo.descriptor.lspLanguageId!)
    } catch (error) {
      console.warn('[LSP] didChange failed for file:', filePath, error)
    }
  }

  async didSaveDocument(filePath: string, text: string): Promise<void> {
    try {
      const sessionInfo = await this.getSessionForFile(filePath)
      if (!sessionInfo) return
      await sessionInfo.session.saveDocument(filePath, text)
    } catch (error) {
      console.warn('[LSP] didSave failed for file:', filePath, error)
    }
  }

  async didCloseDocument(filePath: string): Promise<void> {
    try {
      const normalizedFileKey = normalizeFileKey(filePath)
      const descriptor = this.resolvedFiles.get(normalizedFileKey) || (await this.resolveFile(filePath))
      if (!descriptor?.sessionKey) return

      const session = this.sessions.get(descriptor.sessionKey)
      if (!session) return
      await session.closeDocument(filePath)
    } catch (error) {
      console.warn('[LSP] didClose failed for file:', filePath, error)
    }
  }

  async dispose(): Promise<void> {
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    this.resolvedFiles.clear()
    await Promise.allSettled(sessions.map(session => session.disconnect()))
  }
}

export const lspClientPool = new LspClientPool()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void lspClientPool.dispose()
  })
}
