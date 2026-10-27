import { createServer, type Server } from 'node:http'
import express from 'express'
import { HookGenerationService } from '../hookGenerationService.js'
import { registerYggHookGenerateRoute } from '../../routes/ephemeralGenerateRoutes.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ directory: '' }))
// Keep discovery/initialization away from the real managed hooks and user profile.
vi.mock('../../../hooks/hookStorage.js', () => ({
  ensureManagedHooksInitialized: async () => storage.directory,
  getManagedHooksDirectory: () => storage.directory,
}))
import { runHookRequest } from '../../../hooks/hookRunner.js'
import { createChatHookSession } from '../chatHookService.js'

describe('Claude branch-note Stop command integration', () => {
  let directory: string
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['sync', 'openaichatgpt', false], ['async', 'claudecode', false], ['async', 'claudecode', true],
  ] as const)('executes the Python note writer via the real generation route (%s, %s, legacy=%s)', async (executionMode, provider, legacy) => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'claude-stop-hook-'))
    storage.directory = path.join(directory, '.ygg')
    mkdirSync(path.join(storage.directory, 'hooks'), { recursive: true })
    let script = readFileSync(path.resolve('.ygg/hooks/root_note_stop.py'), 'utf8')
    if (legacy) script = script.replace("'systemPrompt': SYSTEM_PROMPT,", "'provider': 'openai', 'modelName': 'obsolete-model', 'systemPrompt': SYSTEM_PROMPT,")
    writeFileSync(path.join(storage.directory, 'hooks/root_note_stop.py'), script)
    writeFileSync(path.join(storage.directory, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{
      type: 'command', command: 'python3 .ygg/hooks/root_note_stop.py', executionMode, timeoutMs: 10000,
    }] }] } }))
    const messages = [
      { id: 'root', parent_id: null, role: 'user', content: 'root question' },
      { id: 'a0', parent_id: 'root', role: 'assistant', content: 'root answer' },
      { id: 'sibling', parent_id: 'a0', role: 'user', content: 'other branch' },
      { id: 'branch', parent_id: 'a0', role: 'user', content: 'fix branch issue', note: '' },
      { id: 'tool-turn', parent_id: 'branch', role: 'assistant', content: 'using native tools' },
      { id: 'final', parent_id: 'tool-turn', role: 'assistant', content: 'Claude final answer' },
    ]
    const generations: any[] = []
    const updates: any[] = []
    const generated = { text: JSON.stringify({ updated: true, note: '## branch fix\n- Fixed the branch issue.', note_color: '#ef4444' }), modelName: 'resolved-model' }
    const openAi = vi.fn(async (input: any) => { generations.push(input); return generated })
    const claude = vi.fn(async (input: any) => { generations.push(input); return generated })
    const app = express()
    app.use(express.json())
    registerYggHookGenerateRoute(app, new HookGenerationService({ preferences: () => ({ provider, openAiModel: 'gpt-6-luna', claudeModel: 'haiku' }),
      openAiStatus: () => 'ready', openAi, claude }))
    app.use(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/app/conversations/c1/messages') {
        res.end(JSON.stringify(messages))
        return
      }
      const payload = req.body
      if (req.url === '/api/app/messages/branch' && req.method === 'PUT') {
        updates.push(payload)
        res.end(JSON.stringify({ success: true }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Unexpected fixture callback' }))
      }
    })
    server = createServer(app)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const events: any[] = []
    const session = createChatHookSession({ conversationRepo: { listMessageLineage: () => messages },
      runHook: runHookRequest, conversationId: 'c1', cwd: directory, provider: 'claudecode', model: 'claude-sonnet-5-5',
      operation: 'send', streamId: 'claude-stream', lineageId: 'claude-lineage',
      localApiBase: `http://127.0.0.1:${address.port}/api`, emit: event => events.push(event) })
    expect(await session.runStop({ assistantMessage: messages.at(-1), streamId: 'claude-stream', lastUserMessageId: 'branch' })).toBe(false)
    await expect.poll(() => events.some(event => event.type === 'hook_activity' && event.runs.some((run: any) => run.status === 'succeeded')), { timeout: 15000 }).toBe(true)
    expect(generations).toHaveLength(1)
    expect(openAi).toHaveBeenCalledTimes(provider === 'openaichatgpt' ? 1 : 0)
    expect(claude).toHaveBeenCalledTimes(provider === 'claudecode' ? 1 : 0)
    expect(generations[0].content).toContain('Latest user message:\nfix branch issue')
    expect(generations[0].content).toContain('Latest assistant message:\nClaude final answer')
    expect(updates).toEqual([{ note: '## branch fix\n- Fixed the branch issue.', note_color: '#ef4444' }])
    expect(events.filter(event => event.type === 'hook_activity').every(event => event.lineageId === 'claude-lineage' && event.messageId === 'final')).toBe(true)
  }, 20000)
})
