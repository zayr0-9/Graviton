import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../../shared/builtinToolDefinitions'

describe('subagent tool definition', () => {
  it('uses the configured default model instead of exposing a model argument', () => {
    const subagent = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'subagent')

    expect(subagent).toBeDefined()
    expect(subagent?.inputSchema.properties).not.toHaveProperty('model')
  })

  it('exposes manager wait as a handle-scoped action', () => {
    const manager = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'subagent_manager')

    expect(manager?.inputSchema.properties.action.enum).toContain('wait')
    expect(manager?.inputSchema.properties.handle.description).toContain('wait')
    expect(manager?.description).toContain('instead of repeatedly polling')
  })

  it('no longer exposes the removed resume/session arguments', () => {
    const subagent = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'subagent')

    expect(subagent?.inputSchema.properties).not.toHaveProperty('sessionId')
    expect(subagent?.inputSchema.properties).not.toHaveProperty('resume')
    // Retained arguments the thin client maps to the request contract.
    expect(subagent?.inputSchema.properties).toHaveProperty('prompt')
    expect(subagent?.inputSchema.properties).toHaveProperty('tools')
    expect(subagent?.inputSchema.properties).toHaveProperty('inheritAutoApprove')
  })
})
