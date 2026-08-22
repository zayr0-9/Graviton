import type { Express, Request } from 'express'
import { customToolRegistry } from '../../tools/customToolLoader.js'

interface RegisterCapabilityRoutesDeps {
  getDefaultTools: () => Array<{ name: string; description?: string }>
}

const shouldIncludeCustomTools = (req: Request): boolean => {
  const raw = req.query?.includeCustomTools
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value == null) return true
  return !['0', 'false', 'no'].includes(String(value).trim().toLowerCase())
}

const resolveCustomToolNameSet = (): Set<string> => {
  try {
    return new Set(customToolRegistry.getDefinitions().map(def => def.name))
  } catch {
    return new Set()
  }
}

export function registerCapabilityRoutes(app: Express, deps: RegisterCapabilityRoutesDeps): void {
  const buildPayload = (includeCustomTools: boolean) => {
    const customToolNames = includeCustomTools ? new Set<string>() : resolveCustomToolNameSet()
    const tools = deps
      .getDefaultTools()
      .filter(tool => tool?.name && (includeCustomTools || !customToolNames.has(tool.name)))
      .map(tool => ({ name: tool.name, description: tool.description || '' }))

    return {
      success: true,
      apiVersion: 'v1',
      chat: {
        operations: ['send', 'repeat', 'branch', 'edit-branch'],
        sseEvents: [
          'started',
          'user_message_persisted',
          'provider_routed',
          'tool_loop',
          'tool_execution',
          'chunk:text',
          'chunk:reasoning',
          'chunk:tool_call',
          'chunk:tool_result',
          'assistant_message_persisted',
          'complete',
          'error',
        ],
        routes: {
          send: '/api/conversations/:id/messages',
          repeat: '/api/conversations/:id/messages/repeat',
          branch: '/api/conversations/:id/messages/:messageId/branch',
          editBranch: '/api/conversations/:id/messages/:messageId/edit-branch',
        },
      },
      providers: [
        { name: 'openaichatgpt', auth: 'oauth_or_token' },
        { name: 'openrouter', auth: 'app_bearer' },
        { name: 'lmstudio', auth: 'local_or_bearer' },
      ],
      tools,
    }
  }

  app.get('/api/headless/capabilities', (req, res) => {
    res.json(buildPayload(shouldIncludeCustomTools(req)))
  })

  app.get('/api/v1/capabilities', (req, res) => {
    res.json(buildPayload(shouldIncludeCustomTools(req)))
  })
}
