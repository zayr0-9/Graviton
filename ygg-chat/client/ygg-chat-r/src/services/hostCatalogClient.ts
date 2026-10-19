import { buildLocalApiUrl } from '../utils/api'
import { getAllTools, setCustomTools, setMcpTools } from '../features/chats/toolDefinitions'
export const HOST_SKILLS_CHANGED = 'graviton:host-skills-changed'
/** GET-only observer: never connects MCP, refreshes registrations or executes a tool. */
export function startHostCatalogRefresh(onTools: (tools: ReturnType<typeof getAllTools>) => void): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const signatures = new Map<string, string>()
  const read = async (path: string) => {
    const response = await fetch(await buildLocalApiUrl(path), { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error('Catalog unavailable')
    return response.json()
  }
  const changed = (key: string, value: unknown): boolean => {
    const signature = JSON.stringify(value)
    if (signatures.get(key) === signature) return false
    signatures.set(key, signature); return true
  }
  const poll = async () => {
    await Promise.allSettled([
      read('/custom-tools').then(data => {
        if (controller.signal.aborted || !data.success || !Array.isArray(data.tools) || !changed('custom', data.tools)) return
        setCustomTools(data.tools); onTools(getAllTools())
      }),
      read('/mcp/tools').then(data => {
        if (controller.signal.aborted || !data.success || !Array.isArray(data.tools) || !changed('mcp', data.tools)) return
        setMcpTools(data.tools.map((tool: any) => {
          const ui = tool?._meta?.ui || (tool?._meta?.['ui/resourceUri'] ? { resourceUri: tool._meta['ui/resourceUri'] } : undefined)
          const visibility = Array.isArray(ui?.visibility) ? ui.visibility : ['model', 'app']
          return { name: tool.qualifiedName || tool.name, description: tool.description || '', enabled: visibility.includes('model'), inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            isMcp: true, mcpServerName: tool.serverName, mcpToolName: tool.name, mcpUi: ui ? { resourceUri: ui.resourceUri, visibility } : undefined }
        })); onTools(getAllTools())
      }),
      read('/skills').then(data => {
        if (controller.signal.aborted || !data.success || !Array.isArray(data.skills) || !changed('skills', data.skills)) return
        window.dispatchEvent(new CustomEvent(HOST_SKILLS_CHANGED, { detail: data.skills }))
      }),
    ])
    if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
  }
  timer = setTimeout(poll, 5000)
  return () => { controller.abort(); clearTimeout(timer) }
}
