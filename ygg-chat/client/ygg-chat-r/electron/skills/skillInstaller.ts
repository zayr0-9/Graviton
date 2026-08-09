// electron/skills/skillInstaller.ts
// Install skills from GitHub, ClawdHub, or local folders

import AdmZip from 'adm-zip'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'fs/promises'
import path from 'path'
import { promisify } from 'node:util'
import yaml from 'yaml'
import { getNativeShellPath } from '../tools/nativeShell.js'
import { skillRegistry } from './skillLoader.js'
import { parseSkillManifest, serializeSkillManifest } from './skillManifest.js'

const execFile = promisify(execFileCallback)

interface GitHubContent {
  name: string
  type: 'file' | 'dir'
  download_url: string | null
}

export interface SkillInstallCandidate {
  name: string
  path: string
  url: string
}

interface GitHubSourceParts {
  owner: string
  repo: string
  repoPath: string
  ref?: string
  cloneUrl: string
}

interface LocalSkillCandidate extends SkillInstallCandidate {
  sourcePath: string
}

interface SkillValidation {
  valid: boolean
  name?: string
  displayName?: string
  error?: string
}

export interface InstallResult {
  success: boolean
  skillName?: string
  skillNames?: string[]
  displayName?: string
  displayNames?: string[]
  error?: string
  code?: 'MULTIPLE_SKILLS_FOUND' | 'NO_SKILLS_FOUND' | 'INVALID_SOURCE' | 'INSTALL_FAILED'
  candidates?: SkillInstallCandidate[]
}

interface CatalogSkill {
  name: string
  description: string
  path: string // Path within repo (e.g., "skills/code-review")
}

const GITHUB_API_BASE = 'https://api.github.com'
const USER_AGENT = 'ygg-chat-electron'
const GITHUB_API_MIN_INTERVAL_MS = process.env.VITEST ? 0 : 750
const GIT_CLONE_TIMEOUT_MS = 120_000
const GIT_CLONE_MAX_BUFFER = 1024 * 1024

let lastGitHubApiRequestAt = 0

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForGitHubApiSlot(): Promise<void> {
  const now = Date.now()
  const waitMs = Math.max(0, lastGitHubApiRequestAt + GITHUB_API_MIN_INTERVAL_MS - now)
  if (waitMs > 0) {
    await delay(waitMs)
  }
  lastGitHubApiRequestAt = Date.now()
}

/**
 * Fetch JSON from GitHub API
 */
async function fetchGitHubAPI(url: string): Promise<any> {
  await waitForGitHubApiSlot()

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Repository or path not found')
    }
    if (response.status === 403) {
      throw new Error('GitHub API rate limit exceeded. Try again later.')
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

/**
 * Download a file from URL
 */
async function downloadFile(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`)
  }

  return response.text()
}

/**
 * Parse a GitHub repository, HTTPS clone URL, shorthand, or tree URL.
 */
export function parseGitHubSource(source: string): GitHubSourceParts {
  const trimmed = source.trim().replace(/\/$/, '')
  let owner: string
  let repoWithSuffix: string
  let repoPath = ''
  let ref: string | undefined

  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') {
      throw new Error('Invalid GitHub URL. Use an HTTPS GitHub repository URL')
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    owner = parts[0]
    repoWithSuffix = parts[1]
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length >= 4) {
      ref = parts[3]
      repoPath = parts.slice(4).join('/')
    } else if (parts.length > 2) {
      throw new Error('Invalid GitHub URL. Use a repository URL or /tree/<ref>/<path> skill folder URL')
    }
  } else {
    const parts = trimmed.split('/').filter(Boolean)
    if (parts.length < 2) {
      throw new Error('Invalid source format. Use "owner/repo" or "owner/repo/path"')
    }
    ;[owner, repoWithSuffix] = parts
    repoPath = parts.slice(2).join('/')
  }

  const repo = repoWithSuffix.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('Invalid GitHub source. Expected https://github.com/owner/repo.git')
  }

  return {
    owner,
    repo,
    repoPath,
    ref,
    cloneUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
  }
}

function buildGitHubTreeUrl(parts: GitHubSourceParts, repoPath: string): string {
  const encodedPath = repoPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return `https://github.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/tree/${encodeURIComponent(parts.ref || 'main')}/${encodedPath}`
}

async function runGitClone(parts: GitHubSourceParts, targetDir: string): Promise<void> {
  const args = ['clone', '--depth', '1', '--single-branch']
  if (parts.ref) {
    args.push('--branch', parts.ref)
  }
  args.push('--', parts.cloneUrl, targetDir)

  const nativePath = await getNativeShellPath()
  try {
    await execFile('git', args, {
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: GIT_CLONE_MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        ...(nativePath ? { PATH: nativePath } : {}),
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    })
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & { stderr?: string }
    if (gitError.code === 'ENOENT') {
      throw new Error('Git is required to install skills from GitHub. Install Git and try again.')
    }
    const detail = String(gitError.stderr || gitError.message || '').trim().split(/\r?\n/).pop()
    throw new Error(`Failed to clone GitHub repository${detail ? `: ${detail}` : ''}`)
  }
}

async function hasSkillManifest(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dirPath, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

async function findDirectSkillCandidates(
  parts: GitHubSourceParts,
  baseDir: string,
  relativeBase: string
): Promise<LocalSkillCandidate[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true })
  const candidates: LocalSkillCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const sourcePath = path.join(baseDir, entry.name)
    if (!(await hasSkillManifest(sourcePath))) continue
    const candidatePath = path.posix.join(relativeBase, entry.name)
    candidates.push({
      name: entry.name,
      path: candidatePath,
      url: buildGitHubTreeUrl(parts, candidatePath),
      sourcePath,
    })
  }
  return candidates
}

async function discoverGitHubSkills(
  parts: GitHubSourceParts,
  cloneDir: string
): Promise<{ singleSkillPath?: string; candidates: LocalSkillCandidate[] }> {
  const requestedPath = path.resolve(cloneDir, parts.repoPath || '.')
  const relative = path.relative(cloneDir, requestedPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('GitHub skill path escapes the repository')
  }

  let requestedStat
  try {
    requestedStat = await fs.stat(requestedPath)
  } catch {
    throw new Error('Repository path not found')
  }
  if (!requestedStat.isDirectory()) {
    throw new Error('GitHub skill path must be a directory containing SKILL.md')
  }

  if (await hasSkillManifest(requestedPath)) {
    return { singleSkillPath: requestedPath, candidates: [] }
  }

  let candidates = await findDirectSkillCandidates(parts, requestedPath, parts.repoPath)
  if (!parts.repoPath && candidates.length === 0) {
    const skillsPath = path.join(requestedPath, 'skills')
    try {
      if ((await fs.stat(skillsPath)).isDirectory()) {
        candidates = await findDirectSkillCandidates(parts, skillsPath, 'skills')
      }
    } catch {
      // No conventional top-level skills directory.
    }
  }

  return { candidates }
}

function multipleSkillsFound(candidates: LocalSkillCandidate[]): InstallResult {
  const publicCandidates = candidates.map(({ sourcePath: _sourcePath, ...candidate }) => candidate)
  return {
    success: false,
    code: 'MULTIPLE_SKILLS_FOUND',
    candidates: publicCandidates,
    error: `Multiple skills found: ${publicCandidates.map(candidate => candidate.name).join(', ')}. Choose a specific skill or install all skills.`,
  }
}

async function withClonedGitHubRepository<T>(parts: GitHubSourceParts, callback: (cloneDir: string) => Promise<T>): Promise<T> {
  const skillsDir = skillRegistry.getSkillsDirectory()
  await fs.mkdir(skillsDir, { recursive: true })
  const cloneDir = path.join(skillsDir, `.cloning-${parts.repo}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    await runGitClone(parts, cloneDir)
    return await callback(cloneDir)
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true })
  }
}

/** Validate and normalize a staged skill manifest. */
async function validateSkillDirectory(dirPath: string, rewriteManifest = false): Promise<SkillValidation> {
  const skillMdPath = path.join(dirPath, 'SKILL.md')

  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    const manifest = parseSkillManifest(content)
    if (rewriteManifest && manifest.name !== manifest.runtimeName) {
      await fs.writeFile(skillMdPath, serializeSkillManifest(manifest), 'utf-8')
    }
    return {
      valid: true,
      name: manifest.runtimeName,
      displayName: manifest.name !== manifest.runtimeName ? manifest.name : undefined,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: false, error: 'No SKILL.md found in directory' }
    }
    return { valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function writeSkillMetadata(
  skillPath: string,
  installedFrom: string,
  displayName?: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await fs.writeFile(
    path.join(skillPath, '.skill-meta.json'),
    JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        installedFrom,
        ...(displayName ? { displayName } : {}),
        enabled: true,
        ...extra,
      },
      null,
      2
    ),
    'utf-8'
  )
}

async function reloadAndVerify(skillNames: string[]): Promise<void> {
  await skillRegistry.reload()
  const missing = skillNames.filter(name => !skillRegistry.hasSkill(name))
  if (missing.length > 0) {
    throw new Error(`Installed skill was not loaded by the registry: ${missing.join(', ')}`)
  }
}

/** Install one skill from a GitHub repository clone. */
export async function installFromGitHub(source: string): Promise<InstallResult> {
  try {
    const parts = parseGitHubSource(source)
    return await withClonedGitHubRepository(parts, async cloneDir => {
      const discovery = await discoverGitHubSkills(parts, cloneDir)
      if (discovery.singleSkillPath) {
        return installSingleSkillFromDirectory(discovery.singleSkillPath, `github:${source}`)
      }
      if (discovery.candidates.length === 1) {
        return installSingleSkillFromDirectory(discovery.candidates[0].sourcePath, `github:${source}`)
      }
      if (discovery.candidates.length > 1) {
        return multipleSkillsFound(discovery.candidates)
      }
      return {
        success: false,
        code: 'NO_SKILLS_FOUND',
        error:
          'No skills found at this location. GitHub skills must be folders containing SKILL.md, for example https://github.com/owner/repo/tree/main/skills/skill-name',
      }
    })
  } catch (error) {
    return {
      success: false,
      code: 'INSTALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function installAllFromGitHub(source: string): Promise<InstallResult> {
  try {
    const parts = parseGitHubSource(source)
    return await withClonedGitHubRepository(parts, async cloneDir => {
      const discovery = await discoverGitHubSkills(parts, cloneDir)
      if (discovery.singleSkillPath) {
        return installSingleSkillFromDirectory(discovery.singleSkillPath, `github:${source}`)
      }
      if (discovery.candidates.length === 0) {
        return {
          success: false,
          code: 'NO_SKILLS_FOUND',
          error: 'No skills found to install from this GitHub location',
        }
      }
      return installSkillGroupFromDirectories(parts.repo, source, discovery.candidates)
    })
  } catch (error) {
    return {
      success: false,
      code: 'INSTALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function installSingleSkillFromDirectory(sourcePath: string, installedFrom: string): Promise<InstallResult> {
  const skillsDir = skillRegistry.getSkillsDirectory()
  const stagingDir = path.join(skillsDir, `.installing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  let targetDir: string | null = null
  let moved = false

  try {
    await copyDirectory(sourcePath, stagingDir, new Set(['.git']))
    const validation = await validateSkillDirectory(stagingDir, true)
    if (!validation.valid || !validation.name) {
      return { success: false, code: 'INSTALL_FAILED', error: validation.error || 'Invalid skill manifest' }
    }

    targetDir = path.join(skillsDir, validation.name)
    if (await directoryExists(targetDir) || skillRegistry.hasSkill(validation.name)) {
      return { success: false, code: 'INSTALL_FAILED', error: `Skill "${validation.name}" is already installed` }
    }

    await writeSkillMetadata(stagingDir, installedFrom, validation.displayName)
    await fs.rename(stagingDir, targetDir)
    moved = true
    await reloadAndVerify([validation.name])

    return {
      success: true,
      skillName: validation.name,
      displayName: validation.displayName,
    }
  } catch (error) {
    if (moved && targetDir) {
      await fs.rm(targetDir, { recursive: true, force: true })
      try {
        await skillRegistry.reload()
      } catch {}
    }
    return {
      success: false,
      code: 'INSTALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true })
  }
}

async function installSkillGroupFromDirectories(
  groupName: string,
  source: string,
  candidates: LocalSkillCandidate[]
): Promise<InstallResult> {
  const skillsDir = skillRegistry.getSkillsDirectory()
  const targetDir = path.join(skillsDir, groupName)
  const stagingDir = path.join(skillsDir, `.installing-${groupName}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const installedSkillNames: string[] = []
  const displayNames: string[] = []
  let moved = false

  try {
    if (await directoryExists(targetDir)) {
      return { success: false, code: 'INSTALL_FAILED', error: `Skill group "${groupName}" is already installed` }
    }
    await fs.mkdir(stagingDir, { recursive: true })

    const runtimeNames = new Set<string>()
    for (const candidate of candidates) {
      const candidateStagingDir = path.join(stagingDir, `.candidate-${installedSkillNames.length}`)
      await copyDirectory(candidate.sourcePath, candidateStagingDir, new Set(['.git']))
      const validation = await validateSkillDirectory(candidateStagingDir, true)
      if (!validation.valid || !validation.name) {
        throw new Error(`${candidate.name}: ${validation.error || 'Invalid skill manifest'}`)
      }
      if (runtimeNames.has(validation.name) || skillRegistry.hasSkill(validation.name)) {
        throw new Error(`Duplicate normalized skill name "${validation.name}"`)
      }
      runtimeNames.add(validation.name)

      const finalStagedPath = path.join(stagingDir, validation.name)
      await fs.rename(candidateStagingDir, finalStagedPath)
      await writeSkillMetadata(finalStagedPath, `github-group:${source}`, validation.displayName, { group: groupName })
      installedSkillNames.push(validation.name)
      displayNames.push(validation.displayName || validation.name)
    }

    await fs.rename(stagingDir, targetDir)
    moved = true
    await reloadAndVerify(installedSkillNames)

    return {
      success: true,
      skillName: groupName,
      skillNames: installedSkillNames,
      displayNames,
    }
  } catch (error) {
    if (moved) {
      await fs.rm(targetDir, { recursive: true, force: true })
      try {
        await skillRegistry.reload()
      } catch {}
    }
    return {
      success: false,
      code: 'INSTALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true })
  }
}

/** Install a skill from a local folder using the same staging and verification path. */
export async function installFromLocal(sourcePath: string): Promise<InstallResult> {
  return installSingleSkillFromDirectory(sourcePath, 'local')
}

/**
 * Fetch catalog of available skills from anthropics/skills repo
 */
export async function fetchSkillsCatalog(): Promise<CatalogSkill[]> {
  try {
    // Fetch the skills directory from anthropics/skills
    const apiUrl = `${GITHUB_API_BASE}/repos/anthropics/skills/contents/skills`
    const contents = await fetchGitHubAPI(apiUrl)

    const skills: CatalogSkill[] = []

    for (const item of contents) {
      if (item.type !== 'dir') continue

      // Fetch SKILL.md to get description
      try {
        const skillMdUrl = `${GITHUB_API_BASE}/repos/anthropics/skills/contents/skills/${item.name}/SKILL.md`
        const skillMdMeta = await fetchGitHubAPI(skillMdUrl)

        if (skillMdMeta.download_url) {
          const content = await downloadFile(skillMdMeta.download_url)
          const match = content.match(/^---\n([\s\S]*?)\n---/)

          if (match) {
            const frontmatter = yaml.parse(match[1])

            skills.push({
              name: frontmatter.name || item.name,
              description: frontmatter.description || 'No description',
              path: `skills/${item.name}`,
            })
          }
        }
      } catch {
        // Skip skills that fail to parse
      }
    }

    return skills
  } catch (error) {
    console.error('[SkillInstaller] Failed to fetch catalog:', error)
    return []
  }
}

// ============================================================================
// ClawdHub Installation
// ============================================================================

const CLAWDHUB_DOWNLOAD_BASE = 'https://auth.clawdhub.com/api/v1/download'

/**
 * Parse ClawdHub page URL to extract slug
 * https://clawdhub.com/owner/slug -> slug
 */
function parseClawdHubUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/clawdhub\.com\/[^\/]+\/([^\/\?\#]+)/)
  return match ? match[1] : null
}

/**
 * Check if URL is a ClawdHub page URL
 */
export function isClawdHubUrl(url: string): boolean {
  return /^https?:\/\/clawdhub\.com\/[^\/]+\/[^\/]+/.test(url)
}

/**
 * Download a zip file from URL and return as Buffer
 */
async function downloadZipFile(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })

  if (!response.ok) {
    throw new Error(`Failed to download zip: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Install a skill from a zip URL (generic)
 */
export async function installFromZipUrl(zipUrl: string, sourceLabel: string): Promise<InstallResult> {
  const skillsDir = skillRegistry.getSkillsDirectory()
  const extractionDir = path.join(skillsDir, `.extracting-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  try {
    const zipBuffer = await downloadZipFile(zipUrl)
    const zip = new AdmZip(zipBuffer)
    zip.extractAllTo(extractionDir, true)

    const entries = await fs.readdir(extractionDir, { withFileTypes: true })
    const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    const files = entries.filter(entry => entry.isFile())
    const skillSourceDir = dirs.length === 1 && files.length === 0 ? path.join(extractionDir, dirs[0].name) : extractionDir
    return await installSingleSkillFromDirectory(skillSourceDir, sourceLabel)
  } catch (error) {
    return {
      success: false,
      code: 'INSTALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await fs.rm(extractionDir, { recursive: true, force: true })
  }
}

/**
 * Install a skill from ClawdHub page URL
 * https://clawdhub.com/owner/slug -> downloads from auth.clawdhub.com/api/v1/download?slug=slug
 */
export async function installFromClawdHub(pageUrl: string): Promise<InstallResult> {
  const slug = parseClawdHubUrl(pageUrl)
  if (!slug) {
    return { success: false, error: 'Invalid ClawdHub URL. Expected format: https://clawdhub.com/owner/skill-slug' }
  }

  const downloadUrl = `${CLAWDHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`
  console.log(`[SkillInstaller] ClawdHub URL detected. Slug: ${slug}, Download URL: ${downloadUrl}`)

  return installFromZipUrl(downloadUrl, `clawdhub:${slug}`)
}

/**
 * Install from any URL - auto-detects source type
 */
export async function installFromUrl(url: string): Promise<InstallResult> {
  // ClawdHub page URL
  if (isClawdHubUrl(url)) {
    return installFromClawdHub(url)
  }

  // GitHub repository or HTTPS clone URL
  if (/^https?:\/\/github\.com\//i.test(url)) {
    return installFromGitHub(url)
  }

  // Direct zip URL (fallback)
  if (url.endsWith('.zip') || url.includes('/download')) {
    return installFromZipUrl(url, `url:${url}`)
  }

  return {
    success: false,
    error: 'Unsupported URL format. Supported: ClawdHub page URLs, GitHub URLs, or direct zip URLs',
  }
}

// ============================================================================
// Helper functions
// ============================================================================

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function copyDirectory(src: string, dest: string, excludedNames: Set<string> = new Set()): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill contains unsupported symbolic link: ${entry.name}`)
    }

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, excludedNames)
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
