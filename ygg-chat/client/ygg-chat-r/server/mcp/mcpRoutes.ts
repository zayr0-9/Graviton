// server/mcp/mcpRoutes.ts
// Express routes for MCP server management

import { Express } from 'express'
import { attachChatErrorCode } from '../headlessServer/providers/providerErrorFormatter.js'
import { toolOrchestrator } from '../tools/orchestrator/index.js'
import { mcpManager, McpServerConfig, type McpOAuthConfig } from './mcpManager.js'
import { toMcpExecutionResult } from './mcpToolResult.js'

// Helper function to refresh MCP tools with the orchestrator
async function refreshMcpToolsWithOrchestrator(): Promise<number> {
  const mcpTools = mcpManager.getAllTools()
  let registeredCount = 0

  for (const mcpTool of mcpTools) {
    const qualifiedName = mcpTool.qualifiedName || mcpTool.name

    // Check if already registered (orchestrator might have a method for this)
    // For now, just register (re-registration should be idempotent)
    toolOrchestrator.registerTool(qualifiedName, async (args, _options) => {
      try {
        // A tool-level failure reported BY a reachable MCP server (isError: true) is a
        // legitimate, model-visible result and still resolves.
        const mcpResult = await mcpManager.callTool(qualifiedName, args)
        return toMcpExecutionResult(mcpResult)
      } catch (error) {
        // MUST rethrow — see the identical registration in localServer.ts. Resolving with
        // { success: false } made the orchestrator mark the job COMPLETE, so MCP transport
        // failures reached the model and the UI as successful results with is_error: false.
        console.error(`[McpRoutes] MCP tool execution error (${qualifiedName}):`, error)
        throw attachChatErrorCode(error instanceof Error ? error : new Error(String(error)), 'mcp_unavailable')
      }
    })
    registeredCount++
  }

  // console.log(`[McpRoutes] Refreshed ${registeredCount} MCP tools with orchestrator`)
  return registeredCount
}

function parseOAuthConfig(raw: unknown): McpOAuthConfig | undefined {
  if (raw === undefined) return undefined

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('"oauth" must be an object')
  }

  const source = raw as Record<string, unknown>
  const asString = (key: string): string | undefined => {
    const value = source[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') {
      throw new Error(`"oauth.${key}" must be a string`)
    }
    return value
  }

  const asNumber = (key: string): number | undefined => {
    const value = source[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`"oauth.${key}" must be a number`)
    }
    return value
  }

  const scopesRaw = source.scopes
  let scopes: string[] | undefined
  if (scopesRaw !== undefined && scopesRaw !== null) {
    if (!Array.isArray(scopesRaw) || scopesRaw.some(item => typeof item !== 'string')) {
      throw new Error('"oauth.scopes" must be an array of strings')
    }
    scopes = scopesRaw.map(scope => scope.trim()).filter(Boolean)
  }

  const clientModeRaw = source.clientMode
  let clientMode: 'configured' | 'dynamic' | undefined
  if (clientModeRaw !== undefined && clientModeRaw !== null && clientModeRaw !== '') {
    if (clientModeRaw !== 'configured' && clientModeRaw !== 'dynamic') {
      throw new Error('"oauth.clientMode" must be "configured" or "dynamic"')
    }
    clientMode = clientModeRaw
  }

  const tokenEndpointAuthMethodRaw = source.tokenEndpointAuthMethod
  let tokenEndpointAuthMethod: 'client_secret_post' | 'none' | undefined
  if (tokenEndpointAuthMethodRaw !== undefined && tokenEndpointAuthMethodRaw !== null && tokenEndpointAuthMethodRaw !== '') {
    if (tokenEndpointAuthMethodRaw !== 'client_secret_post' && tokenEndpointAuthMethodRaw !== 'none') {
      throw new Error('"oauth.tokenEndpointAuthMethod" must be "client_secret_post" or "none"')
    }
    tokenEndpointAuthMethod = tokenEndpointAuthMethodRaw
  }

  return {
    resourceMetadataUrl: asString('resourceMetadataUrl'),
    resource: asString('resource'),
    authorizationServer: asString('authorizationServer'),
    authorizationEndpoint: asString('authorizationEndpoint'),
    tokenEndpoint: asString('tokenEndpoint'),
    registrationEndpoint: asString('registrationEndpoint'),
    scopes,
    clientId: asString('clientId'),
    clientSecret: asString('clientSecret'),
    tokenEndpointAuthMethod,
    clientMode,
    registeredRedirectUri: asString('registeredRedirectUri'),
    accessToken: asString('accessToken'),
    refreshToken: asString('refreshToken'),
    expiresAt: asNumber('expiresAt'),
  }
}

function sanitizeOAuthForResponse(oauth: McpOAuthConfig | undefined): Record<string, unknown> | undefined {
  if (!oauth) return undefined

  return {
    authorizationServer: oauth.authorizationServer,
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    tokenEndpoint: oauth.tokenEndpoint,
    registrationEndpoint: oauth.registrationEndpoint,
    scopes: oauth.scopes,
    clientId: oauth.clientId,
    tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
    clientMode: oauth.clientMode,
    registeredRedirectUri: oauth.registeredRedirectUri,
    hasClientId: Boolean(oauth.clientId),
    hasClientSecret: Boolean(oauth.clientSecret),
    hasAccessToken: Boolean(oauth.accessToken),
    hasRefreshToken: Boolean(oauth.refreshToken),
    expiresAt: oauth.expiresAt,
  }
}

export function registerMcpRoutes(app: Express): void {
  // GET /api/mcp/settings - Get MCP settings
  app.get('/api/mcp/settings', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const settings = mcpManager.getSettings()
      res.json({ success: true, settings })
    } catch (error) {
      console.error('[McpRoutes] Error getting settings:', error)
      res.status(500).json({ success: false, error: 'Failed to get MCP settings' })
    }
  })

  // PUT /api/mcp/settings - Update MCP settings
  app.put('/api/mcp/settings', async (req, res) => {
    try {
      await mcpManager.initialize()
      const updates = req.body || {}
      const settings = await mcpManager.updateSettings({ lazyStart: updates.lazyStart })
      res.json({ success: true, settings })
    } catch (error) {
      console.error('[McpRoutes] Error updating settings:', error)
      res.status(500).json({ success: false, error: 'Failed to update MCP settings' })
    }
  })

  // GET /api/mcp/status - Get status of all MCP servers
  app.get('/api/mcp/status', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const status = mcpManager.getStatus()
      res.json({
        success: true,
        servers: status,
        totalConnected: status.filter(s => s.status === 'connected').length,
      })
    } catch (error) {
      console.error('[McpRoutes] Error getting status:', error)
      res.status(500).json({ success: false, error: 'Failed to get MCP status' })
    }
  })

  // GET /api/mcp/servers - List all configured MCP servers
  app.get('/api/mcp/servers', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const configs = await mcpManager.getConfigs()
      const status = mcpManager.getStatus()

      // Merge config with status (sanitize secrets)
      const servers = configs.map(config => {
        const serverStatus = status.find(s => s.name === config.name)

        const sanitizedHeaders = config.headers
          ? Object.fromEntries(Object.keys(config.headers).map(key => [key, '<redacted>']))
          : undefined

        const oauth = sanitizeOAuthForResponse(config.oauth)

        return {
          ...config,
          headers: sanitizedHeaders,
          oauth,
          status: serverStatus?.status || 'disconnected',
          error: serverStatus?.error,
          toolCount: serverStatus?.tools.length || 0,
          resourceCount: serverStatus?.resources.length || 0,
          promptCount: serverStatus?.prompts.length || 0,
        }
      })

      res.json({ success: true, servers })
    } catch (error) {
      console.error('[McpRoutes] Error listing servers:', error)
      res.status(500).json({ success: false, error: 'Failed to list MCP servers' })
    }
  })

  // GET /api/mcp/servers/:name - Get status of specific server
  app.get('/api/mcp/servers/:name', async (req, res) => {
    try {
      await mcpManager.initialize()
      const status = mcpManager.getServerStatus(req.params.name)

      if (!status) {
        res.status(404).json({ success: false, error: 'Server not found' })
        return
      }

      res.json({ success: true, server: status })
    } catch (error) {
      console.error('[McpRoutes] Error getting server status:', error)
      res.status(500).json({ success: false, error: 'Failed to get server status' })
    }
  })

  // POST /api/mcp/servers - Add a new MCP server
  app.post('/api/mcp/servers', async (req, res) => {
    try {
      await mcpManager.initialize()
      const { name, command, args, env, stdioFraming, enabled, autoStart, url, headers, transport, type, oauth } = req.body

      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "name" in request body' })
        return
      }

      // Validate name format (lowercase, alphanumeric, hyphens)
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        res.status(400).json({ success: false, error: 'Server name must be lowercase alphanumeric with hyphens' })
        return
      }

      const resolvedTransport: 'stdio' | 'http' =
        transport === 'http' || type === 'http' || (typeof url === 'string' && url.trim().length > 0) ? 'http' : 'stdio'

      if (resolvedTransport === 'http') {
        if (!url || typeof url !== 'string') {
          res.status(400).json({ success: false, error: 'Missing "url" in request body for HTTP MCP server' })
          return
        }

        try {
          new URL(url)
        } catch {
          res.status(400).json({ success: false, error: '"url" must be a valid URL' })
          return
        }
      } else {
        if (!command || typeof command !== 'string') {
          res.status(400).json({ success: false, error: 'Missing "command" in request body for stdio MCP server' })
          return
        }

        if (args !== undefined && !Array.isArray(args)) {
          res.status(400).json({ success: false, error: '"args" must be an array' })
          return
        }
      }

      if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
        res.status(400).json({ success: false, error: '"env" must be an object' })
        return
      }

      if (stdioFraming !== undefined && stdioFraming !== 'content-length' && stdioFraming !== 'newline-json') {
        res.status(400).json({ success: false, error: '"stdioFraming" must be "content-length" or "newline-json"' })
        return
      }

      if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
        res.status(400).json({ success: false, error: '"headers" must be an object' })
        return
      }

      const parsedOAuth = parseOAuthConfig(oauth)

      const config: McpServerConfig = {
        name,
        enabled: enabled !== false,
        autoStart: autoStart !== false,
        transport: resolvedTransport,
        type: resolvedTransport,
        command: typeof command === 'string' ? command : undefined,
        args: Array.isArray(args) ? args : [],
        env: env || undefined,
        stdioFraming: stdioFraming === 'content-length' || stdioFraming === 'newline-json' ? stdioFraming : undefined,
        url: typeof url === 'string' ? url : undefined,
        headers: headers || undefined,
        oauth: parsedOAuth,
      }

      await mcpManager.addServer(config)

      // Refresh MCP tools with orchestrator after server is added (and auto-started)
      const toolCount = await refreshMcpToolsWithOrchestrator()
      res.json({ success: true, message: `Server '${name}' added`, toolsRegistered: toolCount })
    } catch (error) {
      console.error('[McpRoutes] Error adding server:', error)
      const message = error instanceof Error ? error.message : 'Failed to add MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // PUT /api/mcp/servers/:name - Update an MCP server config
  app.put('/api/mcp/servers/:name', async (req, res) => {
    try {
      await mcpManager.initialize()
      const { command, args, env, stdioFraming, enabled, autoStart, url, headers, transport, type, oauth } = req.body

      if (args !== undefined && !Array.isArray(args)) {
        res.status(400).json({ success: false, error: '"args" must be an array' })
        return
      }

      if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
        res.status(400).json({ success: false, error: '"env" must be an object' })
        return
      }

      if (stdioFraming !== undefined && stdioFraming !== 'content-length' && stdioFraming !== 'newline-json') {
        res.status(400).json({ success: false, error: '"stdioFraming" must be "content-length" or "newline-json"' })
        return
      }

      if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
        res.status(400).json({ success: false, error: '"headers" must be an object' })
        return
      }

      if (url !== undefined && typeof url !== 'string') {
        res.status(400).json({ success: false, error: '"url" must be a string' })
        return
      }

      if (transport !== undefined && transport !== 'stdio' && transport !== 'http') {
        res.status(400).json({ success: false, error: '"transport" must be "stdio" or "http"' })
        return
      }

      if (type !== undefined && type !== 'stdio' && type !== 'http') {
        res.status(400).json({ success: false, error: '"type" must be "stdio" or "http"' })
        return
      }

      const parsedOAuth = parseOAuthConfig(oauth)

      const updates: Partial<McpServerConfig> = {}
      if (command !== undefined) updates.command = command
      if (args !== undefined) updates.args = args
      if (env !== undefined) updates.env = env
      if (stdioFraming !== undefined) updates.stdioFraming = stdioFraming
      if (enabled !== undefined) updates.enabled = enabled
      if (autoStart !== undefined) updates.autoStart = autoStart
      if (url !== undefined) updates.url = url
      if (headers !== undefined) updates.headers = headers
      if (transport !== undefined) updates.transport = transport
      if (type !== undefined) updates.type = type
      if (oauth !== undefined) updates.oauth = parsedOAuth

      await mcpManager.updateServer(req.params.name, updates)

      res.json({ success: true, message: `Server '${req.params.name}' updated` })
    } catch (error) {
      console.error('[McpRoutes] Error updating server:', error)
      const message = error instanceof Error ? error.message : 'Failed to update MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // DELETE /api/mcp/servers/:name - Remove an MCP server
  app.delete('/api/mcp/servers/:name', async (req, res) => {
    try {
      await mcpManager.initialize()
      await mcpManager.removeServer(req.params.name)
      res.json({ success: true, message: `Server '${req.params.name}' removed` })
    } catch (error) {
      console.error('[McpRoutes] Error removing server:', error)
      const message = error instanceof Error ? error.message : 'Failed to remove MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // POST /api/mcp/servers/:name/start - Start an MCP server
  app.post('/api/mcp/servers/:name/start', async (req, res) => {
    try {
      await mcpManager.initialize()
      const configs = await mcpManager.getConfigs()
      const config = configs.find(c => c.name === req.params.name)

      if (!config) {
        res.status(404).json({ success: false, error: 'Server not found' })
        return
      }

      await mcpManager.startServer(config)
      // Refresh MCP tools with orchestrator after server starts
      const toolCount = await refreshMcpToolsWithOrchestrator()
      res.json({ success: true, message: `Server '${req.params.name}' started`, toolsRegistered: toolCount })
    } catch (error) {
      console.error('[McpRoutes] Error starting server:', error)
      const message = error instanceof Error ? error.message : 'Failed to start MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // POST /api/mcp/servers/:name/stop - Stop an MCP server
  app.post('/api/mcp/servers/:name/stop', async (req, res) => {
    try {
      await mcpManager.initialize()
      await mcpManager.stopServer(req.params.name)
      res.json({ success: true, message: `Server '${req.params.name}' stopped` })
    } catch (error) {
      console.error('[McpRoutes] Error stopping server:', error)
      const message = error instanceof Error ? error.message : 'Failed to stop MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // POST /api/mcp/servers/:name/restart - Restart an MCP server
  app.post('/api/mcp/servers/:name/restart', async (req, res) => {
    try {
      await mcpManager.initialize()
      await mcpManager.restartServer(req.params.name)
      res.json({ success: true, message: `Server '${req.params.name}' restarted` })
    } catch (error) {
      console.error('[McpRoutes] Error restarting server:', error)
      const message = error instanceof Error ? error.message : 'Failed to restart MCP server'
      res.status(400).json({ success: false, error: message })
    }
  })

  // ============================================================================
  // Tool routes
  // ============================================================================

  // GET /api/mcp/tools - Get all tools from connected MCP servers
  app.get('/api/mcp/tools', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const tools = mcpManager.getAllTools()
      res.json({
        success: true,
        tools,
        totalCount: tools.length,
      })
    } catch (error) {
      console.error('[McpRoutes] Error getting tools:', error)
      res.status(500).json({ success: false, error: 'Failed to get MCP tools' })
    }
  })

  // POST /api/mcp/tools/call - Call an MCP tool
  app.post('/api/mcp/tools/call', async (req, res) => {
    try {
      await mcpManager.initialize()
      const { name, arguments: args } = req.body

      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "name" in request body' })
        return
      }

      const result = await mcpManager.callTool(name, args || {})

      res.json({
        success: true,
        result,
      })
    } catch (error) {
      console.error('[McpRoutes] Error calling tool:', error)
      const message = error instanceof Error ? error.message : 'Failed to call MCP tool'
      res.status(400).json({ success: false, error: message })
    }
  })

  // ============================================================================
  // Resource routes
  // ============================================================================

  // GET /api/mcp/resources - Get all resources from connected MCP servers
  app.get('/api/mcp/resources', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const resources = mcpManager.getAllResources()
      res.json({
        success: true,
        resources,
        totalCount: resources.length,
      })
    } catch (error) {
      console.error('[McpRoutes] Error getting resources:', error)
      res.status(500).json({ success: false, error: 'Failed to get MCP resources' })
    }
  })

  // POST /api/mcp/resources/read - Read an MCP resource
  app.post('/api/mcp/resources/read', async (req, res) => {
    try {
      await mcpManager.initialize()
      const { serverName, uri } = req.body

      if (!serverName || !uri) {
        res.status(400).json({ success: false, error: 'Missing "serverName" or "uri" in request body' })
        return
      }

      const result = await mcpManager.readResource(serverName, uri)

      res.json({
        success: true,
        result,
      })
    } catch (error) {
      console.error('[McpRoutes] Error reading resource:', error)
      const message = error instanceof Error ? error.message : 'Failed to read MCP resource'
      res.status(400).json({ success: false, error: message })
    }
  })

  // ============================================================================
  // Prompt routes
  // ============================================================================

  // GET /api/mcp/prompts - Get all prompts from connected MCP servers
  app.get('/api/mcp/prompts', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const prompts = mcpManager.getAllPrompts()
      res.json({
        success: true,
        prompts,
        totalCount: prompts.length,
      })
    } catch (error) {
      console.error('[McpRoutes] Error getting prompts:', error)
      res.status(500).json({ success: false, error: 'Failed to get MCP prompts' })
    }
  })

  // POST /api/mcp/prompts/get - Get a specific prompt with arguments
  app.post('/api/mcp/prompts/get', async (req, res) => {
    try {
      await mcpManager.initialize()
      const { serverName, name, arguments: args } = req.body

      if (!serverName || !name) {
        res.status(400).json({ success: false, error: 'Missing "serverName" or "name" in request body' })
        return
      }

      const result = await mcpManager.getPrompt(serverName, name, args)

      res.json({
        success: true,
        result,
      })
    } catch (error) {
      console.error('[McpRoutes] Error getting prompt:', error)
      const message = error instanceof Error ? error.message : 'Failed to get MCP prompt'
      res.status(400).json({ success: false, error: message })
    }
  })

  // ============================================================================
  // Config path
  // ============================================================================

  // GET /api/mcp/config-path - Get the MCP config file path
  app.get('/api/mcp/config-path', async (_req, res) => {
    try {
      const configPath = mcpManager.getConfigPath()
      res.json({ success: true, configPath })
    } catch (error) {
      console.error('[McpRoutes] Error getting config path:', error)
      res.status(500).json({ success: false, error: 'Failed to get config path' })
    }
  })

  // POST /api/mcp/refresh-tools - Refresh MCP tools with the orchestrator
  app.post('/api/mcp/refresh-tools', async (_req, res) => {
    try {
      await mcpManager.initialize()
      const toolCount = await refreshMcpToolsWithOrchestrator()
      res.json({ success: true, message: `Registered ${toolCount} MCP tools with orchestrator`, toolCount })
    } catch (error) {
      console.error('[McpRoutes] Error refreshing tools:', error)
      res.status(500).json({ success: false, error: 'Failed to refresh MCP tools' })
    }
  })

  console.log('[McpRoutes] Registered MCP routes')
}
