import type { Express, Request, Response } from 'express'
import type { IncomingMessage, Server } from 'http'
import type { Socket } from 'net'
import { lspManager } from './LspManager.js'
import { listConfiguredLspCommands, setConfiguredLspCommand } from './LspSettingsStore.js'
import { LspWebSocketBridge } from './LspWebSocketBridge.js'

let routesRegistered = false
let lspWebSocketBridge: LspWebSocketBridge | null = null

function getQueryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function applyNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

export function registerLspRoutes(app: Express): void {
  if (routesRegistered) return
  routesRegistered = true

  app.get('/api/lsp/servers', (_req: Request, res: Response) => {
    applyNoStore(res)
    res.json({
      servers: lspManager.listServers(),
    })
  })

  app.get('/api/lsp/sessions', (_req: Request, res: Response) => {
    applyNoStore(res)
    res.json({
      sessions: lspManager.listSessions(),
    })
  })

  app.get('/api/lsp/config', (_req: Request, res: Response) => {
    applyNoStore(res)
    res.json({
      commands: listConfiguredLspCommands(),
    })
  })

  app.post('/api/lsp/config', async (req: Request, res: Response) => {
    applyNoStore(res)
    try {
      const serverId = getQueryString(req.body?.serverId)
      const command = getQueryString(req.body?.command) || null
      if (!serverId) {
        res.status(400).json({ error: 'serverId is required.' })
        return
      }

      const configuredCommand = setConfiguredLspCommand(serverId, command)
      const stoppedSessions = await lspManager.shutdownServer(serverId)
      res.json({
        serverId,
        command: configuredCommand,
        stoppedSessions,
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/lsp/resolve', (req: Request, res: Response) => {
    applyNoStore(res)
    const filePath = getQueryString(req.query.path)
    const preferredServerId = getQueryString(req.query.serverId) || null

    if (!filePath) {
      res.status(400).json({ error: 'Query parameter "path" is required.' })
      return
    }

    res.json(lspManager.resolveFile(filePath, preferredServerId))
  })

  app.post('/api/lsp/restart', async (req: Request, res: Response) => {
    applyNoStore(res)
    try {
      const serverId = getQueryString(req.body?.serverId)
      const workspacePath = getQueryString(req.body?.workspacePath)
      if (!serverId || !workspacePath) {
        res.status(400).json({ error: 'serverId and workspacePath are required.' })
        return
      }

      const session = await lspManager.restartSession(serverId, workspacePath)
      res.json({ restarted: true, session })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/lsp/shutdown', async (req: Request, res: Response) => {
    applyNoStore(res)
    try {
      const serverId = getQueryString(req.body?.serverId)
      const workspacePath = getQueryString(req.body?.workspacePath)
      if (!serverId || !workspacePath) {
        res.status(400).json({ error: 'serverId and workspacePath are required.' })
        return
      }

      const stopped = await lspManager.shutdownSession(serverId, workspacePath)
      res.json({ stopped })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export function initializeLspLocalServer(server: Server): void {
  if (lspWebSocketBridge) return
  lspWebSocketBridge = new LspWebSocketBridge(server, lspManager)
}

export function handleLspWebSocketUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
  return lspWebSocketBridge?.handleUpgrade(request, socket, head) || false
}

export async function shutdownLspLocalServer(): Promise<void> {
  const currentBridge = lspWebSocketBridge
  lspWebSocketBridge = null

  await Promise.allSettled([
    currentBridge?.close() || Promise.resolve(),
    lspManager.shutdown(),
  ])
}
