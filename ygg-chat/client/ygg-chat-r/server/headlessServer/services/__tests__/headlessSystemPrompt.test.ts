import { describe, expect, it } from 'vitest'
import { buildHeadlessSystemPrompt } from '../headlessSystemPrompt.js'

describe('buildHeadlessSystemPrompt', () => {
  it('combines operation mode, request, project, and conversation prompts in renderer order', () => {
    const prompt = buildHeadlessSystemPrompt({
      operationMode: 'plan',
      requestPrompt: 'Request prompt',
      projectPrompt: 'Project prompt from sqlite',
      conversationPrompt: 'Conversation prompt from sqlite',
    })

    expect(prompt).toContain('Agent Prompt: Chat and Agent modes')
    expect(prompt).toContain('Request prompt\n\nProject prompt from sqlite\n\nConversation prompt from sqlite')
    expect(prompt.indexOf('Agent Prompt: Chat and Agent modes')).toBeLessThan(prompt.indexOf('Request prompt'))
  })

  it('uses agent mode instructions for execute mode', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'execute' })

    expect(prompt).toContain('Agent Prompt: Chat and Agent modes')
  })

  it.each(['plan', 'execute'] as const)('includes shared file-link guidance in %s mode', operationMode => {
    const prompt = buildHeadlessSystemPrompt({ operationMode })
    const guidanceIndex = prompt.indexOf('## File links for human inspection')

    expect(guidanceIndex).toBeGreaterThan(-1)
    expect(guidanceIndex).toBeLessThan(prompt.indexOf('## Chat mode (plan) — conditional'))
    expect(prompt).toContain('[report.md](file:///Users/name/project/report.md)')
    expect(prompt).toContain('[report.md](file:///C:/Users/name/project/report.md)')
    expect(prompt).toContain('Never invent a path')
    expect(prompt).toContain('Keep line numbers or symbol names outside the URL')
  })

  it('replaces the bundled operation-mode baseline with a supplied override', () => {
    const prompt = buildHeadlessSystemPrompt({
      operationMode: 'execute',
      operationModePrompt: 'Custom Agent baseline',
      projectPrompt: 'Project prompt',
    })

    expect(prompt).toContain('Custom Agent baseline')
    expect(prompt).toContain('Project prompt')
    expect(prompt).not.toContain('Agent Prompt: Chat and Agent modes')
  })

  it('keeps Plan response style when the Plan baseline is overridden', () => {
    const prompt = buildHeadlessSystemPrompt({
      operationMode: 'plan',
      operationModePrompt: 'Custom Plan baseline',
      planModeVerbosity: 'detailed',
    })

    expect(prompt).toContain('Custom Plan baseline')
    expect(prompt).toContain('## Plan Response Style')
    expect(prompt).toContain('Use detailed plans')
    expect(prompt).not.toContain('Agent Prompt: Chat and Agent modes')
  })

  it('adds Plan response style for plan mode', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'plan', planModeVerbosity: 'normal' })

    expect(prompt).toContain('## Plan Response Style')
    expect(prompt).toContain('Use a balanced plan')
  })

  it('keeps the same conditional Plan response style in both modes', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'execute' })

    expect(prompt).toContain('## Plan Response Style (only while Chat mode is active)')
    expect(prompt).toBe(buildHeadlessSystemPrompt({ operationMode: 'plan' }))
  })

  it('can disable default operation mode prompts', () => {
    const prompt = buildHeadlessSystemPrompt({
      operationMode: 'plan',
      includeOperationModePrompt: false,
      requestPrompt: 'Request prompt',
      projectPrompt: 'Project prompt from sqlite',
      conversationPrompt: 'Conversation prompt from sqlite',
    })

    expect(prompt).toBe('Request prompt\n\nProject prompt from sqlite\n\nConversation prompt from sqlite')
  })

  it('falls back to non-empty ChatGPT instructions when no prompts are present', () => {
    expect(buildHeadlessSystemPrompt({ includeOperationModePrompt: false })).toBe('You are ChatGPT.')
  })
})
