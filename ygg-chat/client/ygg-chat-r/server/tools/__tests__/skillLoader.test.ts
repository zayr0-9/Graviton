import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let skillsBaseDir: string

const manifest = (name: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: Rewrite ambiguous English\n---\nApply the writing rules.\n`

describe('skillRegistry legacy-name compatibility', () => {
  beforeEach(async () => {
    vi.resetModules()
    skillsBaseDir = await mkdtemp(path.join(os.tmpdir(), 'ygg-skill-loader-'))
    // skillLoader resolves its base dir env -> host dataDir -> cwd; the env
    // override is the test seam now that the loader no longer asks Electron.
    process.env.YGG_SKILLS_DIRECTORY = skillsBaseDir
  })

  afterEach(async () => {
    delete process.env.YGG_SKILLS_DIRECTORY
    await rm(skillsBaseDir, { recursive: true, force: true })
  })

  it('loads an existing display-style manifest under a normalized activation name', async () => {
    const skillPath = path.join(skillsBaseDir, 'skills', 'Simplified Technical English (ASD-STE100)')
    await mkdir(path.join(skillPath, 'references'), { recursive: true })
    await writeFile(path.join(skillPath, 'SKILL.md'), manifest('Simplified Technical English (ASD-STE100)'), 'utf8')
    await writeFile(
      path.join(skillPath, '.skill-meta.json'),
      JSON.stringify({ installedAt: '2026-08-09T12:46:32.068Z', installedFrom: 'github:test', enabled: true }),
      'utf8'
    )

    const { skillRegistry } = await import('../../skills/skillLoader.js')
    await skillRegistry.initialize()

    expect(skillRegistry.getSummaries()).toEqual([
      {
        name: 'simplified-technical-english-asd-ste100',
        displayName: 'Simplified Technical English (ASD-STE100)',
        description: 'Rewrite ambiguous English',
        enabled: true,
      },
    ])
    expect(skillRegistry.getSkill('simplified-technical-english-asd-ste100')).toMatchObject({
      name: 'simplified-technical-english-asd-ste100',
      displayName: 'Simplified Technical English (ASD-STE100)',
      bodyContent: 'Apply the writing rules.',
      hasReferences: true,
    })
  })

  it('does not overwrite the first loaded skill when normalized names collide', async () => {
    const first = path.join(skillsBaseDir, 'skills', 'A Skill')
    const second = path.join(skillsBaseDir, 'skills', 'a-skill')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(path.join(first, 'SKILL.md'), manifest('A Skill'), 'utf8')
    await writeFile(path.join(second, 'SKILL.md'), manifest('a-skill'), 'utf8')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { skillRegistry } = await import('../../skills/skillLoader.js')
    await skillRegistry.initialize()

    expect(skillRegistry.getSkillCount()).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate skill name "a-skill"'))
    warn.mockRestore()
  })
})
