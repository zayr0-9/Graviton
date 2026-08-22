import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAgentModePrompt,
  getDefaultAgentModePrompt,
  getDefaultSubagentModePrompt,
  getSubagentModePrompt,
  loadOperationModePromptSettings,
  resetAgentModePromptOverride,
  resetSubagentModePromptOverride,
  saveAgentModePromptOverride,
  saveSubagentModePromptOverride,
} from '../../../../src/helpers/operationModePromptStorage.js'
import { resolveSubagentSystemPrompt } from '../../../../src/features/chats/subagentClient.js'
import {
  assertToolAllowedForOperationMode,
  buildOperationModeSystemPrompt,
  filterToolsForOperationMode,
} from '../../../../src/features/chats/operationModeSystemPrompt.js'
import type { ToolDefinition } from '../../../../src/features/chats/toolDefinitions.js'
import { requiresAgentMode } from '../../../../../../shared/operationModeToolPolicy.js'

describe('buildOperationModeSystemPrompt', () => {
  it('adds concise Plan response style by default', () => {
    const prompt = buildOperationModeSystemPrompt({ operationMode: 'plan', includeCustomToolsPrompt: false })

    expect(prompt).toContain('Agent Prompt: Plan mode')
    expect(prompt).toContain('## Plan Response Style')
    expect(prompt).toContain('Use short, concise plans')
    expect(prompt).toContain('action: "wait"')
    expect(prompt).toContain('instead of repeatedly polling `status`')
  })

  it('adds selected Plan response verbosity', () => {
    const prompt = buildOperationModeSystemPrompt({
      operationMode: 'plan',
      includeCustomToolsPrompt: false,
      planModeVerbosity: 'detailed',
    })

    expect(prompt).toContain('Use detailed plans when helpful')
  })

  it('does not add Plan response style in Agent Mode', () => {
    const prompt = buildOperationModeSystemPrompt({ operationMode: 'execute', includeCustomToolsPrompt: false })

    expect(prompt).toContain('Agent Prompt: Coding mode')
    expect(prompt).toContain('action: "wait"')
    expect(prompt).toContain('do not repeatedly poll `status`')
    expect(prompt).not.toContain('## Plan Response Style')
  })
})

describe('plan mode tool filtering', () => {
  it('exposes bash and powershell in plan mode', () => {
    const tools = [
      { name: 'bash', enabled: true },
      { name: 'powershell', enabled: true },
      { name: 'edit_file', enabled: true },
      { name: 'read_file', enabled: true },
    ] as ToolDefinition[]

    const filtered = filterToolsForOperationMode(tools, 'plan').map(tool => tool.name)

    expect(filtered).toContain('bash')
    expect(filtered).toContain('powershell')
    expect(filtered).toContain('read_file')
    // edit_file stays model-VISIBLE in plan mode by design (see the upgrade-request
    // test below). Plan mode gates it at EXECUTION time, not by hiding the schema.
    expect(filtered).toContain('edit_file')
  })

  it('allows tool-manager calls in plan mode', () => {
    for (const name of [
      'bash',
      'powershell',
      'subagent_manager',
      'custom_tool_manager',
      'mcp_manager',
      'skill_manager',
    ]) {
      expect(() => assertToolAllowedForOperationMode({ name }, 'plan')).not.toThrow()
    }
    expect(requiresAgentMode({ name: 'subagent_manager' }, 'plan')).toBe(false)
  })

  it('blocks file-mutating and mcp tools at execution time in plan mode', () => {
    // The counterpart to schema visibility: ToolLoopService calls this before every
    // tool call, so an Agent-only tool the model can SEE still cannot RUN in plan
    // mode unless requestOperationModeUpgrade resolves truthy.
    for (const name of ['create_file', 'edit_file', 'multi_edit', 'delete_file', 'mcp__server__do']) {
      expect(() => assertToolAllowedForOperationMode({ name }, 'plan')).toThrow()
    }
    // Agent mode gates nothing.
    for (const name of ['edit_file', 'mcp__server__do']) {
      expect(() => assertToolAllowedForOperationMode({ name }, 'execute')).not.toThrow()
    }
  })

  it('keeps Agent-only tools model-visible so they can request an Agent-mode upgrade', () => {
    const tools = [{ name: 'edit_file', enabled: true }, { name: 'custom_tool_manager', enabled: true }] as ToolDefinition[]
    expect(filterToolsForOperationMode(tools, 'plan').map(tool => tool.name)).toEqual(['edit_file', 'custom_tool_manager'])
  })
})

describe('operation mode prompt overrides', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes Chat-only saved settings without overrides', () => {
    storage.set(
      'ygg_operation_mode_prompt_settings',
      JSON.stringify({ selectedChatPromptId: 'default-chat-mode', chatPrompts: [] })
    )

    expect(loadOperationModePromptSettings()).toMatchObject({
      selectedChatPromptId: 'default-chat-mode',
      chatPrompts: [],
      agentModePromptOverride: null,
      subagentModePromptOverride: null,
    })
  })

  it('uses saved Agent and Subagent overrides while preserving reset fallbacks', () => {
    saveAgentModePromptOverride('  Custom Agent Base  ')
    saveSubagentModePromptOverride('  Custom Subagent Base  ')

    expect(getAgentModePrompt().prompt).toBe('Custom Agent Base')
    expect(buildOperationModeSystemPrompt({ operationMode: 'execute', includeCustomToolsPrompt: false })).toContain(
      'Custom Agent Base'
    )
    expect(getSubagentModePrompt().prompt).toBe('Custom Subagent Base')
    expect(resolveSubagentSystemPrompt('Call-specific instruction')).toBe(
      'Custom Subagent Base\n\nCall-specific instruction'
    )

    resetAgentModePromptOverride()
    resetSubagentModePromptOverride()

    expect(getAgentModePrompt().prompt).toBe(getDefaultAgentModePrompt().prompt)
    expect(getSubagentModePrompt().prompt).toBe(getDefaultSubagentModePrompt().prompt)
  })

  it('treats blank overrides as resets without disturbing Chat prompt settings', () => {
    storage.set(
      'ygg_operation_mode_prompt_settings',
      JSON.stringify({
        selectedChatPromptId: 'custom-chat',
        chatPrompts: [{ id: 'custom-chat', name: 'Custom Chat', prompt: 'Chat prompt' }],
      })
    )

    const saved = saveAgentModePromptOverride('   ')

    expect(saved.agentModePromptOverride).toBeNull()
    expect(saved.selectedChatPromptId).toBe('custom-chat')
    expect(saved.chatPrompts).toEqual([{ id: 'custom-chat', name: 'Custom Chat', prompt: 'Chat prompt' }])
  })
})
