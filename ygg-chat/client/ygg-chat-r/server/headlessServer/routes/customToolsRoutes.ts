import fs from 'node:fs/promises'
import path from 'node:path'
import type { Express, Request, Response } from 'express'
import { execute as executeCustomToolManager } from '../../tools/customToolManager.js'
import { customToolRegistry, type CustomToolDefinition } from '../../tools/customToolLoader.js'

const UI_ENTRY_CANDIDATES = ['ui/index.html', 'ui.html']

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function buildRequestOrigin(req: Request): string {
  const protocol = req.protocol || 'http'
  const host = req.get('host') || '127.0.0.1:3002'
  return `${protocol}://${host}`
}

function isWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function getCustomTool(name: string): Promise<CustomToolDefinition | null> {
  await customToolRegistry.initialize()
  return customToolRegistry.getDefinitions().find(tool => tool.name === name) ?? null
}

async function resolveUiEntry(tool: CustomToolDefinition): Promise<string | null> {
  const candidates = [tool.ui?.entry, ...UI_ENTRY_CANDIDATES].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )

  for (const relativePath of candidates) {
    const candidate = path.resolve(tool.sourcePath, relativePath)
    if (!isWithin(tool.sourcePath, candidate)) continue
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // continue
    }
  }
  return null
}

function getToolUiBasePath(tool: CustomToolDefinition, entryPath: string): string {
  return path.dirname(entryPath)
}

function getContentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function buildUiConfig(req: Request, tool: CustomToolDefinition) {
  const origin = buildRequestOrigin(req)
  return {
    toolName: tool.name,
    toolDir: tool.sourcePath,
    initialState: null,
    headlessServer: true,
    appOrigin: origin,
    appBaseUrl: `${origin}/api/headless/custom-tools/ui/${encodeURIComponent(tool.name)}/`,
    rpcBaseUrl: `${origin}/api/headless/custom-tools/rpc`,
  }
}

async function serveUiFile(req: Request, res: Response, tool: CustomToolDefinition, filePath: string): Promise<void> {
  const contentType = getContentType(filePath)

  if (contentType.startsWith('text/html')) {
    const rawHtml = await fs.readFile(filePath, 'utf-8')
    const html = rawHtml.replace(/\{\{CONFIG\}\}/g, JSON.stringify(buildUiConfig(req, tool)))
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
    return
  }

  const content = await fs.readFile(filePath)
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).send(content)
}

async function handleServeCustomToolUi(req: Request, res: Response, requestedSubPath?: string): Promise<void> {
  const name = String(req.params.name || '').trim()
  if (!name) {
    res.status(400).json({ success: false, error: 'Tool name required' })
    return
  }

  const tool = await getCustomTool(name)
  if (!tool) {
    res.status(404).json({ success: false, error: 'Custom tool not found' })
    return
  }

  const entryPath = await resolveUiEntry(tool)
  if (!entryPath) {
    res.status(404).json({ success: false, error: 'Custom tool has no UI entry' })
    return
  }

  const basePath = getToolUiBasePath(tool, entryPath)
  const normalizedRequested = String(requestedSubPath || '').replace(/^\/+/, '')
  const targetPath = normalizedRequested ? path.resolve(basePath, normalizedRequested) : entryPath

  if (!isWithin(basePath, targetPath)) {
    res.status(403).json({ success: false, error: 'Path traversal denied' })
    return
  }

  try {
    const stat = await fs.stat(targetPath)
    if (!stat.isFile()) {
      res.status(404).json({ success: false, error: 'Asset not found' })
      return
    }
    await serveUiFile(req, res, tool, targetPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Asset not found' })
      return
    }
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function registerCustomToolsRoutes(app: Express): void {
  app.get('/api/headless/custom-tools', async (_req, res) => {
    try {
      const result = await executeCustomToolManager({ action: 'list' }, {})
      if (!result?.success) {
        res.status(500).json({ success: false, error: result?.error || 'Failed to list custom tools' })
        return
      }

      const tools = Array.isArray(result.tools)
        ? result.tools.map((tool: any) => ({
            ...tool,
            ui: tool?.ui,
          }))
        : []
      res.json({
        success: true,
        tools,
        totalCount: Number(result.totalCount || 0),
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/headless/custom-tools/:name/app', async (req, res) => {
    const name = String(req.params.name || '').trim()
    if (!name) {
      res.status(400).json({ success: false, error: 'Tool name required' })
      return
    }

    try {
      const tool = await getCustomTool(name)
      if (!tool) {
        res.status(404).json({ success: false, error: 'Custom tool not found' })
        return
      }

      const entryPath = await resolveUiEntry(tool)
      if (!entryPath) {
        res.status(404).json({ success: false, error: 'Custom tool has no UI entry' })
        return
      }

      const origin = buildRequestOrigin(req)
      const entryFile = path.basename(entryPath)
      res.json({
        success: true,
        tool: {
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          sourcePath: tool.sourcePath,
        },
        hasUi: true,
        entryFile,
        legacy: entryFile.toLowerCase() === 'ui.html',
        entryUrl: `${origin}/api/headless/custom-tools/ui/${encodeURIComponent(tool.name)}/`,
        warnings: [
          'This custom app may rely on desktop-only capabilities. In remote/browser mode some actions may fail or behave differently.',
        ],
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/headless/custom-tools/ui/:name', async (req, res) => {
    await handleServeCustomToolUi(req, res)
  })

  app.get('/api/headless/custom-tools/ui/:name/*', async (req, res) => {
    // @types/express is ^5 while express is ^4.21.2. Express 4 exposes an unnamed
    // wildcard capture as req.params[0]; the v5 types model it as { "": string[] }.
    const wildcardParams = req.params as unknown as Record<string, string | undefined>
    await handleServeCustomToolUi(req, res, wildcardParams[0])
  })

  app.patch('/api/headless/custom-tools/:name', async (req, res) => {
    const name = String(req.params.name || '').trim()
    if (!name) {
      res.status(400).json({ success: false, error: 'Tool name required' })
      return
    }

    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled boolean required' })
      return
    }

    try {
      const result = await executeCustomToolManager({ action: enabled ? 'enable' : 'disable', name }, {})
      if (!result?.success) {
        const status = /not found/i.test(String(result?.error || '')) ? 404 : 400
        res.status(status).json({ success: false, error: result?.error || 'Failed to update custom tool state' })
        return
      }

      res.json({ success: true, tool: result.tool })
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
