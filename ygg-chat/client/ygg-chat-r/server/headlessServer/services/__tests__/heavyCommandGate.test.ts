import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  HeavyCommandBusyError,
  HeavyCommandGate,
  isHeavyShellCommand,
  resolveHeavyCommandWorkspace,
} from '../heavyCommandGate.js'
import { createOrchestratorToolExecutor } from '../../index.js'

describe('isHeavyShellCommand', () => {
  // Commands agents actually ran concurrently during the 2026-11-25 34 GB incident.
  it.each([
    'ELECTRON_RUN_AS_NODE=1 "$(node -p "require(\'electron\')")" node_modules/vitest/vitest.mjs run --config vitest.headless.config.ts decisionBroker',
    'npm run test:renderer -- TranscriptRevision sseProjection',
    'npm run build:electron',
    'npm run build:electron:main',
    './node_modules/.bin/tsc -p tsconfig.app.json --noEmit',
    'timeout 300 npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -E "Chat" | head -30',
    'node -e "x"; npm run typecheck:server',
    'npx vitest run --config vitest.renderer.config.ts 2>&1 | tail -40',
    'npm --prefix client/ygg-chat-r run test:headless',
    'npm test',
    'pnpm build',
    'yarn run lint',
    'bun test',
    'npx vite build',
    'cargo test --workspace',
    'go test ./...',
    'cd client && npx jest',
  ])('gates %s', command => {
    expect(isHeavyShellCommand(command)).toBe(true)
  })

  it.each([
    'git status --short',
    'cat vitest.renderer.config.ts',
    'ls tsconfig*.json',
    'npm install',
    'npm i -D left-pad',
    'node -p "process.versions.modules"',
    'ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p "process.versions.modules"',
    'rg -n "testing" src',
    'npm run dev',
    '',
  ])('does not gate %s', command => {
    expect(isHeavyShellCommand(command)).toBe(false)
  })
})

describe('resolveHeavyCommandWorkspace', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'heavy-gate-')))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('keys every subdirectory of a repository to its root', () => {
    expect(resolveHeavyCommandWorkspace('npm test', undefined, repo)).toBe(repo)
    expect(resolveHeavyCommandWorkspace('npm test', 'packages/app', repo)).toBe(repo)
    expect(resolveHeavyCommandWorkspace('npm test', path.join(repo, 'packages', 'app'), '/elsewhere')).toBe(repo)
    expect(resolveHeavyCommandWorkspace('cd packages/app && npm test', undefined, repo)).toBe(repo)
  })

  it('follows a leading cd out of the workspace root', () => {
    const other = path.join(root, 'other')
    mkdirSync(other, { recursive: true })
    expect(resolveHeavyCommandWorkspace(`cd ${other} && npm test`, undefined, repo)).toBe(other)
  })
})

describe('HeavyCommandGate', () => {
  it('runs one holder per workspace and grants waiters in order', async () => {
    const gate = new HeavyCommandGate()
    const order: string[] = []
    const releaseA = await gate.acquire('/repo', 'a')
    const b = gate.acquire('/repo', 'b').then(release => { order.push('b'); return release })
    const c = gate.acquire('/repo', 'c').then(release => { order.push('c'); return release })
    const other = await gate.acquire('/other-repo', 'd')
    await Promise.resolve()
    expect(order).toEqual([])

    releaseA()
    const releaseB = await b
    expect(order).toEqual(['b'])
    releaseB()
    releaseB()
    const releaseC = await c
    expect(order).toEqual(['b', 'c'])
    releaseC()
    other()
    expect(gate.snapshot()).toEqual([])
  })

  it('rejects an aborted waiter without blocking later waiters', async () => {
    const gate = new HeavyCommandGate()
    const release = await gate.acquire('/repo', 'a')
    const controller = new AbortController()
    const aborted = gate.acquire('/repo', 'b', { signal: controller.signal })
    const next = gate.acquire('/repo', 'c')
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    release()
    ;(await next)()
    expect(gate.snapshot()).toEqual([])
  })

  it('fails with a not-started error when the wait budget runs out', async () => {
    const gate = new HeavyCommandGate()
    const release = await gate.acquire('/repo', 'npm run build:electron')
    const waiting = gate.acquire('/repo', 'npx tsc --noEmit', { waitUntilMs: Date.now() + 20 })
    await expect(waiting).rejects.toBeInstanceOf(HeavyCommandBusyError)
    await expect(waiting).rejects.toThrow(/Not started: another heavy command \("npm run build:electron"\)/)
    release()
    expect(gate.snapshot()).toEqual([])
  })
})

describe('createOrchestratorToolExecutor heavy command gating', () => {
  function fakeOrchestrator() {
    const jobs = new Map<string, { status: string; result?: unknown; command: string }>()
    const submitted: string[] = []
    let next = 0
    return {
      submitted,
      finish(command: string) {
        for (const job of jobs.values()) if (job.command === command) Object.assign(job, { status: 'completed', result: { ok: command } })
      },
      orchestrator: {
        submit: (_name: string, args: Record<string, any>) => {
          const id = `job-${next++}`
          jobs.set(id, { status: 'running', command: args.command })
          submitted.push(args.command)
          return { id } as any
        },
        getJob: (id: string) => jobs.get(id) as any,
        cancel: () => true,
      },
    }
  }

  const call = (id: string, command: string) => ({ id, name: 'bash', arguments: { command, description: 'x' } })
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    expect(check()).toBe(true)
  }

  it('holds a second heavy command in the same workspace until the first finishes', async () => {
    const fake = fakeOrchestrator()
    const execute = createOrchestratorToolExecutor(fake.orchestrator as any, new HeavyCommandGate())
    const context = { rootPath: '/tmp/heavy-gate-same-workspace', timeoutMs: 60_000 } as any

    const first = execute(call('1', 'npm run build') as any, context)
    const second = execute(call('2', 'npx tsc --noEmit') as any, context)
    const light = execute(call('3', 'git status') as any, context)
    await waitFor(() => fake.submitted.length === 2)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect([...fake.submitted].sort()).toEqual(['git status', 'npm run build'])

    fake.finish('git status')
    fake.finish('npm run build')
    await expect(first).resolves.toEqual({ ok: 'npm run build' })
    await expect(light).resolves.toEqual({ ok: 'git status' })
    await waitFor(() => fake.submitted.includes('npx tsc --noEmit'))
    fake.finish('npx tsc --noEmit')
    await expect(second).resolves.toEqual({ ok: 'npx tsc --noEmit' })
  })

  it('does not serialize heavy commands in different workspaces', async () => {
    const fake = fakeOrchestrator()
    const execute = createOrchestratorToolExecutor(fake.orchestrator as any, new HeavyCommandGate())
    const a = execute(call('1', 'npm test') as any, { rootPath: '/tmp/heavy-gate-a', timeoutMs: 60_000 } as any)
    const b = execute(call('2', 'npm test') as any, { rootPath: '/tmp/heavy-gate-b', timeoutMs: 60_000 } as any)
    await waitFor(() => fake.submitted.length === 2)
    fake.finish('npm test')
    await expect(Promise.all([a, b])).resolves.toHaveLength(2)
  })
})
