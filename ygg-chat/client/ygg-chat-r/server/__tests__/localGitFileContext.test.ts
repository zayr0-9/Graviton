import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { registerLocalOperationsRoutes } from '../localOperations.js'
import type { LocalGitFileContextResponse, LocalGitDiffResponse } from '../../shared/localGit.js'

const execFile = promisify(execFileCb)
const git = (cwd: string, ...args: string[]) => execFile('git', ['-C', cwd, ...args], { timeout: 10000 })

describe('Git file-owned repository context', () => {
  let root: string
  let repo: string
  let sibling: string
  let nested: string
  let server: Server
  let baseUrl: string

  const write = async (directory: string, name: string, content: string) => {
    const target = path.join(directory, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  const initRepo = async (directory: string) => {
    await fs.mkdir(directory, { recursive: true })
    await git(directory, 'init')
    await git(directory, 'config', 'user.name', 'Git diff test')
    await git(directory, 'config', 'user.email', 'test@example.invalid')
    await git(directory, 'config', 'commit.gpgsign', 'false')
    await write(directory, 'src/file.ts', 'before\n')
    await write(directory, 'gone/deep/deleted.ts', 'deleted\n')
    await git(directory, 'add', '.')
    await git(directory, '-c', 'core.hooksPath=', 'commit', '-m', 'fixture')
    await write(directory, 'src/file.ts', 'after\n')
  }
  const context = async (file: string, basePath?: string) => {
    const params = new URLSearchParams({ path: file })
    if (basePath) params.set('basePath', basePath)
    const response = await fetch(`${baseUrl}/git/file-context?${params}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<LocalGitFileContextResponse>
  }
  const diff = async (resolved: LocalGitFileContextResponse, staged = false) => {
    const params = new URLSearchParams({ path: resolved.repoRoot!, file: resolved.relativePath!, staged: String(staged) })
    const response = await fetch(`${baseUrl}/git/diff?${params}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<LocalGitDiffResponse>
  }

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-file-context-')))
    repo = path.join(root, 'repo')
    sibling = path.join(root, 'sibling')
    nested = path.join(repo, 'nested')
    await initRepo(repo)
    await initRepo(sibling)
    await initRepo(nested)
    await fs.rm(path.join(repo, 'gone'), { recursive: true })
    await write(repo, 'new/untracked.ts', 'new\n')
    await write(repo, 'staged.ts', 'staged\n')
    await git(repo, 'add', 'staged.ts')
    const app = express()
    registerLocalOperationsRoutes(app)
    server = await new Promise<Server>(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    baseUrl = `http://127.0.0.1:${address.port}/api/local`
  }, 30000)

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('resolves a file below a non-repository CWD and loads its actual diff', async () => {
    const resolved = await context('repo/src/file.ts', root)
    expect(resolved.repoRoot).toBe(repo)
    expect(resolved.relativePath).toBe('src/file.ts')
    expect(resolved.status?.unstaged).toBe(true)
    const result = await diff(resolved)
    expect(result.original?.content).toBe('before\n')
    expect(result.modified?.content).toBe('after\n')
  })

  it('chooses the inner repository even when the CWD is also a repository', async () => {
    const resolved = await context(path.join(nested, 'src/file.ts'), repo)
    expect(resolved.repoRoot).toBe(nested)
    expect(resolved.relativePath).toBe('src/file.ts')
    expect((await diff(resolved)).modified?.content).toBe('after\n')
  })

  it('keeps identical relative paths in sibling repositories independent', async () => {
    const first = await context('repo/src/file.ts', root)
    const second = await context('sibling/src/file.ts', root)
    expect(first.repoRoot).toBe(repo)
    expect(second.repoRoot).toBe(sibling)
    expect(first.relativePath).toBe(second.relativePath)
  })

  it('walks past deleted parent directories', async () => {
    const resolved = await context(path.join(repo, 'gone/deep/deleted.ts'))
    expect(resolved.repoRoot).toBe(repo)
    expect(resolved.relativePath).toBe('gone/deep/deleted.ts')
    expect(resolved.status?.isDeleted).toBe(true)
    const result = await diff(resolved)
    expect(result.original?.content).toBe('deleted\n')
    expect(result.modified?.content).toBe('')
  })

  it('preserves untracked and staged-only status for choosing the diff view', async () => {
    const untracked = await context(path.join(repo, 'new/untracked.ts'))
    expect(untracked.status?.untracked).toBe(true)
    expect((await diff(untracked)).modified?.content).toBe('new\n')
    const staged = await context(path.join(repo, 'staged.ts'))
    expect(staged.status?.staged).toBe(true)
    expect(staged.status?.unstaged).toBe(false)
    expect((await diff(staged, true)).modified?.content).toBe('staged\n')
  })

  it('returns no repository for files outside Git, including missing parents', async () => {
    const resolved = await context(path.join(root, 'outside/missing/file.ts'))
    expect(resolved.repoRoot).toBeNull()
    expect(resolved.status).toBeNull()
  })

  it('discovers a linked worktree whose .git is a file', async () => {
    const worktree = path.join(root, 'worktree')
    await git(repo, 'worktree', 'add', '--detach', worktree)
    await write(worktree, 'src/file.ts', 'worktree change\n')
    const resolved = await context(path.join(worktree, 'src/file.ts'))
    expect(resolved.repoRoot).toBe(worktree)
    expect((await diff(resolved)).modified?.content).toBe('worktree change\n')
  })

  it('handles clean files without inventing a status entry', async () => {
    const resolved = await context(path.join(sibling, 'gone/deep/deleted.ts'))
    expect(resolved.repoRoot).toBe(sibling)
    expect(resolved.status).toBeNull()
    expect((await diff(resolved)).diff).toBe('')
  })

  it('rejects missing paths and relative paths without a base', async () => {
    expect((await fetch(`${baseUrl}/git/file-context`)).status).toBe(400)
    expect((await fetch(`${baseUrl}/git/file-context?path=src/file.ts`)).status).toBe(400)
  })

  it.skipIf(process.platform === 'win32')('supports repository paths reached through a symlink', async () => {
    const alias = path.join(root, 'alias')
    await fs.symlink(repo, alias, 'dir')
    const resolved = await context(path.join(alias, 'src/file.ts'))
    expect(resolved.repoRoot).toBe(alias)
    expect(resolved.relativePath).toBe('src/file.ts')
    expect((await diff(resolved)).modified?.content).toBe('after\n')
  })
})
