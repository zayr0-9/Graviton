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

    expect(prompt).toContain('Agent Prompt: Plan mode')
    expect(prompt).toContain('Request prompt\n\nProject prompt from sqlite\n\nConversation prompt from sqlite')
    expect(prompt.indexOf('Agent Prompt: Plan mode')).toBeLessThan(prompt.indexOf('Request prompt'))
  })

  it('uses agent mode instructions for execute mode', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'execute' })

    expect(prompt).toContain('Agent Prompt: Coding mode')
  })

  it('replaces the bundled operation-mode baseline with a supplied override', () => {
    const prompt = buildHeadlessSystemPrompt({
      operationMode: 'execute',
      operationModePrompt: 'Custom Agent baseline',
      projectPrompt: 'Project prompt',
    })

    expect(prompt).toBe('Custom Agent baseline\n\nProject prompt')
    expect(prompt).not.toContain('Agent Prompt: Coding mode')
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
    expect(prompt).not.toContain('Agent Prompt: Plan mode')
  })

  it('adds Plan response style for plan mode', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'plan', planModeVerbosity: 'normal' })

    expect(prompt).toContain('## Plan Response Style')
    expect(prompt).toContain('Use a balanced plan')
  })

  it('does not add Plan response style for execute mode', () => {
    const prompt = buildHeadlessSystemPrompt({ operationMode: 'execute' })

    expect(prompt).not.toContain('## Plan Response Style')
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
