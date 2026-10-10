import { afterEach, describe, expect, it } from 'vitest'
import { clearMcpTools, getAllTools, getToolsForAI, getToolsForOpenAIChatGPT, setMcpTools } from './toolDefinitions'

afterEach(() => clearMcpTools())

describe('manager-only MCP model exposure', () => {
  it('retains discovered tools in the UI registry but excludes their schemas from both model selectors', () => {
    setMcpTools([
      { name: 'mcp__demo__echo', enabled: true, description: 'Echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'unprefixed', enabled: true, description: 'Legacy MCP tool', inputSchema: { type: 'object', properties: {} } },
    ])
    expect(getAllTools().some(tool => tool.name === 'mcp__demo__echo')).toBe(true)
    for (const tools of [getToolsForAI(), getToolsForOpenAIChatGPT()]) {
      expect(tools.some(tool => tool.name === 'mcp_manager')).toBe(true)
      expect(tools.some(tool => tool.isMcp || tool.name.startsWith('mcp__'))).toBe(false)
    }
  })
})
