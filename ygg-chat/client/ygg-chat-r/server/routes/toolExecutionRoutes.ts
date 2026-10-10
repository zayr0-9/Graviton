// Custom-tool management (/api/custom-tools*).
// Tool execution is owned by the shared orchestrator via /api/jobs*.

import type { Express } from 'express'
import { customToolRegistry } from '../tools/customToolLoader.js'

export function registerToolExecutionRoutes(app: Express): void {

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
