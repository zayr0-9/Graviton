// Local file operations for Electron mode
import { Express } from 'express'
import fs from 'fs'
import path from 'path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { detectPathType, isWindows, resolveToWindowsPath, toWslPath } from './utils/wslBridge.js'
import type { LocalFileEntry } from '../shared/localFileBrowser.js'
import { rankFileMatches } from '../shared/fileMatchRanking.js'
import type {
  LocalGitActionResponse,
  LocalGitBranch,
  LocalGitCommit,
  LocalGitDiffResponse,
  LocalGitOverviewResponse,
  LocalGitStatusFile,
  LocalGitStatusGroups,
} from '../shared/localGit.js'

const execFile = promisify(execFileCb)

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.venv', 'dist', 'build', '.next'])
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DIRECTORIES = 10000
const MAX_SEARCH_CANDIDATES = 2000
const GIT_COMMAND_TIMEOUT_MS = 2500
const GIT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024
const MAX_EDITOR_FILE_SIZE_BYTES = 10 * 1024 * 1024

type ResolvedDirectory = {
  resolvedPath: string
  responseBasePath: string
  useWslStyleResponse: boolean
}

type LocalSearchEntry = LocalFileEntry & {
  relativePath: string
}

type GitContext = ResolvedDirectory & {
  repoRootFs: string
  repoRootResponse: string
}

const GIT_CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const GIT_DIFF_MAX_CHARS = 300000

const createEmptyGitStatusGroups = (): LocalGitStatusGroups => ({
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  all: [],
})

const createEmptyGitOverview = (requestedPath: string): LocalGitOverviewResponse => ({
  requestedPath,
  isGitRepo: false,
  summary: null,
  status: createEmptyGitStatusGroups(),
  commits: [],
  commitGraphLines: [],
  branches: {
    local: [],
    remote: [],
  },
})

const sortEntries = (entries: fs.Dirent[]): fs.Dirent[] =>
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

const isVisibleEntry = (entry: fs.Dirent): boolean => !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)

const joinResponsePath = (basePath: string, childName: string, useWslStyleResponse: boolean): string => {
  if (useWslStyleResponse) {
    return path.posix.join(basePath === '/' ? '/' : basePath, childName)
  }
  return path.join(basePath, childName)
}

const normalizeRelativePosix = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '')

const buildResponsePathFromRelative = (
  basePath: string,
  relativePath: string,
  useWslStyleResponse: boolean
): string => {
  const normalizedRelativePath = normalizeRelativePosix(relativePath).replace(/^\/+/, '')
  if (!normalizedRelativePath) return basePath

  if (useWslStyleResponse) {
    return path.posix.join(basePath === '/' ? '/' : basePath, normalizedRelativePath)
  }

  return path.join(basePath, ...normalizedRelativePath.split('/'))
}

const parseBooleanQueryParam = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value !== 'string') return defaultValue
  const normalized = value.trim().toLowerCase()
  if (!normalized) return defaultValue
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

const resolveDirectory = async (requestedPathRaw: string): Promise<ResolvedDirectory> => {
  const requestedPath = requestedPathRaw.trim()
  const requestedPathType = detectPathType(requestedPath)

  let fsPath = requestedPath
  if (isWindows() && requestedPathType === 'linux') {
    fsPath = await resolveToWindowsPath(requestedPath)
  }

  const resolvedPath = path.resolve(fsPath)
  const stats = await fs.promises.stat(resolvedPath)
  if (!stats.isDirectory()) {
    const error = new Error('Path is not a directory') as NodeJS.ErrnoException
    error.code = 'ENOTDIR'
    throw error
  }

  const useWslStyleResponse = isWindows() && requestedPathType === 'linux'
  const responseBasePath = useWslStyleResponse ? toWslPath(requestedPath).replace(/\/+$/, '') || '/' : resolvedPath

  return { resolvedPath, responseBasePath, useWslStyleResponse }
}

const resolveFilePath = async (requestedPathRaw: string): Promise<{ resolvedPath: string }> => {
  const requestedPath = String(requestedPathRaw || '').trim()
  const requestedPathType = detectPathType(requestedPath)

  let fsPath = requestedPath
  if (isWindows() && requestedPathType === 'linux') {
    fsPath = await resolveToWindowsPath(requestedPath)
  }

  const resolvedPath = path.resolve(fsPath)
  const stats = await fs.promises.stat(resolvedPath)

  if (!stats.isFile()) {
    const error = new Error('Path is not a file') as NodeJS.ErrnoException
    error.code = 'EISDIR'
    throw error
  }

  return { resolvedPath }
}

const searchWithGitignore = async (params: {
  resolvedPath: string
  responseBasePath: string
  useWslStyleResponse: boolean
  query: string
  limit: number
}): Promise<{ files: LocalSearchEntry[]; truncated: boolean } | null> => {
  const { resolvedPath, responseBasePath, useWslStyleResponse, query, limit } = params

  let repoRoot = ''
  try {
    const rootResult = await execFile('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER,
      windowsHide: true,
    })
    repoRoot = String(rootResult.stdout || '').trim()
  } catch {
    return null
  }

  if (!repoRoot) return null

  const relativeBaseRaw = path.relative(repoRoot, resolvedPath)
  if (relativeBaseRaw.startsWith('..')) return null

  const relativeBase = normalizeRelativePosix(relativeBaseRaw)

  let lsFilesOutput = ''
  try {
    const lsFilesResult = await execFile(
      'git',
      ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '--full-name'],
      {
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: GIT_COMMAND_MAX_BUFFER,
        windowsHide: true,
      }
    )
    lsFilesOutput = String(lsFilesResult.stdout || '')
  } catch {
    return null
  }

  const needle = query.toLowerCase()
  const candidates: LocalSearchEntry[] = []
  const seenRelativePaths = new Set<string>()
  const candidateLimit = Math.max(limit, Math.min(MAX_SEARCH_CANDIDATES, limit * 10))

  const pushCandidate = (entry: LocalSearchEntry): boolean => {
    if (!entry.relativePath || seenRelativePaths.has(entry.relativePath)) {
      return candidates.length >= candidateLimit
    }

    seenRelativePaths.add(entry.relativePath)
    candidates.push(entry)
    return candidates.length >= candidateLimit
  }

  const lines = lsFilesOutput
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (const repoRelativeFile of lines) {
    const normalizedRepoRelative = normalizeRelativePosix(repoRelativeFile)

    if (relativeBase) {
      const basePrefix = `${relativeBase}/`
      if (normalizedRepoRelative !== relativeBase && !normalizedRepoRelative.startsWith(basePrefix)) {
        continue
      }
    }

    const relativeFromSearchRoot = relativeBase
      ? normalizedRepoRelative.slice(relativeBase.length + (normalizedRepoRelative === relativeBase ? 0 : 1))
      : normalizedRepoRelative

    if (!relativeFromSearchRoot) continue

    const pathSegments = relativeFromSearchRoot.split('/').filter(Boolean)
    if (pathSegments.length > 1) {
      let currentDirectoryPath = ''
      for (const segment of pathSegments.slice(0, -1)) {
        currentDirectoryPath = currentDirectoryPath ? path.posix.join(currentDirectoryPath, segment) : segment
        const directoryName = path.posix.basename(currentDirectoryPath)
        const directoryHaystack = `${directoryName} ${currentDirectoryPath}`.toLowerCase()

        if (!directoryHaystack.includes(needle)) continue

        const didReachLimit = pushCandidate({
          name: directoryName,
          isDirectory: true,
          path: buildResponsePathFromRelative(responseBasePath, currentDirectoryPath, useWslStyleResponse),
          relativePath: currentDirectoryPath,
        })

        if (didReachLimit) break
      }
    }

    if (candidates.length >= candidateLimit) {
      break
    }

    const fileName = path.posix.basename(relativeFromSearchRoot)
    const haystack = `${fileName} ${relativeFromSearchRoot}`.toLowerCase()
    if (!haystack.includes(needle)) continue

    const didReachLimit = pushCandidate({
      name: fileName,
      isDirectory: false,
      path: buildResponsePathFromRelative(responseBasePath, relativeFromSearchRoot, useWslStyleResponse),
      relativePath: relativeFromSearchRoot,
    })

    if (didReachLimit) {
      break
    }
  }

  const files = rankFileMatches(candidates, query).slice(0, limit)

  return {
    files,
    truncated: candidates.length > limit,
  }
}

const mapFsPathToResponsePath = (
  fsPath: string,
  resolvedBasePath: string,
  responseBasePath: string,
  useWslStyleResponse: boolean
): string => {
  const relativePath = normalizeRelativePosix(path.relative(resolvedBasePath, fsPath))
  if (!relativePath || relativePath === '.') return responseBasePath

  if (useWslStyleResponse) {
    return path.posix.resolve(responseBasePath, relativePath)
  }

  return path.resolve(responseBasePath, relativePath)
}

const buildGitActionMessage = (error: unknown, fallbackMessage: string): string => {
  if (error && typeof error === 'object') {
    const maybeError = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    const stderr = String(maybeError.stderr || '').trim()
    const stdout = String(maybeError.stdout || '').trim()
    if (stderr) return stderr.split(/\r?\n/).pop() || fallbackMessage
    if (stdout) return stdout.split(/\r?\n/).pop() || fallbackMessage
    if (maybeError.message) return maybeError.message
  }

  return fallbackMessage
}

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFile('git', ['-C', cwd, ...args], {
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
    windowsHide: true,
  })

  return String(result.stdout || '')
}

const runGitOptional = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    return await runGit(cwd, args)
  } catch {
    return null
  }
}

const sanitizeGitRelativePath = (value: string): string => {
  const normalized = normalizeRelativePosix(String(value || '').trim())
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return ''
  return normalized
}

const resolveGitContext = async (requestedPathRaw: string): Promise<GitContext | null> => {
  const directory = await resolveDirectory(requestedPathRaw)
  const repoRootOutput = await runGitOptional(directory.resolvedPath, ['rev-parse', '--show-toplevel'])
  const repoRootFs = String(repoRootOutput || '').trim()
  if (!repoRootFs) return null

  return {
    ...directory,
    repoRootFs,
    repoRootResponse: mapFsPathToResponsePath(
      repoRootFs,
      directory.resolvedPath,
      directory.responseBasePath,
      directory.useWslStyleResponse
    ),
  }
}

const parseGitBranchHeader = (
  line: string
): {
  currentBranch: string | null
  upstreamBranch: string | null
  ahead: number
  behind: number
  detached: boolean
} => {
  const header = line.replace(/^##\s*/, '').trim()
  const bracketMatch = header.match(/\[(.*?)\]$/)
  const statusMetadata = bracketMatch?.[1] || ''
  const branchSection = header.replace(/\s+\[.*\]$/, '').trim()

  let ahead = 0
  let behind = 0

  const aheadMatch = statusMetadata.match(/ahead\s+(\d+)/)
  const behindMatch = statusMetadata.match(/behind\s+(\d+)/)
  if (aheadMatch) ahead = Number(aheadMatch[1]) || 0
  if (behindMatch) behind = Number(behindMatch[1]) || 0

  if (branchSection.startsWith('HEAD (no branch)')) {
    return {
      currentBranch: null,
      upstreamBranch: null,
      ahead,
      behind,
      detached: true,
    }
  }

  const normalizedBranchSection = branchSection
    .replace(/^No commits yet on\s+/, '')
    .replace(/^Initial commit on\s+/, '')
    .trim()

  if (normalizedBranchSection.includes('...')) {
    const [currentBranch, upstreamBranch] = normalizedBranchSection.split('...')
    return {
      currentBranch: currentBranch?.trim() || null,
      upstreamBranch: upstreamBranch?.trim() || null,
      ahead,
      behind,
      detached: false,
    }
  }

  return {
    currentBranch: normalizedBranchSection || null,
    upstreamBranch: null,
    ahead,
    behind,
    detached: false,
  }
}

const parseGitStatusEntries = (gitContext: GitContext, statusOutput: string): LocalGitStatusGroups => {
  const groups = createEmptyGitStatusGroups()
  const lines = statusOutput.split(/\r?\n/)

  for (const line of lines.slice(1)) {
    if (!line) continue
    if (line.startsWith('!! ')) continue

    let entry: LocalGitStatusFile | null = null

    if (line.startsWith('?? ')) {
      const relativePath = sanitizeGitRelativePath(line.slice(3))
      if (!relativePath) continue
      const responsePath = buildResponsePathFromRelative(
        gitContext.repoRootResponse,
        relativePath,
        gitContext.useWslStyleResponse
      )
      entry = {
        path: responsePath,
        relativePath,
        displayPath: relativePath,
        oldPath: null,
        oldDisplayPath: null,
        code: '??',
        x: '?',
        y: '?',
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
        isRenamed: false,
        isDeleted: false,
        categories: ['untracked'],
      }
    } else {
      const x = line[0] || ' '
      const y = line[1] || ' '
      const code = `${x}${y}`
      const rawPath = line.slice(3).trim()
      if (!rawPath) continue

      let nextPath = rawPath
      let oldPath: string | null = null
      if (rawPath.includes(' -> ')) {
        const [before, after] = rawPath.split(' -> ')
        oldPath = sanitizeGitRelativePath(before)
        nextPath = after
      }

      const relativePath = sanitizeGitRelativePath(nextPath)
      if (!relativePath) continue

      const conflicted = GIT_CONFLICT_CODES.has(code) || x === 'U' || y === 'U'
      const staged = !conflicted && x !== ' '
      const unstaged = !conflicted && y !== ' '
      const isRenamed = rawPath.includes(' -> ') || x === 'R' || y === 'R'
      const isDeleted = x === 'D' || y === 'D'
      const responsePath = buildResponsePathFromRelative(
        gitContext.repoRootResponse,
        relativePath,
        gitContext.useWslStyleResponse
      )
      const oldResponsePath = oldPath
        ? buildResponsePathFromRelative(gitContext.repoRootResponse, oldPath, gitContext.useWslStyleResponse)
        : null

      const categories: Array<'staged' | 'unstaged' | 'untracked' | 'conflicted'> = []
      if (conflicted) categories.push('conflicted')
      if (staged) categories.push('staged')
      if (unstaged) categories.push('unstaged')

      entry = {
        path: responsePath,
        relativePath,
        displayPath: oldPath ? `${oldPath} Ã¢â€ â€™ ${relativePath}` : relativePath,
        oldPath: oldResponsePath,
        oldDisplayPath: oldPath,
        code,
        x,
        y,
        staged,
        unstaged,
        untracked: false,
        conflicted,
        isRenamed,
        isDeleted,
        categories,
      }
    }

    if (!entry) continue

    groups.all.push(entry)
    if (entry.conflicted) groups.conflicted.push(entry)
    if (entry.staged) groups.staged.push(entry)
    if (entry.unstaged) groups.unstaged.push(entry)
    if (entry.untracked) groups.untracked.push(entry)
  }

  return groups
}

const parseGitCommits = (output: string): LocalGitCommit[] =>
  output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [hash = '', shortHash = '', author = '', relativeDate = '', decorations = '', ...subjectParts] =
        line.split('\t')
      return {
        hash,
        shortHash,
        author,
        relativeDate,
        decorations: decorations.trim(),
        subject: subjectParts.join('\t').trim(),
      }
    })
    .filter(commit => commit.hash)

const parseGitBranches = (output: string, remote: boolean, currentBranch: string | null): LocalGitBranch[] =>
  output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [name = '', upstream = '', shortHash = '', relativeDate = '', ...subjectParts] = line.split('\t')
      return {
        name,
        current: !remote && Boolean(currentBranch) && name === currentBranch,
        remote,
        upstream: upstream || null,
        shortHash: shortHash || null,
        relativeDate: relativeDate || null,
        subject: subjectParts.join('\t').trim() || null,
      }
    })
    .filter(branch => branch.name && !branch.name.endsWith('/HEAD'))

const buildGitOverview = async (requestedPathRaw: string): Promise<LocalGitOverviewResponse> => {
  const requestedPath = String(requestedPathRaw || '').trim()
  if (!requestedPath) return createEmptyGitOverview('')

  const gitContext = await resolveGitContext(requestedPath)
  if (!gitContext) return createEmptyGitOverview(requestedPath)

  const statusOutput = await runGit(gitContext.repoRootFs, [
    'status',
    '--porcelain=v1',
    '--branch',
    '--untracked-files=all',
  ])
  const branchHeader = parseGitBranchHeader(statusOutput.split(/\r?\n/)[0] || '')
  const status = parseGitStatusEntries(gitContext, statusOutput)

  const remoteName = branchHeader.upstreamBranch?.split('/')[0] || 'origin'
  const [
    headShortShaOutput,
    remoteUrlOutput,
    commitsOutput,
    commitGraphOutput,
    localBranchesOutput,
    remoteBranchesOutput,
  ] = await Promise.all([
    runGitOptional(gitContext.repoRootFs, ['rev-parse', '--short', 'HEAD']),
    runGitOptional(gitContext.repoRootFs, ['remote', 'get-url', remoteName]),
    runGitOptional(gitContext.repoRootFs, [
      'log',
      '-n',
      '15',
      '--date=relative',
      '--decorate=short',
      '--pretty=format:%H%x09%h%x09%an%x09%ar%x09%d%x09%s',
    ]),
    runGitOptional(gitContext.repoRootFs, [
      'log',
      '--graph',
      '--decorate',
      '--date=short',
      '--pretty=format:%C(auto)%h %d %s %C(dim white)- %an, %ad',
      '-n',
      '30',
    ]),
    runGitOptional(gitContext.repoRootFs, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)',
      'refs/heads',
    ]),
    runGitOptional(gitContext.repoRootFs, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)',
      'refs/remotes',
    ]),
  ])

  const commits = parseGitCommits(commitsOutput || '')
  const commitGraphLines = String(commitGraphOutput || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter(Boolean)
  const localBranches = parseGitBranches(localBranchesOutput || '', false, branchHeader.currentBranch)
  const remoteBranches = parseGitBranches(remoteBranchesOutput || '', true, branchHeader.currentBranch)

  return {
    requestedPath,
    isGitRepo: true,
    summary: {
      repoRoot: gitContext.repoRootResponse,
      repoName: path.basename(gitContext.repoRootFs),
      currentBranch: branchHeader.currentBranch,
      headShortSha: String(headShortShaOutput || '').trim() || null,
      detached: branchHeader.detached,
      upstreamBranch: branchHeader.upstreamBranch,
      ahead: branchHeader.ahead,
      behind: branchHeader.behind,
      remoteUrl: String(remoteUrlOutput || '').trim() || null,
      isClean: status.all.length === 0,
      changedFilesCount: status.all.length,
      stagedCount: status.staged.length,
      unstagedCount: status.unstaged.length,
      untrackedCount: status.untracked.length,
      conflictedCount: status.conflicted.length,
    },
    status,
    commits,
    commitGraphLines,
    branches: {
      local: localBranches,
      remote: remoteBranches,
    },
  }
}

const gitDiffLanguageMap: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
}

const detectGitDiffLanguage = (relativePath: string): string | null => {
  const extension = relativePath.includes('.') ? relativePath.split('.').pop()?.toLowerCase() || '' : ''
  return extension ? gitDiffLanguageMap[extension] || 'plaintext' : 'plaintext'
}

const readUtf8FileOptional = async (filePath: string): Promise<string | null> => {
  try {
    const buffer = await fs.promises.readFile(filePath)
    if (buffer.includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

const readGitShowOptional = async (repoRootFs: string, spec: string): Promise<string | null> => {
  const output = await runGitOptional(repoRootFs, ['show', spec])
  return output == null ? null : String(output)
}

const getGitStatusEntry = async (gitContext: GitContext, relativePath: string): Promise<LocalGitStatusFile | null> => {
  const statusOutput = await runGit(gitContext.repoRootFs, [
    'status',
    '--porcelain=v1',
    '--branch',
    '--untracked-files=all',
    '--',
    relativePath,
  ])
  const status = parseGitStatusEntries(gitContext, statusOutput)
  return status.all.find(entry => entry.relativePath === relativePath) || null
}

/**
 * Register local file operation routes
 * These routes provide file system access for the Electron app
 */
export function registerLocalOperationsRoutes(app: Express) {
  // GET /api/local/files - List files in a directory
  // Query params: path (required) - directory path to list
  app.get('/api/local/files', async (req, res): Promise<void> => {
    const dirPath = req.query.path as string

    if (!dirPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    try {
      const { resolvedPath, responseBasePath, useWslStyleResponse } = await resolveDirectory(dirPath)
      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true })

      const files = sortEntries(entries)
        .filter(isVisibleEntry)
        .map(entry => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: joinResponsePath(responseBasePath, entry.name, useWslStyleResponse),
          relativePath: entry.name,
        }))

      res.json({ path: responseBasePath, files })
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Directory not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      console.error('Error listing directory:', error)
      res.status(500).json({ error: 'Failed to list directory' })
    }
  })

  // GET /api/local/file-content - Read UTF-8 text content from a file for inline editing
  // Query params: path (required) - file path
  app.get('/api/local/file-content', async (req, res): Promise<void> => {
    const filePath = String(req.query.path || '').trim()

    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    try {
      const { resolvedPath } = await resolveFilePath(filePath)
      const stats = await fs.promises.stat(resolvedPath)

      if (stats.size > MAX_EDITOR_FILE_SIZE_BYTES) {
        res.status(413).json({ error: `File is too large to edit in mobile UI (>${MAX_EDITOR_FILE_SIZE_BYTES} bytes)` })
        return
      }

      const content = await fs.promises.readFile(resolvedPath, 'utf8')
      res.json({
        path: filePath,
        size: stats.size,
        content,
      })
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'EISDIR' || error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a file' })
        return
      }
      console.error('Error reading file:', error)
      res.status(500).json({ error: 'Failed to read file' })
    }
  })

  // POST /api/local/file-content - Persist UTF-8 text edits for a file
  // Body: { path: string, content: string }
  app.post('/api/local/file-content', async (req, res): Promise<void> => {
    const filePath = String(req.body?.path || '').trim()
    const content = req.body?.content

    if (!filePath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' })
      return
    }

    try {
      const { resolvedPath } = await resolveFilePath(filePath)
      await fs.promises.writeFile(resolvedPath, content, 'utf8')
      const updatedStats = await fs.promises.stat(resolvedPath)

      res.json({
        path: filePath,
        size: updatedStats.size,
        saved: true,
      })
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'EISDIR' || error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a file' })
        return
      }
      console.error('Error writing file:', error)
      res.status(500).json({ error: 'Failed to write file' })
    }
  })

  // GET /api/local/files/search - Recursively search files/folders within a directory
  // Query params:
  // - path (required): root directory path to search
  // - query (required): case-insensitive search substring
  // - limit (optional): max results (default 200, max 500)
  // - followGitignore (optional): when true (default), attempt gitignore-aware search in git repos
  app.get('/api/local/files/search', async (req, res): Promise<void> => {
    const dirPath = req.query.path as string
    const query = String(req.query.query ?? req.query.q ?? '').trim()

    if (!dirPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    if (!query) {
      res.status(400).json({ error: 'query parameter is required' })
      return
    }

    const requestedLimit = Number(req.query.limit)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
      : MAX_SEARCH_RESULTS

    const followGitignore = parseBooleanQueryParam(req.query.followGitignore, true)

    try {
      const { resolvedPath, responseBasePath, useWslStyleResponse } = await resolveDirectory(dirPath)
      const normalizedNeedle = query.toLowerCase()

      if (followGitignore) {
        const gitignoreAware = await searchWithGitignore({
          resolvedPath,
          responseBasePath,
          useWslStyleResponse,
          query,
          limit,
        })

        if (gitignoreAware) {
          res.json({
            path: responseBasePath,
            query,
            files: gitignoreAware.files,
            truncated: gitignoreAware.truncated,
            respectingGitignore: true,
          })
          return
        }
      }

      const queue: Array<{ fsPath: string; responsePath: string; relativePath: string }> = [
        { fsPath: resolvedPath, responsePath: responseBasePath, relativePath: '' },
      ]

      const candidates: LocalSearchEntry[] = []
      const candidateLimit = Math.max(limit, Math.min(MAX_SEARCH_CANDIDATES, limit * 10))
      let visitedDirectories = 0

      while (queue.length > 0 && candidates.length < candidateLimit) {
        const node = queue.shift()
        if (!node) break

        visitedDirectories += 1
        if (visitedDirectories > MAX_SEARCH_DIRECTORIES) break

        let entries: fs.Dirent[] = []
        try {
          entries = await fs.promises.readdir(node.fsPath, { withFileTypes: true })
        } catch {
          continue
        }

        const visibleEntries = sortEntries(entries).filter(isVisibleEntry)

        for (const entry of visibleEntries) {
          const entryPath = joinResponsePath(node.responsePath, entry.name, useWslStyleResponse)
          const entryRelativePath = node.relativePath ? path.posix.join(node.relativePath, entry.name) : entry.name
          const searchText = `${entry.name} ${entryRelativePath}`.toLowerCase()

          if (searchText.includes(normalizedNeedle)) {
            candidates.push({
              name: entry.name,
              isDirectory: entry.isDirectory(),
              path: entryPath,
              relativePath: entryRelativePath,
            })
            if (candidates.length >= candidateLimit) break
          }

          if (entry.isDirectory()) {
            const entryFsPath = path.join(node.fsPath, entry.name)
            queue.push({
              fsPath: entryFsPath,
              responsePath: entryPath,
              relativePath: entryRelativePath,
            })
          }
        }
      }

      const files = rankFileMatches(candidates, query).slice(0, limit)

      res.json({
        path: responseBasePath,
        query,
        files,
        truncated: candidates.length > limit,
        respectingGitignore: false,
      })
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Directory not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      console.error('Error searching directory:', error)
      res.status(500).json({ error: 'Failed to search directory' })
    }
  })

  app.get('/api/local/git/overview', async (req, res): Promise<void> => {
    const requestedPath = String(req.query.path || '').trim()

    if (!requestedPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    try {
      const overview = await buildGitOverview(requestedPath)
      res.json(overview)
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Directory not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      console.error('Error loading git overview:', error)
      res.status(500).json({ error: 'Failed to load git overview' })
    }
  })

  app.get('/api/local/git/diff', async (req, res): Promise<void> => {
    const requestedPath = String(req.query.path || '').trim()
    const relativePath = sanitizeGitRelativePath(String(req.query.file || ''))
    const staged = parseBooleanQueryParam(req.query.staged, false)

    if (!requestedPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    if (!relativePath) {
      res.status(400).json({ error: 'file query parameter is required' })
      return
    }

    try {
      const gitContext = await resolveGitContext(requestedPath)
      if (!gitContext) {
        const response: LocalGitDiffResponse = {
          requestedPath,
          isGitRepo: false,
          repoRoot: null,
          file: relativePath,
          staged,
          diff: '',
          truncated: false,
          message: 'Git repository not detected for this path.',
          languageHint: detectGitDiffLanguage(relativePath),
          preferPatch: true,
          original: null,
          modified: null,
        }
        res.json(response)
        return
      }

      const diffOutput = await runGitOptional(gitContext.repoRootFs, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--unified=3',
        ...(staged ? ['--cached'] : []),
        '--',
        relativePath,
      ])

      const diffText = String(diffOutput || '')
      const truncated = diffText.length > GIT_DIFF_MAX_CHARS
      const trimmedDiff = truncated ? `${diffText.slice(0, GIT_DIFF_MAX_CHARS)}\n\n... diff truncated ...` : diffText
      const fileResponsePath = buildResponsePathFromRelative(
        gitContext.repoRootResponse,
        relativePath,
        gitContext.useWslStyleResponse
      )
      const fileFsPath = path.join(gitContext.repoRootFs, ...relativePath.split('/'))
      const statusEntry = await getGitStatusEntry(gitContext, relativePath)
      const languageHint = detectGitDiffLanguage(relativePath)

      let preferPatch = false
      let message: string | null = trimmedDiff.trim().length === 0 ? 'No diff available for this selection.' : null
      let original: LocalGitDiffResponse['original'] = null
      let modified: LocalGitDiffResponse['modified'] = null

      if (!statusEntry) {
        preferPatch = true
        message = message || 'Git status entry was not found for this file. Showing patch view.'
      } else if (statusEntry.conflicted) {
        preferPatch = true
        message = 'Conflicted files currently fall back to patch view.'
      } else {
        const previousRelativePath = statusEntry.oldDisplayPath || relativePath
        const previousResponsePath = buildResponsePathFromRelative(
          gitContext.repoRootResponse,
          previousRelativePath,
          gitContext.useWslStyleResponse
        )
        const headContent = await readGitShowOptional(gitContext.repoRootFs, `HEAD:${previousRelativePath}`)
        const indexContent = await readGitShowOptional(gitContext.repoRootFs, `:${relativePath}`)
        const workingContent = statusEntry.isDeleted ? '' : await readUtf8FileOptional(fileFsPath)

        if (statusEntry.untracked) {
          if (workingContent == null) {
            preferPatch = true
            message = 'Unable to render this untracked file in Monaco diff. Showing patch view instead.'
          } else {
            original = {
              path: null,
              label: 'Empty',
              content: '',
            }
            modified = {
              path: fileResponsePath,
              label: 'Working tree',
              content: workingContent,
            }
          }
        } else if (staged) {
          if (statusEntry.isDeleted) {
            original = {
              path: previousResponsePath,
              label: 'HEAD',
              content: headContent || indexContent || '',
            }
            modified = {
              path: null,
              label: 'Index',
              content: '',
            }
          } else if (indexContent == null) {
            preferPatch = true
            message = 'Unable to load staged file contents for Monaco diff. Showing patch view instead.'
          } else {
            original = {
              path: previousResponsePath,
              label: 'HEAD',
              content: headContent || '',
            }
            modified = {
              path: fileResponsePath,
              label: 'Index',
              content: indexContent,
            }
          }
        } else {
          const baselineContent = indexContent ?? headContent
          if (baselineContent == null || workingContent == null) {
            preferPatch = true
            message = 'Unable to load working tree contents for Monaco diff. Showing patch view instead.'
          } else {
            original = {
              path: fileResponsePath,
              label: 'Index',
              content: baselineContent,
            }
            modified = {
              path: statusEntry.isDeleted ? null : fileResponsePath,
              label: 'Working tree',
              content: workingContent,
            }
          }
        }
      }

      const response: LocalGitDiffResponse = {
        requestedPath,
        isGitRepo: true,
        repoRoot: gitContext.repoRootResponse,
        file: relativePath,
        staged,
        diff: trimmedDiff,
        truncated,
        message,
        languageHint,
        preferPatch,
        original,
        modified,
      }

      res.json(response)
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Directory not found' })
        return
      }
      if (error.code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' })
        return
      }
      if (error.code === 'ENOTDIR') {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      console.error('Error loading git diff:', error)
      res.status(500).json({ error: 'Failed to load git diff' })
    }
  })

  app.post('/api/local/git/stage', async (req, res): Promise<void> => {
    const requestedPath = String(req.body?.path || '').trim()
    const files = Array.isArray(req.body?.files)
      ? req.body.files.map((value: unknown) => sanitizeGitRelativePath(String(value || ''))).filter(Boolean)
      : []

    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    try {
      const gitContext = await resolveGitContext(requestedPath)
      if (!gitContext) {
        const response: LocalGitActionResponse = {
          ok: false,
          isGitRepo: false,
          message: 'Git repository not detected for this path.',
        }
        res.status(400).json(response)
        return
      }

      if (files.length > 0) {
        await runGit(gitContext.repoRootFs, ['add', '--', ...files])
      } else {
        await runGit(gitContext.repoRootFs, ['add', '-A'])
      }

      const response: LocalGitActionResponse = {
        ok: true,
        isGitRepo: true,
        message: files.length > 0 ? `Staged ${files.length} file${files.length === 1 ? '' : 's'}.` : 'Staged all changes.',
      }
      res.json(response)
    } catch (error) {
      const response: LocalGitActionResponse = {
        ok: false,
        isGitRepo: true,
        message: buildGitActionMessage(error, 'Failed to stage files.'),
      }
      res.status(500).json(response)
    }
  })

  app.post('/api/local/git/unstage', async (req, res): Promise<void> => {
    const requestedPath = String(req.body?.path || '').trim()
    const files = Array.isArray(req.body?.files)
      ? req.body.files.map((value: unknown) => sanitizeGitRelativePath(String(value || ''))).filter(Boolean)
      : []

    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    if (files.length === 0) {
      res.status(400).json({ error: 'files are required' })
      return
    }

    try {
      const gitContext = await resolveGitContext(requestedPath)
      if (!gitContext) {
        const response: LocalGitActionResponse = {
          ok: false,
          isGitRepo: false,
          message: 'Git repository not detected for this path.',
        }
        res.status(400).json(response)
        return
      }

      try {
        await runGit(gitContext.repoRootFs, ['restore', '--staged', '--', ...files])
      } catch {
        await runGit(gitContext.repoRootFs, ['reset', 'HEAD', '--', ...files])
      }

      const response: LocalGitActionResponse = {
        ok: true,
        isGitRepo: true,
        message: `Unstaged ${files.length} file${files.length === 1 ? '' : 's'}.`,
      }
      res.json(response)
    } catch (error) {
      const response: LocalGitActionResponse = {
        ok: false,
        isGitRepo: true,
        message: buildGitActionMessage(error, 'Failed to unstage files.'),
      }
      res.status(500).json(response)
    }
  })

  app.post('/api/local/git/checkout', async (req, res): Promise<void> => {
    const requestedPath = String(req.body?.path || '').trim()
    const branch = String(req.body?.branch || '').trim()

    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    if (!branch) {
      res.status(400).json({ error: 'branch is required' })
      return
    }

    try {
      const gitContext = await resolveGitContext(requestedPath)
      if (!gitContext) {
        const response: LocalGitActionResponse = {
          ok: false,
          isGitRepo: false,
          message: 'Git repository not detected for this path.',
        }
        res.status(400).json(response)
        return
      }

      await runGit(gitContext.repoRootFs, ['checkout', branch])
      const response: LocalGitActionResponse = {
        ok: true,
        isGitRepo: true,
        message: `Checked out ${branch}.`,
      }
      res.json(response)
    } catch (error) {
      const response: LocalGitActionResponse = {
        ok: false,
        isGitRepo: true,
        message: buildGitActionMessage(error, 'Failed to checkout branch.'),
      }
      res.status(500).json(response)
    }
  })

  app.post('/api/local/git/branch', async (req, res): Promise<void> => {
    const requestedPath = String(req.body?.path || '').trim()
    const branch = String(req.body?.branch || '').trim()
    const checkout = parseBooleanQueryParam(String(req.body?.checkout ?? 'true'), true)

    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    if (!branch) {
      res.status(400).json({ error: 'branch is required' })
      return
    }

    try {
      const gitContext = await resolveGitContext(requestedPath)
      if (!gitContext) {
        const response: LocalGitActionResponse = {
          ok: false,
          isGitRepo: false,
          message: 'Git repository not detected for this path.',
        }
        res.status(400).json(response)
        return
      }

      if (checkout) {
        await runGit(gitContext.repoRootFs, ['checkout', '-b', branch])
      } else {
        await runGit(gitContext.repoRootFs, ['branch', branch])
      }

      const response: LocalGitActionResponse = {
        ok: true,
        isGitRepo: true,
        message: checkout ? `Created and checked out ${branch}.` : `Created branch ${branch}.`,
      }
      res.json(response)
    } catch (error) {
      const response: LocalGitActionResponse = {
        ok: false,
        isGitRepo: true,
        message: buildGitActionMessage(error, 'Failed to create branch.'),
      }
      res.status(500).json(response)
    }
  })
}
