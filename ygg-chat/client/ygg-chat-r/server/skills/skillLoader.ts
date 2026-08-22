// server/skills/skillLoader.ts
// Discovery, parsing, and validation of Agent Skills

import fs from 'fs/promises'
import path from 'path'
import { tryGetServerConfig } from '../serverHost.js'
import { normalizeSkillName, parseSkillManifest } from './skillManifest.js'

const SKILLS_DIR_NAME = 'skills'
const SKILL_FILE = 'SKILL.md'
const META_FILE = '.skill-meta.json'
const SKILLS_GUIDE_FILE = 'SKILLS_GUIDE.md'

export interface SkillDefinition {
  // From SKILL.md frontmatter (required)
  name: string // Runtime activation key, lowercase + hyphens only
  displayName?: string // Original manifest name when normalization changed it
  description: string // Max 1024 chars, used for AI to decide relevance

  // From SKILL.md frontmatter (optional)
  license?: string
  compatibility?: string // Environment requirements
  metadata?: Record<string, string> // Arbitrary key-value pairs
  allowedTools?: string[] // Pre-approved tools (experimental)

  // Computed by loader
  sourcePath: string // Absolute path to skill directory
  bodyContent: string // Markdown content after frontmatter
  hasScripts: boolean // scripts/ directory exists
  hasReferences: boolean // references/ directory exists
  hasAssets: boolean // assets/ directory exists
  enabled: boolean // User can disable skills
  installedAt: string // ISO timestamp
  installedFrom?: string // GitHub source or 'local'
}

export interface SkillSummary {
  name: string
  displayName?: string
  description: string
  enabled: boolean
}

export interface SkillResource {
  path: string // Relative path within skill (e.g., "references/FORMS.md")
  content: string // File content
  type: 'script' | 'reference' | 'asset'
}

export interface SkillMetadata {
  installedAt: string // ISO timestamp
  installedFrom: string // "github:anthropics/skills/skills/code-review" or "local"
  version?: string // From metadata.version if present
  displayName?: string // Original manifest name when normalized for runtime use
  enabled: boolean
}

// Cached base directory
let cachedBaseDir: string | null = null

function resolveBaseDir(): string {
  if (cachedBaseDir) {
    return cachedBaseDir
  }

  // Check environment variable override first
  const envOverride = process.env.YGG_SKILLS_DIRECTORY?.trim()
  if (envOverride) {
    cachedBaseDir = path.resolve(envOverride)
    return cachedBaseDir
  }

  // Injected host data directory (Electron userData or standalone YGG_DATA_DIR).
  const hostDataDir = tryGetServerConfig()?.dataDir
  if (hostDataDir) {
    cachedBaseDir = hostDataDir
    return cachedBaseDir
  }

  // Not cached: the host context may be configured after an early call.
  return path.resolve(process.cwd(), '.ygg-chat-r')
}

class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map()
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Get the skills directory path
   */
  getSkillsDirectory(): string {
    return path.join(resolveBaseDir(), SKILLS_DIR_NAME)
  }

  /**
   * Initialize the registry - scan and load all skills
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInitialize()
    await this.initPromise
    this.initPromise = null
  }

  private async _doInitialize(): Promise<void> {
    const skillsDir = this.getSkillsDirectory()
    // console.log('[SkillLoader] Initializing skills from:', skillsDir)

    // Ensure directory exists
    await fs.mkdir(skillsDir, { recursive: true })

    // Seed guide file if not exists
    await this.ensureGuideFile()

    // Load all skills
    await this.loadAllSkills()

    this.initialized = true
    // console.log(`[SkillLoader] Initialized ${this.skills.size} skills`)
  }

  private async ensureGuideFile(): Promise<void> {
    const targetPath = path.join(this.getSkillsDirectory(), SKILLS_GUIDE_FILE)

    try {
      await fs.access(targetPath)
      return // Already exists
    } catch {
      // Create default guide
      const guideContent = `# Ygg-Chat Skills

Skills are folders containing instructions that teach the AI how to perform specialized tasks.

## Installing Skills

Use the Skills settings panel in the app to:
- Browse and install skills from GitHub
- Import local skill folders
- Enable/disable installed skills

## Creating Your Own Skills

Each skill is a folder containing at minimum a \`SKILL.md\` file:

\`\`\`
my-skill/
├── SKILL.md          # Required - instructions and metadata
├── scripts/          # Optional - executable scripts
├── references/       # Optional - additional documentation
└── assets/           # Optional - templates, images, data files
\`\`\`

### SKILL.md Format

\`\`\`markdown
---
name: my-skill
description: A clear description of what this skill does and when to use it.
---

# My Skill Instructions

Step-by-step instructions for the AI to follow...
\`\`\`

## Learn More

- Agent Skills Specification: https://agentskills.io/specification
- Official Skills Repository: https://github.com/anthropics/skills
`
      await fs.writeFile(targetPath, guideContent, 'utf-8')
    }
  }

  private async loadAllSkills(): Promise<void> {
    this.skills.clear()
    const skillsDir = this.getSkillsDirectory()

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await this.loadSkillOrGroup(entry.name)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[SkillLoader] Error scanning skills directory:', error)
      }
    }
  }

  private async loadSkillOrGroup(skillDirName: string): Promise<void> {
    const skillPath = path.join(this.getSkillsDirectory(), skillDirName)

    if (await this.fileExists(path.join(skillPath, SKILL_FILE))) {
      await this.loadSkillAtPath(skillDirName, skillPath)
      return
    }

    try {
      const entries = await fs.readdir(skillPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const nestedSkillPath = path.join(skillPath, entry.name)
          if (await this.fileExists(path.join(nestedSkillPath, SKILL_FILE))) {
            await this.loadSkillAtPath(`${skillDirName}/${entry.name}`, nestedSkillPath)
          }
        }
      }
    } catch (error) {
      console.warn(`[SkillLoader] Failed to scan skill group ${skillDirName}:`, error)
    }
  }

  private async loadSkillAtPath(skillDirName: string, skillPath: string): Promise<void> {
    const skillFilePath = path.join(skillPath, SKILL_FILE)
    const metaFilePath = path.join(skillPath, META_FILE)

    try {
      const skillContent = await fs.readFile(skillFilePath, 'utf-8')
      const manifest = parseSkillManifest(skillContent)
      const runtimeName = manifest.runtimeName
      const frontmatter = manifest.frontmatter

      const directoryName = path.basename(skillPath)
      let normalizedDirectoryName: string | null = null
      try {
        normalizedDirectoryName = normalizeSkillName(directoryName)
      } catch {
        // Legacy folders can contain names that are not valid skill identifiers.
      }
      if (runtimeName !== normalizedDirectoryName) {
        console.warn(`[SkillLoader] Skill name "${runtimeName}" doesn't match directory "${skillDirName}"`)
      }

      // Check for optional directories
      const hasScripts = await this.directoryExists(path.join(skillPath, 'scripts'))
      const hasReferences = await this.directoryExists(path.join(skillPath, 'references'))
      const hasAssets = await this.directoryExists(path.join(skillPath, 'assets'))

      // Load metadata if exists
      let meta: Partial<SkillMetadata> = { enabled: true }
      try {
        const metaContent = await fs.readFile(metaFilePath, 'utf-8')
        meta = JSON.parse(metaContent)
      } catch {
        // No metadata file, use defaults
      }

      // Build definition
      const displayName = meta.displayName || (manifest.name !== runtimeName ? manifest.name : undefined)
      const allowedToolsValue = frontmatter['allowed-tools']
      const definition: SkillDefinition = {
        name: runtimeName,
        displayName,
        description: manifest.description,
        license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
        compatibility: typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : undefined,
        metadata:
          frontmatter.metadata && typeof frontmatter.metadata === 'object' && !Array.isArray(frontmatter.metadata)
            ? (frontmatter.metadata as Record<string, string>)
            : undefined,
        allowedTools: typeof allowedToolsValue === 'string' ? allowedToolsValue.split(' ').filter(Boolean) : undefined,
        sourcePath: skillPath,
        bodyContent: manifest.bodyContent,
        hasScripts,
        hasReferences,
        hasAssets,
        enabled: meta.enabled !== false,
        installedAt: meta.installedAt || new Date().toISOString(),
        installedFrom: meta.installedFrom,
      }

      const existing = this.skills.get(runtimeName)
      if (existing) {
        console.warn(
          `[SkillLoader] Duplicate skill name "${runtimeName}" in ${skillDirName}; already loaded from ${existing.sourcePath}`
        )
        return
      }

      this.skills.set(runtimeName, definition)
      // console.log(`[SkillLoader] Loaded skill: ${runtimeName}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[SkillLoader] No SKILL.md found in ${skillDirName}`)
      } else {
        console.warn(`[SkillLoader] Failed to load skill ${skillDirName}:`, error)
      }
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath)
      return stat.isFile()
    } catch {
      return false
    }
  }

  /**
   * Get all skill summaries (for listing)
   */
  getSummaries(): SkillSummary[] {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      enabled: s.enabled,
    }))
  }

  /**
   * Get full skill definition (for activation)
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * Check if skill exists
   */
  hasSkill(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * Get all enabled skills
   */
  getEnabledSkills(): SkillDefinition[] {
    return Array.from(this.skills.values()).filter(s => s.enabled)
  }

  /**
   * Enable/disable a skill
   */
  async setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
    const skill = this.skills.get(name)
    if (!skill) return false

    skill.enabled = enabled

    // Persist to metadata file
    const metaPath = path.join(skill.sourcePath, META_FILE)
    const meta: SkillMetadata = {
      installedAt: skill.installedAt,
      installedFrom: skill.installedFrom || 'local',
      displayName: skill.displayName,
      enabled,
    }

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    return true
  }

  /**
   * Load a resource file from a skill
   */
  async loadResource(skillName: string, resourcePath: string): Promise<SkillResource | null> {
    const skill = this.skills.get(skillName)
    if (!skill) return null

    // Security: prevent path traversal
    const normalizedPath = path.normalize(resourcePath)
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      console.warn(`[SkillLoader] Invalid resource path: ${resourcePath}`)
      return null
    }

    const fullPath = path.join(skill.sourcePath, normalizedPath)

    // Ensure path is within skill directory
    if (!fullPath.startsWith(skill.sourcePath)) {
      console.warn(`[SkillLoader] Resource path escapes skill directory: ${resourcePath}`)
      return null
    }

    try {
      const content = await fs.readFile(fullPath, 'utf-8')

      // Determine type based on path
      let type: 'script' | 'reference' | 'asset' = 'asset'
      if (normalizedPath.startsWith('scripts/')) type = 'script'
      else if (normalizedPath.startsWith('references/')) type = 'reference'

      return { path: resourcePath, content, type }
    } catch {
      return null
    }
  }

  /**
   * Reload all skills
   */
  async reload(): Promise<void> {
    // console.log('[SkillLoader] Reloading skills...')
    this.initialized = false
    await this.initialize()
  }

  /**
   * Uninstall a skill
   */
  async uninstallSkill(name: string): Promise<boolean> {
    const skill = this.skills.get(name)
    if (!skill) return false

    try {
      await fs.rm(skill.sourcePath, { recursive: true, force: true })
      this.skills.delete(name)
      return true
    } catch (error) {
      console.error(`[SkillLoader] Failed to uninstall skill ${name}:`, error)
      return false
    }
  }

  /**
   * Get count of loaded skills
   */
  getSkillCount(): number {
    return this.skills.size
  }
}

// Singleton export
export const skillRegistry = new SkillRegistry()
