// server/context/contextLoader.ts
// Per-conversation orchestration of every auto-loaded context source
// (docs/claude_code_context_loading_rules.md §10, §11).
//
// One loader is built per chat run from the conversation root and the user's
// context directory setting. It is independent of hooks, the decision broker and
// the tool executor (decision 14): callers pass optional callbacks for the two
// interactive points (external-import approval, InstructionsLoaded reporting).

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ContextDirectorySettings } from '../../../../shared/contextDirectories.js'
import {
  LABEL_PROJECT,
  collectInvokedSkillEntries,
  renderInstructionSet,
  type ContextInjectionEntry,
  type ContextInjectionReason,
} from '../../../../shared/contextInjection.js'
import { discoverAgents, renderAgentIndex, type AgentDefinition } from './agentsLoader.js'
import { buildAutoMemoryPrompt, isAutoMemoryDisabled, readMemoryIndex, resolveAutoMemoryDirectory } from './autoMemory.js'
import { absolutePathMatchesAny } from './globMatcher.js'
import {
  chainBelowRoot,
  discoverLaunchInstructionFiles,
  discoverNestedInstructionFiles,
  isInsideDirectory,
  type ContextDebugLogger,
} from './instructionFiles.js'
import { discoverRules, ruleMatchesFile, type RuleFile, type RulesDirectorySpec } from './rulesLoader.js'
import {
  discoverNestedSkills,
  discoverSkills,
  findSkill,
  markShadowed,
  matchSlashInvocation,
  nestedSkillDirectoriesForFile,
  renderSkillBody,
  renderSkillIndex,
  skillMatchesFile,
  type DiscoveredSkill,
} from './skillsDiscovery.js'

/** Decision 4: Read tools plus edit tools trigger lazy loads; search tools do not. */
export const DEFAULT_LAZY_TRIGGER_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'read_file_continuation',
  'edit_file',
  'multi_edit',
  'create_file',
])

/** §5.4 compaction re-attach budget, in characters (≈4 chars per token). */
export const SKILL_REATTACH_PER_SKILL_CHARS = 5000 * 4
export const SKILL_REATTACH_TOTAL_CHARS = 25000 * 4

export interface LaunchInjection {
  text: string
  files: string[]
  entries: ContextInjectionEntry[]
  reason: ContextInjectionReason
}

export interface ContextSettingsFile {
  claudeMdExcludes: string[]
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
}

export interface ConversationContextLoaderOptions {
  conversationId: string
  rootPath: string
  settings: ContextDirectorySettings
  /** Host data directory (`<dataDir>/.ygg/...`). null disables auto memory. */
  dataDir: string | null
  homeDir?: string
  /** Renderer toggle (`loadLongTermMemoryContextEnabled`). Env/settings can still disable. */
  autoMemoryEnabled?: boolean
  /** Host-installed skills (`<dataDir>/skills`), personal scope. */
  hostSkills?: readonly DiscoveredSkill[]
  approveExternalImports?: (paths: string[]) => Promise<boolean>
  /** Fired once per injected entry batch (InstructionsLoaded analogue). Best effort. */
  onInstructionsLoaded?: (entries: ContextInjectionEntry[], reason: ContextInjectionReason) => void
  triggerToolNames?: ReadonlySet<string>
  debug?: ContextDebugLogger
}

interface TouchedFile {
  absolutePath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSettingsFile(file: string): Promise<ContextSettingsFile | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const excludes = Array.isArray(parsed.claudeMdExcludes)
      ? parsed.claudeMdExcludes.filter((entry: unknown): entry is string => typeof entry === 'string')
      : []
    return {
      claudeMdExcludes: excludes,
      autoMemoryEnabled: typeof parsed.autoMemoryEnabled === 'boolean' ? parsed.autoMemoryEnabled : undefined,
      autoMemoryDirectory: typeof parsed.autoMemoryDirectory === 'string' ? parsed.autoMemoryDirectory : undefined,
    }
  } catch {
    return null
  }
}

/** Extract the workspace files a tool call touches (decision 4 trigger set). */
export function extractTouchedFiles(
  toolCall: { name: string; arguments: unknown },
  rootPath: string,
  triggerTools: ReadonlySet<string> = DEFAULT_LAZY_TRIGGER_TOOLS
): TouchedFile[] {
  if (!triggerTools.has(toolCall.name)) return []
  let args: Record<string, unknown> = {}
  if (typeof toolCall.arguments === 'string') {
    try {
      const parsed = JSON.parse(toolCall.arguments)
      if (isRecord(parsed)) args = parsed
    } catch {
      return []
    }
  } else if (isRecord(toolCall.arguments)) {
    args = toolCall.arguments
  }
  const base =
    typeof args.cwd === 'string' && args.cwd.trim()
      ? path.resolve(rootPath, args.cwd.trim())
      : typeof args.baseDir === 'string' && args.baseDir.trim()
        ? path.resolve(rootPath, args.baseDir.trim())
        : rootPath
  const candidates: string[] = []
  for (const key of ['path', 'file_path', 'filePath']) {
    if (typeof args[key] === 'string' && (args[key] as string).trim()) candidates.push((args[key] as string).trim())
  }
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) if (typeof entry === 'string' && entry.trim()) candidates.push(entry.trim())
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (isRecord(edit) && typeof edit.path === 'string' && edit.path.trim()) candidates.push(edit.path.trim())
    }
  }
  const resolvedRoot = path.resolve(rootPath)
  const seen = new Set<string>()
  const out: TouchedFile[] = []
  for (const candidate of candidates) {
    const absolutePath = path.resolve(base, candidate)
    if (!isInsideDirectory(absolutePath, resolvedRoot)) continue
    if (seen.has(absolutePath)) continue
    seen.add(absolutePath)
    out.push({ absolutePath })
  }
  return out
}

export class ConversationContextLoader {
  readonly conversationId: string
  readonly rootPath: string
  readonly settings: ContextDirectorySettings
  readonly triggerTools: ReadonlySet<string>
  private readonly options: ConversationContextLoaderOptions
  private readonly homeDir: string
  private readonly debug: ContextDebugLogger
  private settingsPromise: Promise<ContextSettingsFile> | null = null
  private rulesPromise: Promise<RuleFile[]> | null = null
  private skillsPromise: Promise<DiscoveredSkill[]> | null = null
  private agentsPromise: Promise<AgentDefinition[]> | null = null
  /** Nested skills discovered during the session, keyed by real path. */
  private readonly nestedSkills = new Map<string, DiscoveredSkill>()
  private autoMemoryDirectory: string | null | undefined

  constructor(options: ConversationContextLoaderOptions) {
    this.options = options
    this.conversationId = options.conversationId
    this.rootPath = path.resolve(options.rootPath)
    this.settings = options.settings
    this.homeDir = options.homeDir ?? os.homedir()
    this.triggerTools = options.triggerToolNames ?? DEFAULT_LAZY_TRIGGER_TOOLS
    this.debug = options.debug ?? ((message, detail) => {
      if (/^(1|true|yes|on)$/i.test(process.env.YGG_CONTEXT_DEBUG_LOGS || '')) {
        console.info(`[ContextLoader] ${message}`, detail ?? '')
      }
    })
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  /** Merge `claudeMdExcludes` / auto-memory keys from every settings layer we read. */
  getSettingsFile(): Promise<ContextSettingsFile> {
    if (!this.settingsPromise) {
      this.settingsPromise = (async () => {
        const files: string[] = []
        if (this.options.dataDir) files.push(path.join(this.options.dataDir, '.ygg', 'settings.json'))
        for (const readDir of this.settings.readDirs) {
          files.push(path.join(this.homeDir, readDir, 'settings.json'))
          files.push(path.join(this.rootPath, readDir, 'settings.json'))
          files.push(path.join(this.rootPath, readDir, 'settings.local.json'))
        }
        const merged: ContextSettingsFile = { claudeMdExcludes: [] }
        for (const file of files) {
          const parsed = await readSettingsFile(file)
          if (!parsed) continue
          merged.claudeMdExcludes.push(...parsed.claudeMdExcludes)
          if (parsed.autoMemoryEnabled !== undefined) merged.autoMemoryEnabled = parsed.autoMemoryEnabled
          if (parsed.autoMemoryDirectory !== undefined) merged.autoMemoryDirectory = parsed.autoMemoryDirectory
        }
        return merged
      })()
    }
    return this.settingsPromise
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  getRules(): Promise<RuleFile[]> {
    if (!this.rulesPromise) {
      this.rulesPromise = (async () => {
        const directories: RulesDirectorySpec[] = []
        for (const readDir of this.settings.readDirs) {
          directories.push({ dir: path.join(this.homeDir, readDir, 'rules'), scope: 'user', anchorDir: this.rootPath })
        }
        for (const readDir of this.settings.readDirs) {
          directories.push({ dir: path.join(this.rootPath, readDir, 'rules'), scope: 'project', anchorDir: this.rootPath })
        }
        const rootRealPath = await fs.realpath(this.rootPath).catch(() => this.rootPath)
        return discoverRules({ directories, rootRealPath, allowExternal: false, debug: this.debug })
      })()
    }
    return this.rulesPromise
  }

  // ── Skills ─────────────────────────────────────────────────────────────────

  getSkills(): Promise<DiscoveredSkill[]> {
    if (!this.skillsPromise) {
      this.skillsPromise = discoverSkills({
        rootPath: this.rootPath,
        readDirs: this.settings.readDirs,
        homeDir: this.homeDir,
        extraPersonal: this.options.hostSkills ?? [],
        debug: this.debug,
      })
    }
    return this.skillsPromise.then(skills => markShadowed([...skills, ...this.nestedSkills.values()]))
  }

  async findSkill(name: string): Promise<DiscoveredSkill | null> {
    return findSkill(await this.getSkills(), name)
  }

  /** §5.4: the rendered body as an injection entry (reason `skill`). */
  renderSkillEntry(skill: DiscoveredSkill, rawArguments: string | null | undefined, label: string): ContextInjectionEntry {
    const text = renderSkillBody(skill, {
      rawArguments,
      sessionId: this.conversationId,
      projectDir: this.rootPath,
    })
    return { path: skill.realPath, label, text, reason: 'skill' }
  }

  /** `/name args` typed by the user → one injection entry for the user message. */
  async expandSlashInvocation(content: string): Promise<ContextInjectionEntry | null> {
    const match = matchSlashInvocation(content, await this.getSkills())
    if (!match) return null
    return this.renderSkillEntry(match.skill, match.rawArguments, `skill /${match.skill.name} invoked by the user`)
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  getAgents(): Promise<AgentDefinition[]> {
    if (!this.agentsPromise) {
      this.agentsPromise = discoverAgents({
        rootPath: this.rootPath,
        readDirs: this.settings.readDirs,
        homeDir: this.homeDir,
        debug: this.debug,
      })
    }
    return this.agentsPromise
  }

  async findAgent(name: string): Promise<AgentDefinition | null> {
    const wanted = name.trim().toLowerCase()
    if (!wanted) return null
    return (await this.getAgents()).find(agent => agent.name === wanted) ?? null
  }

  // ── Auto memory ────────────────────────────────────────────────────────────

  async getAutoMemoryDirectory(): Promise<string | null> {
    if (this.autoMemoryDirectory !== undefined) return this.autoMemoryDirectory
    if (!this.options.dataDir || this.options.autoMemoryEnabled === false || isAutoMemoryDisabled()) {
      this.autoMemoryDirectory = null
      return null
    }
    const settings = await this.getSettingsFile()
    if (settings.autoMemoryEnabled === false) {
      this.autoMemoryDirectory = null
      return null
    }
    this.autoMemoryDirectory = resolveAutoMemoryDirectory({
      dataDir: this.options.dataDir,
      rootPath: this.rootPath,
      directoryOverride: settings.autoMemoryDirectory ?? null,
      homeDir: this.homeDir,
    })
    return this.autoMemoryDirectory
  }

  // ── System prompt parts (built once per conversation, §11.5 rule 1) ────────

  async buildSystemPromptParts(): Promise<{ skillsIndex: string | null; agentsIndex: string | null; autoMemoryPrompt: string | null }> {
    const [skills, agents, memoryDir] = await Promise.all([this.getSkills(), this.getAgents(), this.getAutoMemoryDirectory()])
    return {
      skillsIndex: renderSkillIndex(skills),
      agentsIndex: renderAgentIndex(agents),
      autoMemoryPrompt: memoryDir ? buildAutoMemoryPrompt(memoryDir) : null,
    }
  }

  // ── Launch-time set (§10 step 6) ──────────────────────────────────────────

  /**
   * Managed → user → ancestor chain → local → unconditional rules (user then
   * project) → MEMORY.md. Entries whose real path is in `alreadyLoaded` are skipped.
   */
  async buildLaunchInjection(alreadyLoaded: ReadonlySet<string>, reason: 'session_start' | 'compact' = 'session_start'): Promise<LaunchInjection | null> {
    const loaded = new Set(alreadyLoaded)
    const settings = await this.getSettingsFile()
    const entries: ContextInjectionEntry[] = []

    const instructionFiles = await discoverLaunchInstructionFiles({
      rootPath: this.rootPath,
      readDirs: this.settings.readDirs,
      homeDir: this.homeDir,
      excludes: settings.claudeMdExcludes,
      loaded,
      approveExternalImports: this.options.approveExternalImports,
      debug: this.debug,
    })
    for (const file of instructionFiles) entries.push({ ...file, reason: file.reason === 'include' ? 'include' : reason })

    for (const rule of await this.getRules()) {
      if (rule.paths) continue
      if (loaded.has(rule.realPath)) continue
      if (
        settings.claudeMdExcludes.length > 0 &&
        (absolutePathMatchesAny(settings.claudeMdExcludes, rule.path) || absolutePathMatchesAny(settings.claudeMdExcludes, rule.realPath))
      ) {
        continue
      }
      loaded.add(rule.realPath)
      entries.push({ path: rule.realPath, label: rule.label, text: rule.body, reason })
    }

    const memoryDir = await this.getAutoMemoryDirectory()
    if (memoryDir) {
      const memory = await readMemoryIndex(memoryDir)
      if (memory && !loaded.has(memory.path)) {
        loaded.add(memory.path)
        entries.push(memory)
      }
    }

    if (entries.length === 0) return null
    this.options.onInstructionsLoaded?.(entries, reason)
    return {
      text: renderInstructionSet(entries),
      files: entries.map(entry => entry.path).filter(Boolean),
      entries,
      reason,
    }
  }

  // ── Lazy loads (§2.2 step 3, §3.4, §5.1 nested, §5.7) ─────────────────────

  async collectLazyInjections(toolCall: { name: string; arguments: unknown }, alreadyLoaded: ReadonlySet<string>): Promise<ContextInjectionEntry[]> {
    const touched = extractTouchedFiles(toolCall, this.rootPath, this.triggerTools)
    if (touched.length === 0) return []
    const loaded = new Set(alreadyLoaded)
    const settings = await this.getSettingsFile()
    const entries: ContextInjectionEntry[] = []
    const rootRealPath = await fs.realpath(this.rootPath).catch(() => this.rootPath)

    for (const file of touched) {
      const directories = chainBelowRoot(this.rootPath, path.dirname(file.absolutePath))

      // Nested AGENTS.md / CLAUDE.md between the root and the file.
      if (directories.length > 0) {
        const nested = await discoverNestedInstructionFiles({
          rootPath: this.rootPath,
          readDirs: this.settings.readDirs,
          homeDir: this.homeDir,
          excludes: settings.claudeMdExcludes,
          loaded,
          approveExternalImports: this.options.approveExternalImports,
          directories,
          debug: this.debug,
        })
        entries.push(...nested)
      }

      // Path-scoped rules anchored at the root.
      for (const rule of await this.getRules()) {
        if (!rule.paths || loaded.has(rule.realPath)) continue
        if (!ruleMatchesFile(rule, file.absolutePath)) continue
        loaded.add(rule.realPath)
        entries.push({ path: rule.realPath, label: rule.label, text: rule.body, reason: 'path_glob_match' })
      }

      // Nested `<dir>/<readDir>/rules` directories: unconditional ones load with the
      // directory, conditional ones when the file matches (anchored at that directory).
      if (directories.length > 0) {
        const specs: RulesDirectorySpec[] = []
        for (const directory of directories) {
          for (const readDir of this.settings.readDirs) {
            specs.push({ dir: path.join(directory, readDir, 'rules'), scope: 'nested', anchorDir: directory })
          }
        }
        const nestedRules = await discoverRules({ directories: specs, rootRealPath, allowExternal: false, debug: this.debug })
        for (const rule of nestedRules) {
          if (loaded.has(rule.realPath)) continue
          if (rule.paths && !ruleMatchesFile(rule, file.absolutePath)) continue
          loaded.add(rule.realPath)
          entries.push({
            path: rule.realPath,
            label: LABEL_PROJECT,
            text: rule.body,
            reason: rule.paths ? 'path_glob_match' : 'nested_traversal',
          })
        }
      }

      // Path-scoped skills: inject the rendered body.
      for (const skill of await this.getSkills()) {
        if (skill.shadowed || !skill.frontmatter.paths || loaded.has(skill.realPath)) continue
        if (!skillMatchesFile(skill, file.absolutePath)) continue
        loaded.add(skill.realPath)
        entries.push({
          ...this.renderSkillEntry(skill, null, `skill ${skill.name}, auto-loaded for a matching file path`),
          reason: 'path_glob_match',
        })
      }

      // Nested skills: discover, remember for `skill_manager activate`, and announce.
      for (const directory of nestedSkillDirectoriesForFile(this.rootPath, file.absolutePath)) {
        const announced: DiscoveredSkill[] = []
        for (const skill of await discoverNestedSkills({ rootPath: this.rootPath, directory, readDirs: this.settings.readDirs, debug: this.debug })) {
          if (this.nestedSkills.has(skill.realPath)) continue
          this.nestedSkills.set(skill.realPath, skill)
          announced.push(skill)
        }
        const index = renderSkillIndex(announced)
        if (index && !loaded.has(`${directory}::skills`)) {
          loaded.add(`${directory}::skills`)
          entries.push({ path: `${directory}::skills`, label: 'additional skills discovered in this directory', text: index, reason: 'nested_traversal' })
        }
      }
    }

    if (entries.length > 0) this.options.onInstructionsLoaded?.(entries, 'nested_traversal')
    return entries
  }

  // ── Compaction (§2.6, §5.4) ───────────────────────────────────────────────

  /**
   * After a compaction summary replaces the history: re-read the launch set from
   * disk and re-attach the most recent invocation of each skill within budget
   * (5,000 tokens per skill, 25,000 combined, oldest dropped first).
   */
  async buildPostCompactionInjection(historyBeforeCompaction: ReadonlyArray<unknown>): Promise<LaunchInjection | null> {
    const launch = await this.buildLaunchInjection(new Set(), 'compact')
    const entries: ContextInjectionEntry[] = launch ? [...launch.entries] : []

    const invoked = Array.from(collectInvokedSkillEntries(historyBeforeCompaction).values()).reverse()
    let budget = SKILL_REATTACH_TOTAL_CHARS
    const reattached: ContextInjectionEntry[] = []
    for (const entry of invoked) {
      if (budget <= 0) break
      const text = entry.text.length > SKILL_REATTACH_PER_SKILL_CHARS ? entry.text.slice(0, SKILL_REATTACH_PER_SKILL_CHARS) : entry.text
      if (text.length > budget) break
      budget -= text.length
      reattached.unshift({ ...entry, text, reason: 'compact' })
    }
    entries.push(...reattached)

    if (entries.length === 0) return null
    return {
      text: renderInstructionSet(entries),
      files: entries.map(entry => entry.path).filter(Boolean),
      entries,
      reason: 'compact',
    }
  }
}

export function createConversationContextLoader(options: ConversationContextLoaderOptions): ConversationContextLoader {
  return new ConversationContextLoader(options)
}
