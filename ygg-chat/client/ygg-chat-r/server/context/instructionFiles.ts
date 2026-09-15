// server/context/instructionFiles.ts
// Discovery of AGENTS.md / CLAUDE.md instruction files and their `@path` imports
// (docs/claude_code_context_loading_rules.md §2, §2.7).

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  LABEL_LOCAL,
  LABEL_PROJECT,
  LABEL_USER_GLOBAL,
  type ContextInjectionEntry,
  type ContextInjectionReason,
} from '../../../../shared/contextInjection.js'
import { stripHtmlComments } from './frontmatter.js'
import { absolutePathMatchesAny } from './globMatcher.js'

/** §1 "Size": a CLAUDE.md file over 4 MiB is skipped. */
export const MAX_INSTRUCTION_FILE_BYTES = 4 * 1024 * 1024
/** §2.3 "Recursion": imported files may import, four hops deep. */
export const MAX_IMPORT_DEPTH = 4

export type InstructionScope = 'user' | 'project' | 'local'

export interface InstructionFileEntry extends ContextInjectionEntry {
  scope: InstructionScope
  /** The file that imported this one (absolute path), for `include` entries. */
  importedFrom?: string
}

export type ContextDebugLogger = (message: string, detail?: unknown) => void

export interface InstructionDiscoveryOptions {
  /** Conversation root (project directory). */
  rootPath: string
  /** User-scope config directory names (§11.3 decision 9): `~/<readDir>/AGENTS.md` … */
  readDirs: readonly string[]
  homeDir?: string
  /** `claudeMdExcludes`-style absolute-path globs (§2.5). */
  excludes?: readonly string[]
  /** Real paths already delivered on this branch; entries for them are skipped and the set is extended. */
  loaded: Set<string>
  /**
   * §2.3 "External imports": an import from a project-level file that resolves
   * outside the root needs approval. Absent => external imports are skipped.
   */
  approveExternalImports?: (paths: string[]) => Promise<boolean>
  debug?: ContextDebugLogger
}

interface DirectoryCandidate {
  file: string
  scope: InstructionScope
}

const noopDebug: ContextDebugLogger = () => {}

export function labelForScope(scope: InstructionScope): string {
  if (scope === 'user') return LABEL_USER_GLOBAL
  if (scope === 'local') return LABEL_LOCAL
  return LABEL_PROJECT
}

async function statFile(filePath: string): Promise<{ size: number } | null> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() ? { size: stat.size } : null
  } catch {
    return null
  }
}

async function realpathSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath)
  } catch {
    return null
  }
}

export function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * §2.7 rule 1 and 2: the ordered filename set for one directory.
 * `CLAUDE.md` and `.claude/CLAUDE.md`: the docs say "either"; Graviton reads
 * `CLAUDE.md` and falls back to `.claude/CLAUDE.md` only when the first is absent.
 */
export async function listDirectoryInstructionCandidates(directory: string): Promise<DirectoryCandidate[]> {
  const candidates: DirectoryCandidate[] = []
  const agents = path.join(directory, 'AGENTS.md')
  const claude = path.join(directory, 'CLAUDE.md')
  const claudeNested = path.join(directory, '.claude', 'CLAUDE.md')
  const agentsLocal = path.join(directory, 'AGENTS.local.md')
  const claudeLocal = path.join(directory, 'CLAUDE.local.md')

  if (await statFile(agents)) candidates.push({ file: agents, scope: 'project' })
  if (await statFile(claude)) candidates.push({ file: claude, scope: 'project' })
  else if (await statFile(claudeNested)) candidates.push({ file: claudeNested, scope: 'project' })
  if (await statFile(agentsLocal)) candidates.push({ file: agentsLocal, scope: 'local' })
  if (await statFile(claudeLocal)) candidates.push({ file: claudeLocal, scope: 'local' })
  return candidates
}

/** Every directory from the filesystem root down to (and including) `target`. */
export function ancestorChain(target: string): string[] {
  const resolved = path.resolve(target)
  const chain: string[] = []
  let cursor = resolved
  for (;;) {
    chain.unshift(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return chain
}

/** Directories strictly below `root` down to and including `directory`. */
export function chainBelowRoot(root: string, directory: string): string[] {
  const resolvedRoot = path.resolve(root)
  const resolvedDir = path.resolve(directory)
  if (!isInsideDirectory(resolvedDir, resolvedRoot) || resolvedDir === resolvedRoot) return []
  const chain: string[] = []
  let cursor = resolvedDir
  while (cursor !== resolvedRoot) {
    chain.unshift(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return chain
}

/**
 * Find `@path` import tokens outside code spans and fenced code blocks (§2.3).
 * Returns the raw path text of each token in document order.
 */
export function extractImportTokens(markdown: string): string[] {
  // Blank out fenced blocks and inline code spans, preserving offsets is unnecessary
  // because only the token text is used.
  const withoutFences = markdown.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, '$1')
  const withoutSpans = withoutFences.replace(/`[^`\n]*`/g, ' ')
  const tokens: string[] = []
  const pattern = /(^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s`'"<>()[\]{}]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutSpans)) !== null) {
    let token = match[2].replace(/[.,;:!?]+$/, '')
    if (!token || token.includes('@')) continue
    // A bare word such as `@mentions` or `@types/node` is a valid relative path in
    // Claude Code; only existence decides. Keep it.
    token = token.trim()
    if (token) tokens.push(token)
  }
  return tokens
}

export function resolveImportPath(token: string, fromFile: string, homeDir: string): string {
  if (token.startsWith('~/')) return path.join(homeDir, token.slice(2))
  if (path.isAbsolute(token)) return token
  return path.resolve(path.dirname(fromFile), token)
}

interface LoadContext extends InstructionDiscoveryOptions {
  homeDir: string
  rootRealPath: string
  debug: ContextDebugLogger
  /** Externals encountered from project/local files, awaiting one approval. */
  pendingExternal: Array<{ file: string; scope: InstructionScope; importedFrom: string; depth: number }>
  externalApproved: boolean
}

async function readInstructionEntry(
  ctx: LoadContext,
  file: string,
  scope: InstructionScope,
  reason: ContextInjectionReason,
  importedFrom?: string
): Promise<InstructionFileEntry | null> {
  const realPath = await realpathSafe(file)
  if (!realPath) return null
  if (ctx.loaded.has(realPath)) return null
  if (ctx.excludes && ctx.excludes.length > 0 && (absolutePathMatchesAny(ctx.excludes, file) || absolutePathMatchesAny(ctx.excludes, realPath))) {
    ctx.debug(`excluded by pattern: ${file}`)
    return null
  }
  const stat = await statFile(realPath)
  if (!stat) return null
  if (stat.size > MAX_INSTRUCTION_FILE_BYTES) {
    ctx.debug(`skipped (over 4 MiB): ${file}`, { size: stat.size })
    return null
  }
  let raw: string
  try {
    raw = await fs.readFile(realPath, 'utf8')
  } catch (error) {
    ctx.debug(`failed to read ${file}`, error)
    return null
  }
  const text = stripHtmlComments(raw).trim()
  ctx.loaded.add(realPath)
  if (!text) return null
  return { path: realPath, label: labelForScope(scope), text, reason, scope, importedFrom }
}

/** §2.7 rule 4: a CLAUDE.md whose whole body is `@AGENTS.md` adds nothing once AGENTS.md loaded. */
function isAgentsOnlyImport(text: string): boolean {
  return /^@(?:\.\/)?AGENTS\.md$/i.test(text.trim())
}

async function expandImports(ctx: LoadContext, entry: InstructionFileEntry, depth: number): Promise<InstructionFileEntry[]> {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const tokens = extractImportTokens(entry.text)
  if (tokens.length === 0) return []
  const out: InstructionFileEntry[] = []
  for (const token of tokens) {
    const resolved = resolveImportPath(token, entry.path, ctx.homeDir)
    const realPath = await realpathSafe(resolved)
    if (!realPath) continue
    if (!(await statFile(realPath))) continue
    if (ctx.loaded.has(realPath)) continue
    const external = !isInsideDirectory(realPath, ctx.rootRealPath)
    // §2.3: user-scope imports load without a dialog. Project/local imports outside
    // the working directory wait for a single approval.
    if (external && entry.scope !== 'user' && !ctx.externalApproved) {
      ctx.pendingExternal.push({ file: realPath, scope: entry.scope, importedFrom: entry.path, depth })
      continue
    }
    const imported = await readInstructionEntry(ctx, realPath, entry.scope, 'include', entry.path)
    if (!imported) continue
    out.push(imported)
    out.push(...(await expandImports(ctx, imported, depth + 1)))
  }
  return out
}

async function loadDirectory(ctx: LoadContext, directory: string, reason: ContextInjectionReason): Promise<InstructionFileEntry[]> {
  const candidates = await listDirectoryInstructionCandidates(directory)
  const out: InstructionFileEntry[] = []
  let agentsLoaded = false
  for (const candidate of candidates) {
    const base = path.basename(candidate.file)
    const entry = await readInstructionEntry(ctx, candidate.file, candidate.scope, reason)
    if (!entry) continue
    if (base === 'AGENTS.md') agentsLoaded = true
    if (base === 'CLAUDE.md' && agentsLoaded && isAgentsOnlyImport(entry.text)) {
      ctx.debug(`skipped CLAUDE.md that only imports AGENTS.md: ${candidate.file}`)
      continue
    }
    out.push(entry)
    out.push(...(await expandImports(ctx, entry, 0)))
  }
  return out
}

async function flushPendingExternals(ctx: LoadContext): Promise<InstructionFileEntry[]> {
  if (ctx.pendingExternal.length === 0) return []
  const pending = ctx.pendingExternal.splice(0)
  const unique = Array.from(new Set(pending.map(item => item.file)))
  if (!ctx.approveExternalImports) {
    ctx.debug('external imports skipped (no approval channel)', unique)
    return []
  }
  let approved = false
  try {
    approved = await ctx.approveExternalImports(unique)
  } catch (error) {
    ctx.debug('external import approval failed', error)
    approved = false
  }
  if (!approved) {
    ctx.debug('external imports declined', unique)
    return []
  }
  ctx.externalApproved = true
  const out: InstructionFileEntry[] = []
  for (const item of pending) {
    const entry = await readInstructionEntry(ctx, item.file, item.scope, 'include', item.importedFrom)
    if (!entry) continue
    out.push(entry)
    out.push(...(await expandImports(ctx, entry, item.depth + 1)))
  }
  return out
}

function buildContext(options: InstructionDiscoveryOptions, rootRealPath: string): LoadContext {
  return {
    ...options,
    homeDir: options.homeDir ?? os.homedir(),
    rootRealPath,
    debug: options.debug ?? noopDebug,
    pendingExternal: [],
    externalApproved: false,
  }
}

/**
 * §2.2 launch walk: user scope (`~/<readDir>/AGENTS.md`, `~/<readDir>/CLAUDE.md` per
 * readDirs entry), then every ancestor directory from the filesystem root down to
 * the conversation root. Root-most content first, root last.
 */
export async function discoverLaunchInstructionFiles(options: InstructionDiscoveryOptions): Promise<InstructionFileEntry[]> {
  const rootRealPath = (await realpathSafe(options.rootPath)) ?? path.resolve(options.rootPath)
  const ctx = buildContext(options, rootRealPath)
  const out: InstructionFileEntry[] = []

  for (const readDir of ctx.readDirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(ctx.homeDir, readDir, name)
      if (!(await statFile(file))) continue
      const entry = await readInstructionEntry(ctx, file, 'user', 'session_start')
      if (!entry) continue
      out.push(entry)
      out.push(...(await expandImports(ctx, entry, 0)))
    }
  }

  for (const directory of ancestorChain(options.rootPath)) {
    out.push(...(await loadDirectory(ctx, directory, 'session_start')))
  }

  out.push(...(await flushPendingExternals(ctx)))
  return out
}

/**
 * §2.2 step 3 "nested traversal": when the model touches a file below the root,
 * inject the instruction files of every directory between the root (exclusive) and
 * the file's directory (inclusive). Each file loads once per branch (`loaded`).
 */
export async function discoverNestedInstructionFiles(
  options: InstructionDiscoveryOptions & { directories: readonly string[] }
): Promise<InstructionFileEntry[]> {
  const rootRealPath = (await realpathSafe(options.rootPath)) ?? path.resolve(options.rootPath)
  const ctx = buildContext(options, rootRealPath)
  const out: InstructionFileEntry[] = []
  for (const directory of options.directories) {
    out.push(...(await loadDirectory(ctx, directory, 'nested_traversal')))
  }
  out.push(...(await flushPendingExternals(ctx)))
  return out
}
