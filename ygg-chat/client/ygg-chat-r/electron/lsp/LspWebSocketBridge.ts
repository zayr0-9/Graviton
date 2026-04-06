import type { IncomingMessage, Server } from 'http'
import type { Socket } from 'net'
import { WebSocketServer } from 'ws'
import type { LspManager } from './LspManager.js'

export class LspWebSocketBridge {
  private readonly webSocketServer: WebSocketServer

  constructor(_server: Server, private readonly manager: LspManager) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
    })

    this.webSocketServer.on('connection', async (socket, request) => {
      try {
        const url = new URL(request.url || '/lsp', `http://${request.headers.host || '127.0.0.1'}`)
        const serverId = String(url.searchParams.get('serverId') || '').trim()
        const workspacePath = String(url.searchParams.get('workspacePath') || '').trim()
        const clientId = String(url.searchParams.get('clientId') || '').trim() || null

        if (!serverId || !workspacePath) {
          socket.close(1008, 'Missing serverId or workspacePath for LSP websocket connection')
          return
        }

        await this.manager.attachSocket({
          serverId,
          workspacePath,
          clientId,
          socket,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        try {
          socket.close(1011, reason.slice(0, 120) || 'Failed to attach LSP socket')
        } catch {
          // Ignore socket close errors.
        }
      }
    })
  }

  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = new URL(request.url || '/lsp', `http://${request.headers.host || '127.0.0.1'}`)
    if (url.pathname !== '/lsp') {
      return false
    }

    this.webSocketServer.handleUpgrade(request, socket, head, upgradedSocket => {
      this.webSocketServer.emit('connection', upgradedSocket, request)
    })
    return true
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      this.webSocketServer.close(() => resolve())
    })
  }
}
