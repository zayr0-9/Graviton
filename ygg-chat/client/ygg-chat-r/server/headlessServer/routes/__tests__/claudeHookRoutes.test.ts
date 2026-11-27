import express from 'express'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerClaudeHookRoutes } from '../claudeHookRoutes.js'

let sandbox: string
let server: Server | undefined
let project: string
let conversation: string
let profile: string
let url: string

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'claude-hook-inventory-'))
  project = path.join(sandbox, 'project')
  conversation = path.join(sandbox, 'chat-folder')
  profile = path.join(sandbox, 'profile')
  await Promise.all([mkdir(path.join(project, '.claude'), { recursive: true }), mkdir(path.join(conversation, '.claude'), { recursive: true }), mkdir(profile)])
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  const app = express()
  registerClaudeHookRoutes(app, {
    statements: { getConversationById: { get: (id: string) => id === 'chat' ? { project_id: 'project', cwd: conversation } : undefined } },
    db: { prepare: () => ({ get: (id: string) => id === 'project' ? { cwd: project } : undefined }) },
  })
  server = createServer(app)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  url = `http://127.0.0.1:${address.port}/api/headless/claude/hooks`
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  server = undefined
  await rm(sandbox, { recursive: true, force: true })
})

it('lists settings metadata by source without revealing hook payloads or executing anything', async () => {
  const marker = path.join(sandbox, 'ran')
  await writeFile(path.join(conversation, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: `touch '${marker}'` }, { type: 'http', url: 'https://example.invalid/hidden', headers: { Authorization: 'secret' } },
  ] }] } }))
  await writeFile(path.join(conversation, '.claude/settings.local.json'), '{invalid')
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'private prompt' }] }] } }))
  const response = await fetch(`${url}?conversationId=chat&projectId=project`)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ cwd: conversation, sources: [
    { source: 'project', file: '.claude/settings.json', status: 'read', hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command' }, { event: 'PreToolUse', matcher: 'Bash', type: 'http' }] },
    { source: 'local', file: '.claude/settings.local.json', status: 'invalid', hooks: [] },
    { source: 'user', file: 'Claude config directory/settings.json', status: 'read', hooks: [{ event: 'Stop', matcher: null, type: 'prompt' }] },
  ] })
  const { stat } = await import('node:fs/promises')
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not take an arbitrary cwd and rejects missing or ambiguous IDs', async () => {
  const result = await (await fetch(`${url}?projectId=project&cwd=${encodeURIComponent(conversation)}`)).json()
  expect(result.cwd).toBe(project)
  expect(result.sources[0]).toMatchObject({ source: 'project', status: 'missing' })
  expect((await fetch(`${url}?conversationId=unknown`)).status).toBe(404)
  expect((await fetch(`${url}?projectId=project&projectId=chat`)).status).toBe(400)
  expect(await (await fetch(url)).json()).toMatchObject({ cwd: null, sources: [{ source: 'user' }] })
})

it('does not read symlinked workspace settings and reports oversized files separately', async () => {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }))
  if (process.platform !== 'win32') await symlink(path.join(profile, 'settings.json'), path.join(project, '.claude/settings.json'))
  await writeFile(path.join(project, '.claude/settings.local.json'), ' '.repeat(512 * 1024 + 1))
  const result = await (await fetch(`${url}?projectId=project`)).json()
  expect(result.sources[0]).toMatchObject({ status: process.platform === 'win32' ? 'missing' : 'unreadable', hooks: [] })
  expect(result.sources[1]).toMatchObject({ status: 'limited', hooks: [] })
})
