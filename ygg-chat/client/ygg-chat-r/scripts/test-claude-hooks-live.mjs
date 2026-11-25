// Opt-in integration probe against the installed CLI. Uses a loopback model stub and a temporary
// Claude profile; no real provider credentials, user settings or workspace files are used.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const root = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-hooks-'))
const config = path.join(root, 'profile')
const cwd = path.join(root, 'repo')
const plugin = path.join(root, 'test-plugin')
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']
const marker = (label, event) => path.join(root, `${label}-${event}`)
const hooks = label => Object.fromEntries(events.map(event => [event, [{
  hooks: [{ type: 'command', command: `touch '${marker(label, event)}'` }],
}]]))
const model = 'claude-haiku-5-5'
let offeredBash = false
const server = createServer(async (req, res) => {
  try {
    const body = JSON.parse((await Array.fromAsync(req)).join('') || '{}')
    if (req.url?.includes('/count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":10}'); return }
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return }
    const useBash = !offeredBash && body.tools?.some(tool => tool.name === 'Bash')
    if (useBash) offeredBash = true
    const stop = useBash ? 'tool_use' : 'end_turn'
    const block = useBash ? { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: {} } : { type: 'text', text: '' }
    const delta = useBash ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: `touch '${marker('builtin', 'Bash')}'` }) } : { type: 'text_delta', text: 'OK' }
    res.setHeader('Content-Type', 'text/event-stream')
    const event = (type, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message: { id: 'msg_probe', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    event('content_block_start', { index: 0, content_block: block })
    event('content_block_delta', { index: 0, delta })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
    event('message_stop')
    res.end()
  } catch { res.writeHead(400).end() }
})

try {
  await mkdir(config)
  const skill = path.join(cwd, '.claude/skills/probe-skill')
  await mkdir(skill, { recursive: true })
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: probe-skill
description: Synthetic hook policy test skill
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: "touch '${marker('skill', 'PreToolUse')}'"
---
Synthetic test skill.\n`)
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true })
  await mkdir(path.join(plugin, 'hooks'))
  await writeFile(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'graviton-fixture' }))
  await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: hooks('plugin') }))
  for (const [label, file] of [['user', path.join(config, 'settings.json')], ['project', path.join(cwd, '.claude/settings.json')], ['local', path.join(cwd, '.claude/settings.local.json')]]) {
    await writeFile(file, JSON.stringify({ disableAllHooks: false, hooks: hooks(label), permissions: { allow: ['Bash'] } }))
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'synthetic-hook-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const executable = process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude')
  async function run(blocked, extraSettings = {}, resume, content = 'Hook policy fixture.') {
    offeredBash = false
    let guard = 0
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), 20_000)
    let finish
    const done = new Promise(resolve => { finish = resolve })
    async function* prompts() {
      yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } }
      await done
    }
    const q = query({ prompt: prompts(), options: { cwd, model, env, abortController, pathToClaudeCodeExecutable: executable,
      settingSources: ['user', 'project', 'local'], tools: ['Bash'], strictMcpConfig: true, mcpServers: {}, ...(resume ? { resume } : {}),
      plugins: [{ type: 'local', path: plugin }],
      settings: { ...(blocked ? { disableAllHooks: true } : {}), ...extraSettings },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async () => {
        guard++
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Probe guard' } }
      }] }] } } })
    let result
    try {
      for await (const event of q) if (event.type === 'result') { result = event; finish() }
    } finally { finish(); clearTimeout(timer); q.close() }
    assert.equal(result?.subtype, 'success')
    assert(offeredBash && guard > 0, 'SDK PreToolUse permission guard ran')
    assert(!existsSync(marker('builtin', 'Bash')), 'The guard blocked the tool even with a native allow rule')
    return result.session_id
  }
  const external = ['user', 'project', 'local', 'plugin']
  await run(false)
  for (const label of external) for (const event of events) assert(existsSync(marker(label, event)), `${label} ${event} positive control`)
  for (const label of external) for (const event of events) await rm(marker(label, event))
  const session = await run(true, { hooks: hooks('overlay') })
  for (const label of [...external, 'overlay']) for (const event of events) assert(!existsSync(marker(label, event)), `${label} ${event} blocked`)
  await run(true, {}, session)
  for (const label of external) for (const event of events) assert(!existsSync(marker(label, event)), `${label} ${event} blocked on resume`)
  await run(false, {}, undefined, '/probe-skill')
  assert(existsSync(marker('skill', 'PreToolUse')), 'Skill frontmatter positive control')
  await rm(marker('skill', 'PreToolUse'))
  await run(true, {}, undefined, '/probe-skill')
  assert(!existsSync(marker('skill', 'PreToolUse')), 'Skill frontmatter hook blocked')
  console.log('PASS: unmanaged settings, plugin and skill hooks blocked; SDK PreToolUse remains active. The flag also blocks injected settings hooks, so it is not a selective allowlist.')
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
