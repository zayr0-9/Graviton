// server/context/agentsLoader.ts
// Subagent definitions `<configDir>/agents/**/*.md` (docs §6).

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseToolNameList } from '../../../../shared/toolNameAliases.js'
import { parseFrontmatter, parseFrontmatterBoolean, parseFrontmatterList, parseFrontmatterString } from './frontmatter.js'
import { ancestorChain, type ContextDebugLogger } from './instructionFiles.js'

export type AgentScope = 'user' | 'project'
export type AgentMemoryScope = 'user' | 'project' | 'local'

export interface AgentDefinition {
  name: string
  description: string
  /** Allow-list (Claude Code names or Graviton names). null = every subagent tool. */
  tools: string[] | null
  /** Deny-list applied before `tools`. */
  disallowedTools: string[]
  /** Skill names whose full bodies are injected at startup. */
  skills: string[]
  maxTurns?: number
  memory?: AgentMemoryScope
  omitClaudeMd: boolean
  color?: string
  /** The body is the subagent's system prompt. */
  body: string
  filePath: string
  realPath: string
  scope: AgentScope
  /** Frontmatter keys present in the file that Graviton does not act on. */
  ignoredKeys: string[]
}

const noop: ContextDebugLogger = () => {}

/** §6.2 `name`: lowercase letters and hyphens; must not start with `-` or contain `:`. */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes(':')
}

/** Keys parsed for reference but not acted on (decisions 8 and 12, plus unsupported features). */
const IGNORED_AGENT_KEYS = [
  'model',
  'effort',
  'permissionMode',
  'mcpServers',
  'hooks',
  'background',
  'isolation',
  'initialPrompt',
  'experimental',
]

async function walkMarkdown(dir: string): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(full)
        isDir = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        continue
      }
    }
    if (isDir) out.push(...(await walkMarkdown(full)))
    else if (isFile && entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

/** §6.3 validation: returns null (and logs) when the file must be skipped. */
export async function readAgentDefinition(filePath: string, scope: AgentScope, debug: ContextDebugLogger = noop): Promise<AgentDefinition | null> {
  let realPath: string
  let raw: string
  try {
    realPath = await fs.realpath(filePath)
    raw = await fs.readFile(realPath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseFrontmatter(raw)
  if (parsed.error) {
    debug(`agent skipped (frontmatter error: ${parsed.error}): ${filePath}`)
    return null
  }
  if (!parsed.hasFrontmatter) {
    debug(`agent skipped (no frontmatter, treated as documentation): ${filePath}`)
    return null
  }
  const name = parseFrontmatterString(parsed.data.name)
  if (!name) {
    debug(`agent skipped (no name): ${filePath}`)
    return null
  }
  if (!isValidAgentName(name)) {
    debug(`agent skipped (invalid name "${name}"): ${filePath}`)
    return null
  }
  const description = parseFrontmatterString(parsed.data.description)
  if (!description) {
    debug(`agent skipped (no description): ${filePath}`)
    return null
  }
  const toolsRaw = parsed.data.tools
  const tools = toolsRaw === undefined || toolsRaw === null ? null : parseToolNameList(toolsRaw)
  const memoryRaw = parseFrontmatterString(parsed.data.memory)
  const memory = memoryRaw === 'user' || memoryRaw === 'project' || memoryRaw === 'local' ? memoryRaw : undefined
  const maxTurnsRaw = parsed.data.maxTurns
  const maxTurns =
    typeof maxTurnsRaw === 'number' && Number.isInteger(maxTurnsRaw) && maxTurnsRaw > 0
      ? maxTurnsRaw
      : typeof maxTurnsRaw === 'string' && /^\d+$/.test(maxTurnsRaw.trim()) && Number(maxTurnsRaw) > 0
        ? Number(maxTurnsRaw)
        : undefined
  const ignoredKeys = IGNORED_AGENT_KEYS.filter(key => parsed.data[key] !== undefined)
  if (ignoredKeys.length > 0) debug(`agent "${name}" has ignored keys: ${ignoredKeys.join(', ')}`)
  return {
    name,
    description,
    tools,
    disallowedTools: parseToolNameList(parsed.data.disallowedTools),
    skills: parseFrontmatterList(parsed.data.skills),
    maxTurns,
    memory,
    omitClaudeMd: parseFrontmatterBoolean(parsed.data.omitClaudeMd) ?? false,
    color: parseFrontmatterString(parsed.data.color),
    body: parsed.body.trim(),
    filePath,
    realPath,
    scope,
    ignoredKeys,
  }
}

export interface DiscoverAgentsOptions {
  rootPath: string
  readDirs: readonly string[]
  homeDir?: string
  debug?: ContextDebugLogger
}

/**
 * §6.1: project agents are discovered by walking up from the root (closest
 * definition wins on a name clash), then user agents `~/<readDir>/agents/**`.
 * Identity comes from `name`, not the filename.
 */
export async function discoverAgents(options: DiscoverAgentsOptions): Promise<AgentDefinition[]> {
  const debug = options.debug ?? noop
  const homeDir = options.homeDir ?? os.homedir()
  const byName = new Map<string, AgentDefinition>()
  const seenReal = new Set<string>()

  const consider = async (file: string, scope: AgentScope) => {
    const agent = await readAgentDefinition(file, scope, debug)
    if (!agent || seenReal.has(agent.realPath)) return
    seenReal.add(agent.realPath)
    if (byName.has(agent.name)) {
      debug(`duplicate agent "${agent.name}" ignored: ${file} (kept ${byName.get(agent.name)?.filePath})`)
      return
    }
    byName.set(agent.name, agent)
  }

  // Closest directory first so it wins.
  for (const directory of ancestorChain(options.rootPath).reverse()) {
    for (const readDir of options.readDirs) {
      for (const file of await walkMarkdown(path.join(directory, readDir, 'agents'))) await consider(file, 'project')
    }
  }
  for (const readDir of options.readDirs) {
    for (const file of await walkMarkdown(path.join(homeDir, readDir, 'agents'))) await consider(file, 'user')
  }
  return Array.from(byName.values())
}

/** §6.4 observed rendering of the agent index in the parent system prompt. */
export function renderAgentIndex(agents: readonly AgentDefinition[], toolName = 'subagent'): string | null {
  if (agents.length === 0) return null
  const lines = agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(agent => {
      const tools = agent.tools && agent.tools.length > 0 ? ` (Tools: ${agent.tools.join(', ')})` : ''
      return `- ${agent.name}: ${agent.description.replace(/\s+/g, ' ').trim()}${tools}`
    })
  return [`Available agent types for the ${toolName} tool (pass the name as agent_type):`, ...lines].join('\n')
}

/** §6.5 memory directories, with `<writeDir>` from the context directory setting. */
export function resolveAgentMemoryDirectory(
  agent: Pick<AgentDefinition, 'name' | 'memory'>,
  options: { dataDir: string; rootPath: string; writeDir: string }
): string | null {
  if (!agent.memory) return null
  if (agent.memory === 'user') return path.join(options.dataDir, '.ygg', 'agent-memory', agent.name)
  if (agent.memory === 'project') return path.join(options.rootPath, options.writeDir, 'agent-memory', agent.name)
  return path.join(options.rootPath, options.writeDir, 'agent-memory-local', agent.name)
}
