// server/context/rulesLoader.ts
// `<configDir>/rules/**/*.md` discovery (docs §3).

import fs from 'fs/promises'
import path from 'path'
import { LABEL_PROJECT, LABEL_USER_GLOBAL } from '../../../../shared/contextInjection.js'
import { parseFrontmatter, parseFrontmatterList, stripHtmlComments } from './frontmatter.js'
import { compileGlobList, globListMatches, type CompiledGlobList } from './globMatcher.js'
import { isInsideDirectory, type ContextDebugLogger } from './instructionFiles.js'

export type RuleScope = 'user' | 'project' | 'nested'

export interface RuleFile {
  /** Path as discovered (may be a symlink). */
  path: string
  /** Resolved real path; the dedupe key. */
  realPath: string
  scope: RuleScope
  label: string
  /** `paths` frontmatter, or null for an unconditional rule. */
  paths: string[] | null
  compiled: CompiledGlobList | null
  /** Directory the `paths` globs are anchored at (project root, or the nested dir). */
  anchorDir: string
  body: string
}

export interface RulesDirectorySpec {
  dir: string
  scope: RuleScope
  anchorDir: string
}

export interface DiscoverRulesOptions {
  directories: readonly RulesDirectorySpec[]
  /** Real path of the conversation root; symlink targets outside it are "external". */
  rootRealPath: string
  /** §3.1: external symlinked rules load only after approval, and only without `paths`. */
  allowExternal?: boolean
  debug?: ContextDebugLogger
}

const noop: ContextDebugLogger = () => {}

async function walkMarkdown(dir: string, visited: Set<string>, debug: ContextDebugLogger): Promise<string[]> {
  let real: string
  try {
    real = await fs.realpath(dir)
  } catch {
    return []
  }
  if (visited.has(real)) {
    debug(`circular symlink skipped: ${dir}`)
    return []
  }
  visited.add(real)
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
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
    if (isDir) files.push(...(await walkMarkdown(full, visited, debug)))
    else if (isFile && entry.name.toLowerCase().endsWith('.md')) files.push(full)
  }
  return files
}

export function labelForRuleScope(scope: RuleScope): string {
  return scope === 'user' ? LABEL_USER_GLOBAL : LABEL_PROJECT
}

export async function discoverRules(options: DiscoverRulesOptions): Promise<RuleFile[]> {
  const debug = options.debug ?? noop
  const rules: RuleFile[] = []
  const seen = new Set<string>()

  for (const spec of options.directories) {
    const visited = new Set<string>()
    const files = await walkMarkdown(spec.dir, visited, debug)
    for (const file of files) {
      let realPath: string
      try {
        realPath = await fs.realpath(file)
      } catch {
        continue
      }
      if (seen.has(realPath)) continue
      let raw: string
      try {
        raw = await fs.readFile(realPath, 'utf8')
      } catch (error) {
        debug(`failed to read rule ${file}`, error)
        continue
      }
      const parsed = parseFrontmatter(raw)
      if (parsed.error) debug(`rule frontmatter dropped (${parsed.error}): ${file}`)
      const pathsRaw = parsed.hasFrontmatter ? parsed.data.paths : undefined
      const paths = pathsRaw === undefined || pathsRaw === null ? null : parseFrontmatterList(pathsRaw, 'comma')
      const external = spec.scope !== 'user' && !isInsideDirectory(realPath, options.rootRealPath)
      if (external) {
        if (!options.allowExternal) {
          debug(`external rule skipped (not approved): ${file} -> ${realPath}`)
          continue
        }
        if (paths && paths.length > 0) {
          debug(`external rule with paths skipped: ${file}`)
          continue
        }
      }
      const body = stripHtmlComments(parsed.body).trim()
      if (!body) continue
      const compiled = paths && paths.length > 0 ? compileGlobList(paths) : null
      if (compiled?.invalid.length) debug(`invalid glob pattern(s) in ${file}`, compiled.invalid)
      if (compiled?.unexpanded.length) debug(`brace budget exceeded in ${file}`, compiled.unexpanded)
      seen.add(realPath)
      rules.push({
        path: file,
        realPath,
        scope: spec.scope,
        label: labelForRuleScope(spec.scope),
        paths: paths && paths.length > 0 ? paths : null,
        compiled,
        anchorDir: spec.anchorDir,
        body,
      })
    }
  }
  return rules
}

/** §3.4 trigger: a conditional rule matches when the touched file's anchor-relative path matches. */
export function ruleMatchesFile(rule: RuleFile, absoluteFilePath: string): boolean {
  if (!rule.compiled) return false
  if (!isInsideDirectory(absoluteFilePath, rule.anchorDir)) return false
  const relative = path.relative(rule.anchorDir, absoluteFilePath)
  return globListMatches(rule.compiled, relative)
}
