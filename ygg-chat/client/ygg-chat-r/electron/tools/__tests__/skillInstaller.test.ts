import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let skillsDir: string
let fixtureRepo: string
let loadedSkills: Set<string>
const cloneCalls: Array<{ file: string; args: string[]; options: Record<string, any> }> = []

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, any>,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void
  ) => {
    cloneCalls.push({ file, args, options })
    const targetDir = args.at(-1)!
    cp(fixtureRepo, targetDir, { recursive: true })
      .then(() => callback(null, '', ''))
      .catch(error => callback(error as Error, '', String(error)))
  },
}))

vi.mock('../../tools/nativeShell.js', () => ({
  getNativeShellPath: vi.fn().mockResolvedValue('/native/bin:/usr/bin'),
}))

vi.mock('../../skills/skillLoader.js', () => ({
  skillRegistry: {
    getSkillsDirectory: () => skillsDir,
    reload: vi.fn(async () => {
      loadedSkills = new Set()
      const visit = async (dir: string, depth: number) => {
        if (depth > 2) return
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const entryPath = path.join(dir, entry.name)
          try {
            const content = await readFile(path.join(entryPath, 'SKILL.md'), 'utf8')
            const rawName = content.match(/(?:^|\n)name:\s*([^\n]+)\n/)?.[1]?.trim()
            const name = rawName?.replace(/^['"]|['"]$/g, '')
            if (name) loadedSkills.add(name)
          } catch {
            await visit(entryPath, depth + 1)
          }
        }
      }
      await visit(skillsDir, 0)
    }),
    hasSkill: (name: string) => loadedSkills.has(name),
  },
}))

const skillMd = (name: string, description = 'Test skill') =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nUse the skill.\n`

async function addSkill(relativePath: string, name = path.basename(relativePath), description?: string) {
  const dir = path.join(fixtureRepo, relativePath)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), skillMd(name, description), 'utf8')
  await writeFile(path.join(dir, 'README.md'), 'fixture', 'utf8')
}

describe('skillInstaller GitHub clone installation', () => {
  beforeEach(async () => {
    vi.resetModules()
    cloneCalls.length = 0
    loadedSkills = new Set()
    skillsDir = await mkdtemp(path.join(os.tmpdir(), 'ygg-skills-'))
    fixtureRepo = await mkdtemp(path.join(os.tmpdir(), 'ygg-skill-repo-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(skillsDir, { recursive: true, force: true }),
      rm(fixtureRepo, { recursive: true, force: true }),
    ])
  })

  it('normalizes an invalid manifest name, preserves its display name, and verifies registry loading', async () => {
    await addSkill('.', 'Simplified Technical English (ASD-STE100)', 'Rewrite ambiguous English')
    await mkdir(path.join(fixtureRepo, '.git'), { recursive: true })
    await writeFile(path.join(fixtureRepo, '.git', 'config'), 'should not copy', 'utf8')

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('https://github.com/danyuchn/asd-ste100-skill.git')

    expect(result).toMatchObject({
      success: true,
      skillName: 'simplified-technical-english-asd-ste100',
      displayName: 'Simplified Technical English (ASD-STE100)',
    })
    const installedDir = path.join(skillsDir, 'simplified-technical-english-asd-ste100')
    expect(await readFile(path.join(installedDir, 'SKILL.md'), 'utf8')).toContain(
      'name: simplified-technical-english-asd-ste100'
    )
    expect(JSON.parse(await readFile(path.join(installedDir, '.skill-meta.json'), 'utf8'))).toMatchObject({
      displayName: 'Simplified Technical English (ASD-STE100)',
      enabled: true,
    })
    await expect(access(path.join(installedDir, '.git'))).rejects.toThrow()
    expect(cloneCalls).toHaveLength(1)
    expect(cloneCalls[0]).toMatchObject({
      file: 'git',
      args: ['clone', '--depth', '1', '--single-branch', '--', 'https://github.com/danyuchn/asd-ste100-skill.git', expect.any(String)],
    })
    expect(cloneCalls[0].options.env).toMatchObject({
      PATH: '/native/bin:/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    })
    expect((await readdir(skillsDir)).some(name => name.startsWith('.cloning-'))).toBe(false)
  })

  it('uses the requested ref and installs a direct GitHub skill folder', async () => {
    await addSkill('skills/ponytail', 'ponytail')

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('https://github.com/owner/repo/tree/feature-x/skills/ponytail')

    expect(result).toMatchObject({ success: true, skillName: 'ponytail' })
    expect(cloneCalls[0].args).toEqual([
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      'feature-x',
      '--',
      'https://github.com/owner/repo.git',
      expect.any(String),
    ])
  })

  it('returns candidate URLs for multiple skills under top-level skills', async () => {
    await addSkill('skills/ponytail', 'ponytail')
    await addSkill('skills/ponytail-review', 'ponytail-review')

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('https://github.com/owner/repo.git')

    expect(result).toMatchObject({ success: false, code: 'MULTIPLE_SKILLS_FOUND' })
    expect(result.candidates).toEqual([
      {
        name: 'ponytail',
        path: 'skills/ponytail',
        url: 'https://github.com/owner/repo/tree/main/skills/ponytail',
      },
      {
        name: 'ponytail-review',
        path: 'skills/ponytail-review',
        url: 'https://github.com/owner/repo/tree/main/skills/ponytail-review',
      },
    ])
  })

  it('installs a grouped repository with normalized child directories and metadata', async () => {
    await addSkill('skills/one', 'First Skill')
    await addSkill('skills/two', 'second-skill')

    const { installAllFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installAllFromGitHub('owner/repo')

    expect(result).toMatchObject({
      success: true,
      skillName: 'repo',
      skillNames: ['first-skill', 'second-skill'],
      displayNames: ['First Skill', 'second-skill'],
    })
    await expect(access(path.join(skillsDir, 'repo', 'first-skill', 'SKILL.md'))).resolves.toBeUndefined()
    await expect(access(path.join(skillsDir, 'repo', 'second-skill', '.skill-meta.json'))).resolves.toBeUndefined()
  })

  it('rejects normalized-name collisions in a grouped repository', async () => {
    await addSkill('skills/one', 'Same Skill')
    await addSkill('skills/two', 'same-skill')

    const { installAllFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installAllFromGitHub('owner/repo')

    expect(result).toMatchObject({ success: false, code: 'INSTALL_FAILED' })
    expect(result.error).toContain('Duplicate normalized skill name "same-skill"')
    await expect(access(path.join(skillsDir, 'repo'))).rejects.toThrow()
  })

  it('rejects non-HTTPS GitHub URLs', async () => {
    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('http://github.com/owner/repo')

    expect(result).toMatchObject({ success: false, code: 'INSTALL_FAILED' })
    expect(result.error).toContain('Use an HTTPS GitHub repository URL')
    expect(cloneCalls).toHaveLength(0)
  })

  it('returns a clear no-skills result', async () => {
    await mkdir(path.join(fixtureRepo, 'docs'), { recursive: true })

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('owner/repo')

    expect(result).toMatchObject({ success: false, code: 'NO_SKILLS_FOUND' })
  })

  it('does not delete an existing skill when a duplicate install is attempted', async () => {
    await addSkill('.', 'valid-skill')
    const existingDir = path.join(skillsDir, 'valid-skill')
    await mkdir(existingDir, { recursive: true })
    await writeFile(path.join(existingDir, 'sentinel.txt'), 'keep me', 'utf8')

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('owner/repo')

    expect(result).toMatchObject({ success: false, code: 'INSTALL_FAILED' })
    expect(result.error).toContain('already installed')
    expect(await readFile(path.join(existingDir, 'sentinel.txt'), 'utf8')).toBe('keep me')
  })

  it('rolls back when registry verification fails', async () => {
    await addSkill('.', 'valid-skill')
    const loader = await import('../../skills/skillLoader.js')
    vi.mocked(loader.skillRegistry.reload).mockResolvedValueOnce(undefined)

    const { installFromGitHub } = await import('../../skills/skillInstaller.js')
    const result = await installFromGitHub('owner/repo')

    expect(result).toMatchObject({ success: false, code: 'INSTALL_FAILED' })
    expect(result.error).toContain('not loaded by the registry')
    await expect(access(path.join(skillsDir, 'valid-skill'))).rejects.toThrow()
  })
})
