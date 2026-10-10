export type LocalGitStatusGroupKey = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

export interface LocalGitStatusFile {
  path: string
  relativePath: string
  displayPath: string
  oldPath?: string | null
  oldDisplayPath?: string | null
  code: string
  x: string
  y: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  isRenamed: boolean
  isDeleted: boolean
  categories: LocalGitStatusGroupKey[]
}

export interface LocalGitRepoSummary {
  repoRoot: string
  repoName: string
  currentBranch: string | null
  headShortSha: string | null
  detached: boolean
  upstreamBranch: string | null
  ahead: number
  behind: number
  remoteUrl: string | null
  isClean: boolean
  changedFilesCount: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
}

export interface LocalGitCommit {
  hash: string
  shortHash: string
  author: string
  relativeDate: string
  decorations: string
  subject: string
}

export interface LocalGitBranch {
  name: string
  current: boolean
  remote: boolean
  upstream: string | null
  shortHash: string | null
  relativeDate: string | null
  subject: string | null
}

export interface LocalGitStatusGroups {
  staged: LocalGitStatusFile[]
  unstaged: LocalGitStatusFile[]
  untracked: LocalGitStatusFile[]
  conflicted: LocalGitStatusFile[]
  all: LocalGitStatusFile[]
}

export interface LocalGitBranchCollection {
  local: LocalGitBranch[]
  remote: LocalGitBranch[]
}

export interface LocalGitOverviewResponse {
  requestedPath: string
  isGitRepo: boolean
  summary: LocalGitRepoSummary | null
  status: LocalGitStatusGroups
  commits: LocalGitCommit[]
  commitGraphLines: string[]
  branches: LocalGitBranchCollection
}

export interface LocalGitDiffSide {
  path: string | null
  label: string
  content: string
}

export interface LocalGitDiffResponse {
  requestedPath: string
  isGitRepo: boolean
  repoRoot: string | null
  file: string
  staged: boolean
  diff: string
  truncated: boolean
  message: string | null
  languageHint: string | null
  preferPatch: boolean
  original: LocalGitDiffSide | null
  modified: LocalGitDiffSide | null
}

export interface LocalGitActionResponse {
  ok: boolean
  isGitRepo: boolean
  message: string
}

export interface LocalGitFileContextResponse {
  path: string
  repoRoot: string | null
  relativePath: string | null
  status: LocalGitStatusFile | null
}
