// server/routes/toolExecutionRoutes.ts
//
// Direct tool execution (/api/tools/execute) and custom-tool management
// (/api/custom-tools*), extracted verbatim from localServer.ts
// setupServer(). Runs built-in handlers from the shared builtInTools
// map, custom tools through customToolRegistry, and MCP tools through
// mcpManager; out-of-process execution goes through the host tool
// sandbox when the runtime policy selects it.

import type { Express } from 'express'
import type { BuiltInToolHandler } from '../builtinToolRegistry.js'
import type { ToolSandboxHost } from '../hostCapabilities.js'
import { customToolRegistry, ToolResult } from '../tools/customToolLoader.js'
import { mcpManager } from '../mcp/mcpManager.js'
import { toMcpExecutionResult } from '../mcp/mcpToolResult.js'
import { shouldUseUtilityRuntimeForTool } from '../toolSandboxPolicy.js'

export interface ToolExecutionRoutesDeps {
  builtInTools: Map<string, BuiltInToolHandler>
  getToolSandbox: () => ToolSandboxHost | null
  isUtilityRuntimeFallbackDisabled: () => boolean
  shouldUseUtilityRuntimeForCustomTool: (toolName: string) => boolean
}

export function registerToolExecutionRoutes(app: Express, deps: ToolExecutionRoutesDeps): void {
  const { builtInTools, getToolSandbox, isUtilityRuntimeFallbackDisabled, shouldUseUtilityRuntimeForCustomTool } = deps

  // Tool Execution Endpoint (uses built-in and custom tool registries)
  app.post('/api/tools/execute', async (req, res) => {
    try {
      const { toolName, args, rootPath, operationMode, conversationId, messageId, parentMessageId, streamId, toolCallId } = req.body
      const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : toolName
      // console.log(`[LocalServer] Executing tool: ${toolName} (operationMode: ${operationMode || 'execute'})`)

      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
      const toolOptions = {
        rootPath,
        operationMode: operationMode as 'plan' | 'execute' | undefined,
        conversationId: conversationId ?? null,
        messageId: messageId ?? null,
        parentMessageId: parentMessageId ?? null,
        streamId: streamId ?? null,
        toolCallId: toolCallId ?? null,
      }

      let result: ToolResult

      // Check built-in tools first
      const builtInHandler = builtInTools.get(normalizedToolName)
      const directExecSandbox = getToolSandbox()
      if (builtInHandler) {
        if (directExecSandbox && shouldUseUtilityRuntimeForTool(normalizedToolName)) {
          try {
            result = await directExecSandbox.executeTool(normalizedToolName, parsedArgs, toolOptions)
          } catch (utilityError) {
            if (isUtilityRuntimeFallbackDisabled()) {
              throw utilityError
            }
            console.warn(
              `[LocalServer] Utility runtime failed for ${normalizedToolName}; falling back to local execution:`,
              utilityError
            )
            result = await builtInHandler(parsedArgs, toolOptions)
          }
        } else {
          result = await builtInHandler(parsedArgs, toolOptions)
        }
      }
      // Then check MCP tools (format: mcp__serverName__toolName)
      else if (typeof normalizedToolName === 'string' && normalizedToolName.startsWith('mcp__')) {
        console.log(`[LocalServer] MCP tool detected: ${normalizedToolName}`)
        console.log(`[LocalServer] mcpManager exists: ${!!mcpManager}`)

        if (!mcpManager) {
          result = { success: false, error: 'MCP manager not initialized' }
        } else {
          try {
            const mcpResult = await mcpManager.callTool(normalizedToolName, parsedArgs)
            result = toMcpExecutionResult(mcpResult) as ToolResult
          } catch (mcpError) {
            console.error(`[LocalServer] MCP tool error:`, mcpError)
            result = { success: false, error: mcpError instanceof Error ? mcpError.message : String(mcpError) }
          }
        }
      }
      // Then check custom tools
      else if (customToolRegistry.hasCustomTool(normalizedToolName)) {
        if (directExecSandbox && shouldUseUtilityRuntimeForCustomTool(normalizedToolName)) {
          try {
            result = await directExecSandbox.executeTool(normalizedToolName, parsedArgs, toolOptions)
          } catch (utilityError) {
            if (isUtilityRuntimeFallbackDisabled()) {
              throw utilityError
            }
            console.warn(
              `[LocalServer] Utility runtime failed for custom tool ${normalizedToolName}; falling back to local execution:`,
              utilityError
            )
            result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
              rootPath,
              operationMode: operationMode as 'plan' | 'execute' | undefined,
              conversationId: conversationId ?? null,
              messageId: messageId ?? null,
              streamId: streamId ?? null,
              cwd: rootPath,
            })
          }
        } else {
          result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
            rootPath,
            operationMode: operationMode as 'plan' | 'execute' | undefined,
            conversationId: conversationId ?? null,
            messageId: messageId ?? null,
            streamId: streamId ?? null,
            cwd: rootPath,
          })
        }
      }
      // Unknown tool
      else {
        console.warn(`[LocalServer] Unknown tool: ${normalizedToolName}`)
        result = { success: false, error: `Unknown tool: ${normalizedToolName}` }
      }

      res.json({ result })
    } catch (error) {
      console.error('[LocalServer] Tool execution error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.json({ result: { success: false, error: msg } })
    }
  })

  // Custom Tools API Endpoints

  // GET /api/custom-tools - List all custom tool definitions
  app.get('/api/custom-tools', async (_req, res) => {
    try {
      const definitions = customToolRegistry.getDefinitions()
      const statuses = customToolRegistry.getStatuses()
      // const tools = definitions.map(tool => ({ ...tool, ui: tool.ui }))
      // redundant gpt things 
      res.json({ success: true, tools: definitions, statuses, settings: customToolRegistry.getSettings() })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools:', error)
      res.status(500).json({ success: false, error: 'Failed to get custom tools' })
    }
  })

  // GET /api/custom-tools/directory - Get custom tools directory path
  app.get('/api/custom-tools/directory', (_req, res) => {
    try {
      const directory = customToolRegistry.getCustomToolsDirectoryPath()
      res.json({ success: true, directory })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools directory:', error)
      res.status(500).json({ success: false, error: 'Failed to get directory' })
    }
  })

  // GET /api/custom-tools/settings - Get custom tools lifecycle settings
  app.get('/api/custom-tools/settings', (_req, res) => {
    try {
      res.json({ success: true, settings: customToolRegistry.getSettings() })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools settings:', error)
      res.status(500).json({ success: false, error: 'Failed to get custom tools settings' })
    }
  })

  // PUT /api/custom-tools/settings - Update custom tools lifecycle settings
  app.put('/api/custom-tools/settings', async (req, res) => {
    try {
      const updates = req.body || {}
      const settings = await customToolRegistry.updateSettings({
        autoRefresh: updates.autoRefresh,
        refreshDebounceMs: updates.refreshDebounceMs,
      })
      res.json({ success: true, settings })
    } catch (error) {
      console.error('[LocalServer] Error updating custom tools settings:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // PATCH /api/custom-tools/:name - Enable/disable a custom tool
  app.patch('/api/custom-tools/:name', async (req, res) => {
    try {
      const { enabled } = req.body || {}
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled boolean is required' })
        return
      }

      const updated = await customToolRegistry.setToolEnabled(req.params.name, enabled)
      if (!updated) {
        res.status(404).json({ success: false, error: `Custom tool "${req.params.name}" not found` })
        return
      }

      res.json({ success: true, tool: updated })
    } catch (error) {
      console.error('[LocalServer] Error updating custom tool enabled state:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/custom-tools/add - Add a custom tool directory into managed tools
  app.post('/api/custom-tools/add', async (req, res) => {
    try {
      const { sourcePath, directoryName, overwrite } = req.body || {}
      if (!sourcePath || typeof sourcePath !== 'string') {
        res.status(400).json({ success: false, error: 'sourcePath is required' })
        return
      }

      const added = await customToolRegistry.addToolFromDirectory(sourcePath, {
        directoryName: typeof directoryName === 'string' ? directoryName : undefined,
        overwrite: overwrite === true,
      })
      res.json({ success: true, ...added })
    } catch (error) {
      console.error('[LocalServer] Error adding custom tool:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // DELETE /api/custom-tools/:name - Remove custom tool by name or directory
  app.delete('/api/custom-tools/:name', async (req, res) => {
    try {
      const removed = await customToolRegistry.removeTool(req.params.name)
      res.json({ success: true, ...removed })
    } catch (error) {
      console.error('[LocalServer] Error removing custom tool:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // POST /api/custom-tools/reload - Reload all custom tools from disk
  app.post('/api/custom-tools/reload', async (_req, res) => {
    try {
      await customToolRegistry.reload('api_reload')
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        tools: definitions,
        statuses: customToolRegistry.getStatuses(),
        settings: customToolRegistry.getSettings(),
        message: `Reloaded ${definitions.length} custom tools`,
      })
    } catch (error) {
      console.error('[LocalServer] Error reloading custom tools:', error)
      res.status(500).json({ success: false, error: 'Failed to reload custom tools' })
    }
  })
}
