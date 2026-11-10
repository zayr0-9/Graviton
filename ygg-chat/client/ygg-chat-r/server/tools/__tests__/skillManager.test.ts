import { beforeEach, describe, expect, it, vi } from 'vitest'

const { registry, loader } = vi.hoisted(() => ({
  registry: { initialize: vi.fn(), getSummaries: vi.fn() },
  loader: { getSkills: vi.fn() },
}))
vi.mock('../../skills/skillLoader.js', () => ({ skillRegistry: registry }))
vi.mock('../../context/contextSessionRegistry.js', () => ({ getConversationContext: () => loader }))
import { execute, skillManagerDefinition } from '../../skills/skillManager.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'

const discovered = (name: string, description: string, extra = {}) => ({
  name, scope: 'project', frontmatter: { name, description, ...extra },
})

describe('skill manager search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registry.getSummaries.mockReturnValue([
      { name: 'host', description: 'Database migrations', enabled: true },
      { name: 'disabled', description: 'Database', enabled: false },
      { name: 'project', description: 'Wrong fallback', enabled: true },
    ])
    loader.getSkills.mockResolvedValue([
      discovered('project', 'Database queries'),
      discovered('hidden', 'Database', { disableModelInvocation: true }),
      { ...discovered('shadowed', 'Database'), shadowed: true },
      discovered('trigger', 'Other', { whenToUse: 'database' }),
    ])
  })

  it('uses the canonical shared schema', () => {
    expect(skillManagerDefinition).toEqual(BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'skill_manager'))
  })

  it('searches merged visible summaries with pagination, not instructions', async () => {
    const result = await execute({ action: 'search', query: 'DATABASE', limit: 2 })
    expect(result).toMatchObject({ success: true, totalCount: 3, nextOffset: 2 })
    expect(result.skills?.map(skill => skill.name)).toEqual(['host', 'project'])
    expect(JSON.stringify(result)).not.toContain('instructions')
    expect((await execute({ action: 'search', query: 'database', limit: 2, offset: 2 })).skills?.map(skill => skill.name)).toEqual(['trigger'])
    expect((await execute({ action: 'search', query: 'no-match' })).totalCount).toBe(0)
  })

  it('rejects empty queries and invalid pagination', async () => {
    for (const args of [{ query: '' }, { query: 'x', offset: -1 }, { query: 'x', limit: 0 }]) {
      expect((await execute({ action: 'search', ...args })).success).toBe(false)
    }
    expect(loader.getSkills).not.toHaveBeenCalled()
  })
})
