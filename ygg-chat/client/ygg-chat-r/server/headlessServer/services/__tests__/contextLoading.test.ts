// Auto-loaded context (docs/claude_code_context_loading_rules.md): frontmatter envelope,
// glob semantics, instruction-file discovery, skills, agents, and the injection fold.
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectLoadedContextPaths,
  foldContextInjectionsForModel,
  renderInstructionSet,
  toContextInjectionBlock,
} from '../../../../../../shared/contextInjection.js'
import { normalizeContextDirectorySettings, resolveContextDirectorySettingsFromEnv } from '../../../../../../shared/contextDirectories.js'
import { parseToolNameList, resolveToolAliases } from '../../../../../../shared/toolNameAliases.js'
import { parseFrontmatter, parseFrontmatterBoolean, parseFrontmatterList, stripHtmlComments } from '../../../context/frontmatter.js'
import { absolutePathMatchesAny, compileGlob, compileGlobList, expandBraces, globListMatches } from '../../../context/globMatcher.js'
import { discoverLaunchInstructionFiles, extractImportTokens } from '../../../context/instructionFiles.js'
import { discoverRules, ruleMatchesFile } from '../../../context/rulesLoader.js'
import { discoverAgents, renderAgentIndex } from '../../../context/agentsLoader.js'
import { discoverSkills, matchSlashInvocation, parseSkillArguments, renderSkillBody, renderSkillIndex } from '../../../context/skillsDiscovery.js'
import { truncateMemoryIndex } from '../../../context/autoMemory.js'
import { ConversationContextLoader, extractTouchedFiles } from '../../../context/contextLoader.js'

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

describe('frontmatter envelope (§1)', () => {
  it('requires the opening --- on line 1', () => {
    const parsed = parseFrontmatter('\n---\nname: x\n---\nbody')
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toContain('name: x')
  })

  it('parses a mapping and returns the body', () => {
    const parsed = parseFrontmatter('---\nname: demo\npaths:\n  - "src/**"\n---\n# Title\n')
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data.name).toBe('demo')
    expect(parseFrontmatterList(parsed.data.paths)).toEqual(['src/**'])
    expect(parsed.body.trim()).toBe('# Title')
  })

  it('reports a YAML error and keeps the body', () => {
    const parsed = parseFrontmatter('---\nname: [unclosed\n---\nbody')
    expect(parsed.error).toBeTruthy()
    expect(parsed.body).toBe('body')
  })

  it('accepts yes/no/on/off/1/0 booleans and comma or space lists', () => {
    expect(parseFrontmatterBoolean('Yes')).toBe(true)
    expect(parseFrontmatterBoolean('off')).toBe(false)
    expect(parseFrontmatterBoolean(1)).toBe(true)
    expect(parseFrontmatterBoolean('maybe')).toBeUndefined()
    expect(parseFrontmatterList('a, b c')).toEqual(['a', 'b', 'c'])
    expect(parseFrontmatterList('src/**/*.ts,lib/*.ts', 'comma')).toEqual(['src/**/*.ts', 'lib/*.ts'])
  })

  it('strips HTML comments outside fenced code blocks only', () => {
    const input = 'keep\n<!-- drop me -->\n```\n<!-- keep in fence -->\n```\ntail <!-- inline --> end'
    const out = stripHtmlComments(input)
    expect(out).not.toContain('drop me')
    expect(out).toContain('<!-- keep in fence -->')
    expect(out).toContain('tail  end')
  })
})

describe('glob semantics (§3.3)', () => {
  it('expands braces and multiplies patterns', () => {
    expect(expandBraces('lib/**/*.{ts,tsx}')).toEqual(['lib/**/*.ts', 'lib/**/*.tsx'])
    expect(expandBraces('a{b,{c,d}}e').sort()).toEqual(['abe', 'ace', 'ade'])
  })

  it('anchors at the root: *.md matches only root-level markdown', () => {
    const list = compileGlobList(['*.md', 'src/**/*.ts'])
    expect(globListMatches(list, 'README.md')).toBe(true)
    expect(globListMatches(list, 'docs/README.md')).toBe(false)
    expect(globListMatches(list, 'src/a.ts')).toBe(true)
    expect(globListMatches(list, 'src/deep/er/a.ts')).toBe(true)
    expect(globListMatches(list, 'lib/a.ts')).toBe(false)
  })

  it('treats an unreadable bracket as an invalid pattern without breaking siblings', () => {
    const list = compileGlobList(['src/[abc.ts', 'src/[abc].ts'])
    expect(list.invalid).toEqual(['src/[abc.ts'])
    expect(globListMatches(list, 'src/a.ts')).toBe(true)
    expect(globListMatches(list, 'src/d.ts')).toBe(false)
    expect(compileGlob('src/\\[x].ts')?.test('src/[x].ts')).toBe(true)
  })

  it('matches excludes against absolute paths', () => {
    expect(absolutePathMatchesAny(['**/CLAUDE.local.md'], '/repo/sub/CLAUDE.local.md')).toBe(true)
    expect(absolutePathMatchesAny(['/repo/vendor/**'], '/repo/vendor/x/CLAUDE.md')).toBe(true)
    expect(absolutePathMatchesAny(['/repo/vendor/**'], '/repo/src/CLAUDE.md')).toBe(false)
  })
})

describe('context directory settings (§11.4)', () => {
  it('normalises invalid input to the defaults and snaps writeDir into readDirs', () => {
    expect(normalizeContextDirectorySettings(null)).toEqual({ readDirs: ['.ygg', '.claude'], writeDir: '.ygg' })
    expect(normalizeContextDirectorySettings({ readDirs: ['.claude', 'bad/name', '.claude'], writeDir: '.ygg' })).toEqual({
      readDirs: ['.claude'],
      writeDir: '.claude',
    })
    expect(resolveContextDirectorySettingsFromEnv({ YGG_CONTEXT_DIRECTORIES: '.a, .b', YGG_CONTEXT_WRITE_DIRECTORY: '.b' })).toEqual({
      readDirs: ['.a', '.b'],
      writeDir: '.b',
    })
  })
})

describe('tool name aliases (decision 11)', () => {
  it('maps Claude Code names and keeps rule arguments out', () => {
    expect(parseToolNameList('Read, Bash(git *) Grep')).toEqual(['Read', 'Bash(git *)', 'Grep'])
    const resolved = resolveToolAliases(['Read', 'Bash(git *)', 'mystery'], new Set(['bash', 'read_file']))
    expect(resolved.names).toEqual(['read_file', 'read_files', 'read_file_continuation', 'bash', 'mystery'])
    expect(resolved.unknown).toEqual(['mystery'])
  })
})

describe('instruction files (§2, §2.7)', () => {
  let root: string
  let home: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-ctx-root-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-ctx-home-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  it('loads AGENTS.md before CLAUDE.md, local last, imports, and dedupes symlinks', async () => {
    const project = path.join(root, 'proj')
    await write(path.join(project, 'AGENTS.md'), '# Agents\nSee @docs/extra.md\n')
    await write(path.join(project, 'docs', 'extra.md'), 'Extra rules <!-- hidden -->\n')
    await write(path.join(project, 'CLAUDE.md'), '@AGENTS.md\n')
    await write(path.join(project, 'CLAUDE.local.md'), 'local only\n')
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'user global\n')

    const loaded = new Set<string>()
    const entries = await discoverLaunchInstructionFiles({ rootPath: project, readDirs: ['.ygg', '.claude'], homeDir: home, loaded })
    const names = entries.map(entry => path.basename(entry.path))
    expect(names[0]).toBe('CLAUDE.md') // user scope first
    expect(entries[0].scope).toBe('user')
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('extra.md')
    expect(names).toContain('CLAUDE.local.md')
    // The CLAUDE.md whose body is only `@AGENTS.md` adds nothing once AGENTS.md loaded.
    expect(entries.filter(entry => entry.path.endsWith(`${path.sep}proj${path.sep}CLAUDE.md`))).toHaveLength(0)
    const agentsIndex = names.indexOf('AGENTS.md')
    expect(names.indexOf('CLAUDE.local.md')).toBeGreaterThan(agentsIndex)
    expect(entries.find(entry => entry.path.endsWith('extra.md'))?.text).not.toContain('hidden')
    expect(entries.find(entry => entry.path.endsWith('extra.md'))?.reason).toBe('include')
  })

  it('skips external project imports without an approver and loads them with approval', async () => {
    const project = path.join(root, 'proj')
    await write(path.join(project, 'AGENTS.md'), 'see @../outside.md\n')
    await write(path.join(root, 'outside.md'), 'outside content\n')

    const skipped = await discoverLaunchInstructionFiles({ rootPath: project, readDirs: [], homeDir: home, loaded: new Set() })
    expect(skipped.map(entry => path.basename(entry.path))).toEqual(['AGENTS.md'])

    const approved = await discoverLaunchInstructionFiles({
      rootPath: project,
      readDirs: [],
      homeDir: home,
      loaded: new Set(),
      approveExternalImports: async () => true,
    })
    expect(approved.map(entry => path.basename(entry.path))).toEqual(['AGENTS.md', 'outside.md'])
  })

  it('ignores import tokens inside code spans and fences', () => {
    const tokens = extractImportTokens('use @a.md and `@b.md`\n```\n@c.md\n```\nmail me@example.com @./d.md.')
    expect(tokens).toEqual(['a.md', './d.md'])
  })

  it('discovers rules with and without paths and matches root-relative globs', async () => {
    const project = path.join(root, 'proj')
    await write(path.join(project, '.ygg', 'rules', 'always.md'), 'always\n')
    await write(path.join(project, '.ygg', 'rules', 'api', 'api.md'), '---\npaths:\n  - "src/api/**/*.ts"\n---\napi rule\n')
    const rules = await discoverRules({
      directories: [{ dir: path.join(project, '.ygg', 'rules'), scope: 'project', anchorDir: project }],
      rootRealPath: await fs.realpath(project),
    })
    expect(rules.map(rule => path.basename(rule.path)).sort()).toEqual(['always.md', 'api.md'])
    const api = rules.find(rule => rule.path.endsWith('api.md'))!
    expect(ruleMatchesFile(api, path.join(project, 'src', 'api', 'x', 'y.ts'))).toBe(true)
    expect(ruleMatchesFile(api, path.join(project, 'src', 'ui', 'y.ts'))).toBe(false)
  })

  it('renders the launch set and derives the loaded set from the persisted row', async () => {
    const project = path.join(root, 'proj')
    await write(path.join(project, 'AGENTS.md'), 'hello\n')
    const loader = new ConversationContextLoader({
      conversationId: 'c1',
      rootPath: project,
      settings: { readDirs: ['.ygg'], writeDir: '.ygg' },
      dataDir: null,
      homeDir: home,
    })
    const launch = await loader.buildLaunchInjection(new Set())
    expect(launch).not.toBeNull()
    expect(launch!.text).toContain('Codebase and user instructions are shown below')
    expect(launch!.text).toContain(`Contents of ${await fs.realpath(path.join(project, 'AGENTS.md'))} (project instructions, checked into the codebase):`)
    const row = { role: 'user', content: launch!.text, meta: JSON.stringify({ kind: 'context_injection', files: launch!.files }) }
    const loaded = collectLoadedContextPaths([row])
    expect(await loader.buildLaunchInjection(loaded)).toBeNull()
  })

  it('lazy-loads nested AGENTS.md and path-scoped rules when a matching file is read', async () => {
    const project = path.join(root, 'proj')
    await write(path.join(project, 'AGENTS.md'), 'root\n')
    await write(path.join(project, 'apps', 'web', 'AGENTS.md'), 'web rules\n')
    await write(path.join(project, '.claude', 'rules', 'ts.md'), '---\npaths: ["apps/**/*.ts"]\n---\nts rule\n')
    const loader = new ConversationContextLoader({
      conversationId: 'c1',
      rootPath: project,
      settings: { readDirs: ['.ygg', '.claude'], writeDir: '.ygg' },
      dataDir: null,
      homeDir: home,
    })
    const touched = extractTouchedFiles({ name: 'read_file', arguments: JSON.stringify({ path: 'apps/web/index.ts' }) }, project)
    expect(touched).toHaveLength(1)
    const entries = await loader.collectLazyInjections({ name: 'read_file', arguments: { path: 'apps/web/index.ts' } }, new Set())
    const bases = entries.map(entry => path.basename(entry.path))
    expect(bases).toContain('AGENTS.md')
    expect(bases).toContain('ts.md')
    expect(entries.find(entry => entry.path.endsWith('ts.md'))?.reason).toBe('path_glob_match')
    // Search tools never trigger.
    expect(await loader.collectLazyInjections({ name: 'ripgrep', arguments: { path: 'apps/web/index.ts' } }, new Set())).toEqual([])
    // Second read: nothing new once the paths are recorded.
    const loaded = new Set(entries.map(entry => entry.path))
    expect(await loader.collectLazyInjections({ name: 'read_file', arguments: { path: 'apps/web/other.ts' } }, loaded)).toEqual([])
  })
})

describe('skills (§5)', () => {
  let root: string
  let home: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-skill-root-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-skill-home-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  it('discovers personal over project, honours invocation flags, and renders the index', async () => {
    await write(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Personal deploy\n---\npersonal body\n')
    await write(path.join(root, '.ygg', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Project deploy\n---\nproject body\n')
    await write(
      path.join(root, '.ygg', 'skills', 'secret', 'SKILL.md'),
      '---\nname: secret\ndescription: Hidden from model\ndisable-model-invocation: true\nmodel: haiku\n---\nsecret body\n'
    )
    await write(path.join(root, '.ygg', 'commands', 'ops', 'restart.md'), 'Restart $ARGUMENTS now\n')
    const skills = await discoverSkills({ rootPath: root, readDirs: ['.ygg', '.claude'], homeDir: home })
    const deploys = skills.filter(skill => skill.bareName === 'deploy')
    expect(deploys).toHaveLength(2)
    expect(deploys.find(skill => skill.scope === 'personal')?.shadowed).toBe(false)
    expect(deploys.find(skill => skill.scope === 'project')?.shadowed).toBe(true)
    expect(skills.find(skill => skill.name === 'ops:restart')?.scope).toBe('command')
    const index = renderSkillIndex(skills)!
    expect(index).toContain('- deploy: Personal deploy')
    expect(index).toContain('- ops:restart: Restart $ARGUMENTS now')
    expect(index).not.toContain('secret')
    const secret = skills.find(skill => skill.bareName === 'secret')!
    expect(secret.frontmatter.hasModelOverride).toBe(true)
    expect(secret.frontmatter.disableModelInvocation).toBe(true)
  })

  it('substitutes arguments once, honours escapes, and expands ${CLAUDE_*}', async () => {
    await write(
      path.join(root, '.ygg', 'skills', 'fix', 'SKILL.md'),
      '---\nname: fix\ndescription: Fix\narguments: [issue, branch]\n---\nAll: $ARGUMENTS\nFirst: $0 / $ARGUMENTS[1]\nNamed: $issue on $branch\nMissing: $9\nLiteral: \\$1\nDir: ${CLAUDE_SKILL_DIR}\nProject: ${CLAUDE_PROJECT_DIR}\n'
    )
    const skills = await discoverSkills({ rootPath: root, readDirs: ['.ygg'], homeDir: home })
    const skill = skills[0]
    const body = renderSkillBody(skill, { rawArguments: '123 "feature branch"', projectDir: root, sessionId: 's1' })
    expect(body).toContain('All: 123 "feature branch"')
    expect(body).toContain('First: 123 / feature branch')
    expect(body).toContain('Named: 123 on feature branch')
    expect(body).toContain('Missing: $9')
    expect(body).toContain('Literal: $1')
    expect(body).toContain(`Dir: ${skill.skillDir}`)
    expect(body).toContain(`Project: ${root}`)
    expect(parseSkillArguments(`a "b c" d\\ e`)).toEqual(['a', 'b c', 'd e'])
    const match = matchSlashInvocation('/fix 7 main', skills)
    expect(match?.skill.name).toBe('fix')
    expect(match?.rawArguments).toBe('7 main')
    expect(matchSlashInvocation('/unknown x', skills)).toBeNull()
  })
})

describe('agents (§6)', () => {
  it('validates name/description, walks up from the root, and renders the index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-agent-root-'))
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-agent-home-'))
    try {
      await write(path.join(root, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: opus\n---\nYou review.\n')
      await write(path.join(root, '.claude', 'agents', 'broken.md'), '---\nname: Bad:Name\ndescription: nope\n---\nx\n')
      await write(path.join(root, '.claude', 'agents', 'doc.md'), 'Just documentation.\n')
      await write(path.join(home, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: User reviewer\n---\nuser\n')
      const agents = await discoverAgents({ rootPath: root, readDirs: ['.claude'], homeDir: home })
      expect(agents).toHaveLength(1)
      expect(agents[0].scope).toBe('project')
      expect(agents[0].tools).toEqual(['Read', 'Grep'])
      expect(agents[0].ignoredKeys).toEqual(['model'])
      expect(renderAgentIndex(agents)).toContain('- reviewer: Reviews code (Tools: Read, Grep)')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('auto memory (§4.2)', () => {
  it('head-reads 200 lines / 25 KB', () => {
    const manyLines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
    const result = truncateMemoryIndex(manyLines)
    expect(result.truncated).toBe(true)
    expect(result.text.split('\n')).toHaveLength(200)
    const big = 'x'.repeat(30 * 1024)
    expect(Buffer.byteLength(truncateMemoryIndex(big).text)).toBeLessThanOrEqual(25 * 1024)
  })
})

describe('context injection fold (decision 7, §11.5)', () => {
  it('appends block text to the matching tool result and tool row, then removes the blocks', () => {
    const entry = { path: '/repo/sub/AGENTS.md', label: 'project instructions, checked into the codebase', text: 'nested rules', reason: 'nested_traversal' as const }
    const assistant = {
      role: 'assistant',
      content: '',
      content_blocks: JSON.stringify([
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        { type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false },
        toContextInjectionBlock(entry, 't1'),
      ]),
    }
    const toolRow = { role: 'tool', tool_call_id: 't1', content: 'file body' }
    const user = { role: 'user', content: '/deploy', content_blocks: [toContextInjectionBlock({ ...entry, reason: 'skill' })] }
    type FoldedRow = { content: string; content_blocks: unknown }
    const [foldedUser, foldedAssistant, foldedTool] = foldContextInjectionsForModel([user, assistant, toolRow]) as unknown as FoldedRow[]
    expect(foldedUser.content).toContain('/deploy')
    expect(foldedUser.content).toContain('nested rules')
    expect(foldedUser.content_blocks).toEqual([])
    const blocks = JSON.parse(foldedAssistant.content_blocks as string) as Array<{ type: string; content: string }>
    expect(blocks.some(block => block.type === 'context_injection')).toBe(false)
    expect(blocks[1].content).toContain('Contents of /repo/sub/AGENTS.md')
    expect(foldedTool.content).toContain('nested rules')
    // Untouched rows are returned by reference.
    expect(foldContextInjectionsForModel([toolRow])[0]).toBe(toolRow)
    expect(collectLoadedContextPaths([assistant])).toEqual(new Set(['/repo/sub/AGENTS.md']))
    expect(renderInstructionSet([entry])).toContain('<system-reminder>')
  })
})
