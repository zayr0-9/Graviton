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

it('exposes the Claude bridge as a built-in on both model selectors', () => {
  for (const tools of [getToolsForAI(), getToolsForOpenAIChatGPT()]) {
    const bridge = tools.find(tool => tool.name === 'claude_bridge')
    expect(bridge).toBeDefined()
    expect(bridge?.isCustom).toBeUndefined()
    expect(bridge?.inputSchema.properties.action.enum).toEqual(expect.arrayContaining(['lookup', 'resume', 'fork', 'models']))
    expect(bridge?.inputSchema.properties).toHaveProperty('name')
    expect(bridge?.inputSchema.properties).toHaveProperty('model')
    expect(bridge?.inputSchema.properties).toHaveProperty('directory')
    expect(bridge?.inputSchema.properties.source.enum).toEqual(['all', 'bridge', 'claude'])
  }
})
