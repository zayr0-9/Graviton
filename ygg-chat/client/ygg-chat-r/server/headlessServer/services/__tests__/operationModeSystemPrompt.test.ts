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

    expect(prompt).toContain('Agent Prompt: Chat and Agent modes')
    expect(prompt).toContain('## Plan Response Style')
    expect(prompt).toContain('Use short, concise plans')
    expect(prompt).toContain('Call `wait` once to register automatic completion delivery')
    expect(prompt).toContain('Chat mode (plan)')
  })

  it('adds selected Plan response verbosity', () => {
    const prompt = buildOperationModeSystemPrompt({
      operationMode: 'plan',
      includeCustomToolsPrompt: false,
      planModeVerbosity: 'detailed',
    })

    expect(prompt).toContain('Use detailed plans when helpful')
  })

  it('keeps a stable prompt including conditional response style in Agent Mode', () => {
    const prompt = buildOperationModeSystemPrompt({ operationMode: 'execute', includeCustomToolsPrompt: false })

    expect(prompt).toContain('Agent Prompt: Chat and Agent modes')
    expect(prompt).toContain('Call `wait` once to register automatic completion delivery')
    expect(prompt).toContain('## Plan Response Style (only while Chat mode is active)')
    expect(prompt).toBe(buildOperationModeSystemPrompt({ operationMode: 'plan', includeCustomToolsPrompt: false }))
  })
})

describe('web research delegation guidance', () => {
  it('requires automatic delegation for online lookups in both modes', () => {
    for (const operationMode of ['plan', 'execute'] as const) {
      const prompt = buildOperationModeSystemPrompt({ operationMode, includeCustomToolsPrompt: false })

      expect(prompt).toContain('### Web search and online research')
      expect(prompt).toContain('always delegate the online research to a subagent before using web/search tools')
      expect(prompt).toContain('the user does not need to request subagents explicitly')
      expect(prompt).toContain('even to a single quick lookup')
      expect(prompt).toContain('takes precedence over guidance to handle small tasks directly')
      expect(prompt).toContain('Keep raw search results and page contents out of the main conversation')
      expect(prompt).toContain('source URLs, supporting evidence')
      expect(prompt).toContain('delegates follow-up browsing')
      expect(prompt).toContain('explain the limitation instead of silently bypassing delegation')
      expect(prompt).toContain('they must not attempt nested delegation')
    }
  })
})

describe('shared REPL collaboration guidance', () => {
  it('includes reusable context-first delegation and selective persistence in both modes', () => {
    for (const operationMode of ['plan', 'execute'] as const) {
      const prompt = buildOperationModeSystemPrompt({ operationMode, includeCustomToolsPrompt: false })

      expect(prompt).toContain('shared collaboration workspace')
      expect(prompt).toContain('#### Context-first delegation')
      expect(prompt).toContain('prepare or reuse a named general task-context variable')
      expect(prompt).toContain("contextVariable: 'taskContext'")
      expect(prompt).toContain("outputVariable: 'reviewFindings'")
      expect(prompt).toContain('Reuse the general context for later delegates')
      expect(prompt).toContain('include `repl` along with the other tools')
      expect(prompt).toContain('direct HTTP subagents have private workspaces')
      expect(prompt).toContain('include the relevant context in its prompt instead')
      expect(prompt).toContain('expired after 30 minutes idle')
      expect(prompt).toContain('"action":"export","variable":"taskContext"')
      expect(prompt).toContain('"action":"import"')
      expect(prompt).toContain('Export requires Agent mode')
      expect(prompt).toContain('Record the artifact path in the handoff')
      expect(prompt).toContain('revalidate stale assumptions')
      expect(prompt).toContain('Artifacts are plaintext')
    }
  })

  it('guides delegates to consume shared context and return reusable findings safely', () => {
    const prompt = getDefaultSubagentModePrompt().prompt

    expect(prompt).toContain('read the caller-named general task context plus your focused assignment')
    expect(prompt).toContain('do not work from the assignment alone')
    expect(prompt).toContain('Direct HTTP agents have private workspaces')
    expect(prompt).toContain('do not overwrite or drop parent/sibling inputs without coordination')
    expect(prompt).toContain('verified context additions and decisions')
    expect(prompt).toContain('Report the output variable names')
    expect(prompt).toContain('expired after 30 minutes idle')
    expect(prompt).toContain('propose an export to the caller')
    expect(prompt).toContain('Agent mode/write approval')
    expect(prompt).toContain('Report any saved artifact path in your handoff')
    expect(prompt).toContain('exclude secrets and unnecessary private data')
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

  it('never exposes MCP definitions in either mode and allows manager invoke', () => {
    const tools = [
      { name: 'mcp_manager', enabled: true },
      { name: 'mcp__demo__echo', enabled: true },
      { name: 'unprefixed', enabled: true, isMcp: true },
    ] as ToolDefinition[]
    for (const mode of ['plan', 'execute'] as const) {
      expect(filterToolsForOperationMode(tools, mode).map(tool => tool.name)).toEqual(['mcp_manager'])
    }
    for (const name of ['mcp_manager', 'custom_tool_manager', 'skill_manager']) {
      for (const args of [{ action: 'invoke' }, JSON.stringify({ action: 'invoke' })]) {
        const call = { name, arguments: args }
        expect(requiresAgentMode(call, 'plan')).toBe(false)
        expect(() => assertToolAllowedForOperationMode(call, 'plan')).not.toThrow()
        expect(requiresAgentMode(call, 'execute')).toBe(false)
      }
    }
    expect(requiresAgentMode({ name: 'mcp_manager', arguments: { action: 'list_tools' } }, 'plan')).toBe(false)
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

  it('preserves custom Chat and Agent sections in the same stable prompt', () => {
    storage.set('ygg_operation_mode_prompt_settings', JSON.stringify({
      selectedChatPromptId: 'custom', chatPrompts: [{ id: 'custom', name: 'Custom', prompt: 'Custom Chat instructions' }],
      agentModePromptOverride: 'Custom Agent instructions',
    }))
    const chat = buildOperationModeSystemPrompt({ operationMode: 'plan', includeCustomToolsPrompt: false })
    const agent = buildOperationModeSystemPrompt({ operationMode: 'execute', includeCustomToolsPrompt: false })
    expect(chat).toBe(agent)
    expect(chat).toContain('Custom Chat instructions')
    expect(chat).toContain('Custom Agent instructions')
    expect(chat).toContain('applies only while Chat mode is active')
    expect(chat).toContain('applies only while Agent mode is active')
  })

  it('treats blank overrides as resets without disturbing Chat prompt settings', async () => {
    storage.set(
      'ygg_operation_mode_prompt_settings',
      JSON.stringify({
        selectedChatPromptId: 'custom-chat',
        chatPrompts: [{ id: 'custom-chat', name: 'Custom Chat', prompt: 'Chat prompt' }],
      })
    )

    const saved = await saveAgentModePromptOverride('   ')

    expect(saved.agentModePromptOverride).toBeNull()
    expect(saved.selectedChatPromptId).toBe('custom-chat')
    expect(saved.chatPrompts).toEqual([{ id: 'custom-chat', name: 'Custom Chat', prompt: 'Chat prompt' }])
  })
})
