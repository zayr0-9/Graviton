import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookRunRequest, HookRunResult } from '../hooks/hookTypes.js'

// runHookRequest discovers settings through the managed hooks directory, which
// hookStorage caches at module scope — so every test gets a fresh module graph
// pointed (via env) at its own temp directory.
describe('runHookRequest resolveLineage', () => {
  let managed: string
  let runHookRequest: (req: HookRunRequest) => Promise<HookRunResult>

  beforeEach(async () => {
    managed = await fs.mkdtemp(path.join(os.tmpdir(), 'graviton-hook-runner-'))
    vi.stubEnv('YGG_HOOKS_DIRECTORY', managed)
    // Template == managed: initialization has nothing to seed and never asks Electron.
    vi.stubEnv('YGG_HOOKS_TEMPLATE_DIRECTORY', managed)
    vi.resetModules()
    ;({ runHookRequest } = await import('../hooks/hookRunner.js'))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    await fs.rm(managed, { recursive: true, force: true })
  })

  const settings = (hooks: unknown) => fs.writeFile(path.join(managed, 'settings.local.json'), JSON.stringify({ hooks }))
  const lineage = { messageId: 'a1', parentId: 'u1', lineage: { rootMessageId: 'u1', ancestorIds: ['u1', 'a1'], depth: 1, isRoot: false } }
  const request = (toolName: string, resolveLineage: () => typeof lineage): HookRunRequest => ({
    event: 'PreToolUse',
    conversationId: 'c1',
    cwd: managed,
    toolCall: { id: 't1', name: toolName, arguments: {} },
    messageId: 'a1',
    resolveLineage,
  })

  it('is not called when no handler exists for the event', async () => {
    await settings({ Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] })
    const resolveLineage = vi.fn(() => lineage)
    const result = await runHookRequest(request('bash', resolveLineage))
    expect(result.matched).toBe(false)
    expect(resolveLineage).not.toHaveBeenCalled()
  })

  it('is not called when the only handler has a non-matching tool matcher', async () => {
    await settings({ PreToolUse: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'true' }] }] })
    const resolveLineage = vi.fn(() => lineage)
    const result = await runHookRequest(request('bash', resolveLineage))
    expect(result.matched).toBe(false)
    expect(resolveLineage).not.toHaveBeenCalled()
  })

  it('is called once on a match and its fields reach the hook payload', async () => {
    const payloadFile = path.join(managed, 'payload.json')
    await settings({ PreToolUse: [{ matcher: 'read_file', hooks: [{ type: 'command', command: `cat > "${payloadFile}"` }] }] })
    const resolveLineage = vi.fn(() => lineage)
    const result = await runHookRequest(request('read_file', resolveLineage))
    expect(result.matched).toBe(true)
    expect(resolveLineage).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(await fs.readFile(payloadFile, 'utf8'))
    expect(payload.message_id).toBe('a1')
    expect(payload.parent_id).toBe('u1')
    expect(payload.lineage).toEqual({ root_message_id: 'u1', ancestor_ids: ['u1', 'a1'], depth: 1, is_root: false })
  }, 20_000)
})
