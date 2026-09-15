// server/context/skillsDiscovery.ts
// SKILL.md discovery across scopes, the startup index, and body rendering
// (docs/claude_code_context_loading_rules.md §5).

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseToolNameList } from '../../../../shared/toolNameAliases.js'
import {
  parseFrontmatter,
  parseFrontmatterBoolean,
  parseFrontmatterList,
  parseFrontmatterString,
} from './frontmatter.js'
import { compileGlobList, globListMatches, type CompiledGlobList } from './globMatcher.js'
import { ancestorChain, isInsideDirectory, type ContextDebugLogger } from './instructionFiles.js'

/** §5.2 `when_to_use`: description + when_to_use are truncated at 1,536 characters in the listing. */
export const SKILL_DESCRIPTION_CAP = 1536
export const SKILL_FILE = 'SKILL.md'

export type SkillScope = 'enterprise' | 'personal' | 'project' | 'nested' | 'command'

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  arguments: string[]
  disableModelInvocation: boolean
  userInvocable: boolean
  /** Parsed, never enforced (decision 8, TODO). */
  allowedTools: string[]
  disallowedTools: string[]
  context?: 'fork'
  agent?: string
  background: boolean
  paths: string[] | null
  compiled: CompiledGlobList | null
  shell?: 'bash' | 'powershell'
  metadata?: Record<string, unknown>
  license?: string
  compatibility?: string
  /** Present in the file; ignored (decision 8). */
  hooks?: unknown
  /** `model:` or `effort:` present; ignored (decision 12). */
  hasModelOverride: boolean
}

export interface DiscoveredSkill {
  /** Invocation name: bare, or `<subdir-path>:<name>` for nested skills, `<dir>:<name>` for commands. */
  name: string
  bareName: string
  scope: SkillScope
  /** Directory containing SKILL.md (or the command file's directory). */
  skillDir: string
  filePath: string
  realPath: string
  body: string
  frontmatter: SkillFrontmatter
  /** Root the `paths` globs are anchored at. */
  anchorDir: string
  /** True when a higher-priority scope owns the same bare name. */
  shadowed: boolean
}

const noop: ContextDebugLogger = () => {}

export function normalizeSkillInvocationName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:/]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseSkillFrontmatter(data: Record<string, unknown>, fallbackName: string, body: string): SkillFrontmatter {
  const name = parseFrontmatterString(data.name) ?? fallbackName
  const firstBodyLine = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0)
  const description = parseFrontmatterString(data.description) ?? firstBodyLine ?? ''
  const pathsRaw = data.paths
  const paths = pathsRaw === undefined || pathsRaw === null ? null : parseFrontmatterList(pathsRaw, 'comma')
  const context = parseFrontmatterString(data.context)
  const shell = parseFrontmatterString(data.shell)
  return {
    name,
    description,
    whenToUse: parseFrontmatterString(data.when_to_use ?? data['when-to-use']),
    argumentHint: parseFrontmatterString(data['argument-hint'] ?? data.argumentHint),
    arguments: parseFrontmatterList(data.arguments),
    disableModelInvocation: parseFrontmatterBoolean(data['disable-model-invocation']) ?? false,
    userInvocable: parseFrontmatterBoolean(data['user-invocable']) ?? true,
    allowedTools: parseToolNameList(data['allowed-tools']),
    disallowedTools: parseToolNameList(data['disallowed-tools']),
    context: context === 'fork' ? 'fork' : undefined,
    agent: parseFrontmatterString(data.agent),
    background: parseFrontmatterBoolean(data.background) ?? true,
    paths: paths && paths.length > 0 ? paths : null,
    compiled: paths && paths.length > 0 ? compileGlobList(paths) : null,
    shell: shell === 'powershell' ? 'powershell' : shell === 'bash' ? 'bash' : undefined,
    metadata:
      data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : undefined,
    license: parseFrontmatterString(data.license),
    compatibility: parseFrontmatterString(data.compatibility)?.slice(0, 500),
    hooks: data.hooks,
    hasModelOverride: data.model !== undefined || data.effort !== undefined,
  }
}

async function readSkillFile(
  filePath: string,
  scope: SkillScope,
  invocationName: string,
  anchorDir: string,
  debug: ContextDebugLogger
): Promise<DiscoveredSkill | null> {
  let realPath: string
  let raw: string
  try {
    realPath = await fs.realpath(filePath)
    raw = await fs.readFile(realPath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseFrontmatter(raw)
  if (parsed.error) debug(`skill frontmatter error (${parsed.error}): ${filePath}`)
  const skillDir = path.dirname(filePath)
  const fallback = scope === 'command' ? path.basename(filePath, '.md') : path.basename(skillDir)
  const frontmatter = parseSkillFrontmatter(parsed.data, fallback, parsed.body)
  if (frontmatter.hasModelOverride) debug(`skill "${frontmatter.name}" sets model/effort; ignored (decision 12)`)
  const bareName = normalizeSkillInvocationName(frontmatter.name) || normalizeSkillInvocationName(fallback)
  if (!bareName) return null
  const prefix = invocationName.includes(':') ? invocationName.slice(0, invocationName.lastIndexOf(':') + 1) : ''
  return {
    name: `${prefix}${bareName}`,
    bareName,
    scope,
    skillDir,
    filePath,
    realPath,
    body: parsed.body.trim(),
    frontmatter,
    anchorDir,
    shadowed: false,
  }
}

async function listSkillDirs(skillsRoot: string): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(skillsRoot, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(full)).isDirectory()
      } catch {
        continue
      }
    }
    if (!isDir) continue
    try {
      if ((await fs.stat(path.join(full, SKILL_FILE))).isFile()) out.push(full)
    } catch {
      // Not a skill directory.
    }
  }
  return out
}

async function listCommandFiles(commandsRoot: string, prefix = ''): Promise<Array<{ file: string; name: string }>> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(commandsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ file: string; name: string }> = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(commandsRoot, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listCommandFiles(full, `${prefix}${entry.name}:`)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ file: full, name: `${prefix}${path.basename(entry.name, '.md')}` })
    }
  }
  return out
}

/** Load one skill directory (`<dir>/SKILL.md`) as the given scope. Used for host installs. */
export async function loadSkillFromDirectory(
  skillDir: string,
  scope: SkillScope,
  anchorDir: string = skillDir,
  debug: ContextDebugLogger = noop
): Promise<DiscoveredSkill | null> {
  return readSkillFile(path.join(skillDir, SKILL_FILE), scope, path.basename(skillDir), anchorDir, debug)
}

export interface DiscoverSkillsOptions {
  rootPath: string
  readDirs: readonly string[]
  homeDir?: string
  /** Skills supplied by the host (e.g. `<dataDir>/skills` installs), treated as personal scope. */
  extraPersonal?: readonly DiscoveredSkill[]
  debug?: ContextDebugLogger
}

/**
 * §5.1 scopes: personal (`~/<readDir>/skills` + host installs) > project
 * (`<root>/<readDir>/skills`, legacy `<root>/<readDir>/commands`). Same bare name in
 * two scopes: the higher-priority one runs; every version stays listed (`shadowed`).
 */
export async function discoverSkills(options: DiscoverSkillsOptions): Promise<DiscoveredSkill[]> {
  const debug = options.debug ?? noop
  const homeDir = options.homeDir ?? os.homedir()
  const rootPath = path.resolve(options.rootPath)
  const found: DiscoveredSkill[] = [...(options.extraPersonal ?? [])]
  const seenReal = new Set(found.map(skill => skill.realPath))

  const add = async (filePath: string, scope: SkillScope, invocationName: string, anchorDir: string) => {
    const skill = await readSkillFile(filePath, scope, invocationName, anchorDir, debug)
    if (!skill || seenReal.has(skill.realPath)) return
    seenReal.add(skill.realPath)
    found.push(skill)
  }

  for (const readDir of options.readDirs) {
    for (const dir of await listSkillDirs(path.join(homeDir, readDir, 'skills'))) {
      await add(path.join(dir, SKILL_FILE), 'personal', path.basename(dir), homeDir)
    }
  }
  for (const readDir of options.readDirs) {
    for (const dir of await listSkillDirs(path.join(rootPath, readDir, 'skills'))) {
      await add(path.join(dir, SKILL_FILE), 'project', path.basename(dir), rootPath)
    }
    for (const command of await listCommandFiles(path.join(rootPath, readDir, 'commands'))) {
      await add(command.file, 'command', command.name, rootPath)
    }
  }

  return markShadowed(found)
}

/**
 * §5.1 "Nested": `<subdir>/<readDir>/skills/<name>/SKILL.md` for `<subdir>` below the
 * root, named `/<subdir-path>:<name>`. Discovered when the model first works on files
 * there (called from the lazy chain walk).
 */
export async function discoverNestedSkills(options: {
  rootPath: string
  directory: string
  readDirs: readonly string[]
  debug?: ContextDebugLogger
}): Promise<DiscoveredSkill[]> {
  const debug = options.debug ?? noop
  const rootPath = path.resolve(options.rootPath)
  const directory = path.resolve(options.directory)
  if (!isInsideDirectory(directory, rootPath) || directory === rootPath) return []
  const relative = path.relative(rootPath, directory).split(path.sep).join('/')
  const found: DiscoveredSkill[] = []
  for (const readDir of options.readDirs) {
    for (const dir of await listSkillDirs(path.join(directory, readDir, 'skills'))) {
      const skill = await readSkillFile(path.join(dir, SKILL_FILE), 'nested', `${relative}:${path.basename(dir)}`, directory, debug)
      if (skill) found.push(skill)
    }
  }
  return found
}

const SCOPE_PRIORITY: Record<SkillScope, number> = { enterprise: 0, personal: 1, project: 2, command: 3, nested: 4 }

export function markShadowed(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const best = new Map<string, DiscoveredSkill>()
  for (const skill of skills) {
    if (skill.scope === 'nested') continue
    const current = best.get(skill.bareName)
    if (!current || SCOPE_PRIORITY[skill.scope] < SCOPE_PRIORITY[current.scope]) best.set(skill.bareName, skill)
  }
  return skills.map(skill => ({ ...skill, shadowed: skill.scope !== 'nested' && best.get(skill.bareName) !== skill }))
}

/** Resolve `/name` or `/path:name`: exact invocation name first, then unshadowed bare name. */
export function findSkill(skills: readonly DiscoveredSkill[], name: string): DiscoveredSkill | null {
  const wanted = normalizeSkillInvocationName(name.replace(/^\//, ''))
  if (!wanted) return null
  const exact = skills.find(skill => skill.name === wanted && !skill.shadowed) ?? skills.find(skill => skill.name === wanted)
  if (exact) return exact
  return skills.find(skill => skill.bareName === wanted && !skill.shadowed) ?? null
}

/** §5.3 startup index. Excludes `disable-model-invocation: true`; caps each description. */
export function renderSkillIndex(skills: readonly DiscoveredSkill[], toolName = 'skill_manager'): string | null {
  const visible = skills.filter(skill => !skill.frontmatter.disableModelInvocation && !skill.shadowed)
  if (visible.length === 0) return null
  const lines = visible
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(skill => {
      const description = [skill.frontmatter.description, skill.frontmatter.whenToUse]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SKILL_DESCRIPTION_CAP)
      return `- ${skill.name}: ${description}`
    })
  return [
    `The following skills are available for use with the ${toolName} tool (action "activate", name "<skill>"):`,
    ...lines,
  ].join('\n')
}

/** Shell-style argument split: `"hello world"` is one argument. */
export function parseSkillArguments(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && i + 1 < raw.length) {
        current += raw[++i]
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    if (char === '\\' && i + 1 < raw.length) {
      current += raw[++i]
      hasToken = true
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken) args.push(current)
  return args
}

const KEEP_BACKSLASH = '\uE002'
const ESCAPED_DOLLAR_MARK = '\uE003'
const LITERAL_DOLLAR = '\uE004'

export interface RenderSkillBodyOptions {
  rawArguments?: string | null
  sessionId?: string | null
  projectDir?: string | null
  effort?: string | null
}

/**
 * §5.4 pipeline steps 1 and 2: argument substitution, then `${CLAUDE_*}`. Runs once
 * over the original file; inserted values are not re-scanned. `` !`cmd` `` injection
 * (step 3) is not implemented (decision 8) and stays in place as text.
 */
export function renderSkillBody(skill: DiscoveredSkill, options: RenderSkillBodyOptions = {}): string {
  const rawArguments = (options.rawArguments ?? '').trim()
  const args = parseSkillArguments(rawArguments)
  const named = new Map<string, string>()
  skill.frontmatter.arguments.forEach((name, index) => named.set(name, args[index] ?? ''))

  // Escapes: `\\$1` keeps one backslash and still expands; `\$1` is a literal `$1`.
  // Private-use placeholders survive the substitution pass untouched.
  let text = skill.body.replace(/\\\\(?=\$)/g, KEEP_BACKSLASH).replace(/\\(?=\$)/g, ESCAPED_DOLLAR_MARK)
  text = text.split(`${ESCAPED_DOLLAR_MARK}$`).join(LITERAL_DOLLAR)
  text = text.replace(
    /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, indexed: string | undefined, positional: string | undefined, name: string | undefined) => {
      if (indexed !== undefined) {
        const value = args[Number(indexed)]
        return value === undefined ? match : value
      }
      if (positional !== undefined) {
        const value = args[Number(positional)]
        return value === undefined ? match : value
      }
      if (match === '$ARGUMENTS') return rawArguments
      if (name !== undefined && named.has(name)) return named.get(name) ?? ''
      return match
    }
  )
  text = text.split(LITERAL_DOLLAR).join('$').split(KEEP_BACKSLASH).join('\\')

  const variables: Record<string, string> = {
    CLAUDE_SESSION_ID: options.sessionId ?? '',
    CLAUDE_SKILL_DIR: skill.skillDir,
    CLAUDE_PROJECT_DIR: options.projectDir ?? '',
    CLAUDE_EFFORT: options.effort ?? '',
    YGG_SESSION_ID: options.sessionId ?? '',
    YGG_SKILL_DIR: skill.skillDir,
    YGG_PROJECT_DIR: options.projectDir ?? '',
  }
  text = text.replace(/\$\{(CLAUDE_[A-Z_]+|YGG_[A-Z_]+)\}/g, (match, key: string) => (key in variables ? variables[key] : match))
  return text.trim()
}

/** §5.7: a skill with `paths` auto-loads when the touched file matches (anchored at its scope root). */
export function skillMatchesFile(skill: DiscoveredSkill, absoluteFilePath: string): boolean {
  if (!skill.frontmatter.compiled) return false
  if (!isInsideDirectory(absoluteFilePath, skill.anchorDir)) return false
  return globListMatches(skill.frontmatter.compiled, path.relative(skill.anchorDir, absoluteFilePath))
}

/** `/name rest of line` typed by the user → the skill and its raw argument string. */
export function matchSlashInvocation(
  content: string,
  skills: readonly DiscoveredSkill[]
): { skill: DiscoveredSkill; rawArguments: string } | null {
  const match = content.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9_:./-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const skill = findSkill(skills, match[1])
  if (!skill || !skill.frontmatter.userInvocable) return null
  return { skill, rawArguments: (match[2] ?? '').trim() }
}

/** Directories whose nested skills a lazy walk should consider for a touched file. */
export function nestedSkillDirectoriesForFile(rootPath: string, absoluteFilePath: string): string[] {
  const chain = ancestorChain(path.dirname(absoluteFilePath))
  const resolvedRoot = path.resolve(rootPath)
  return chain.filter(dir => dir !== resolvedRoot && isInsideDirectory(dir, resolvedRoot))
}
