// Opt-in native SDK probe for ultracode / the Workflow tool. Uses normal Claude account usage; only test-created
// sessions/workspace. Shows how background workflow tasks appear in the stream, and what closing input does to them.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

if (process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1') throw new Error('Set CLAUDE_PROVIDER_LIVE_TEST=1 to opt into normal Claude usage')
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-workflow-')))
const binary = process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude')
const env = { ...process.env }
delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
const READ_ONLY = new Set(['Workflow', 'Agent', 'Read', 'Glob', 'Grep', 'TaskGet', 'TaskList', 'TaskOutput'])
const clip = (value, size = 220) => { const s = String(value ?? '').replace(/\s+/g, ' '); return s.length > size ? s.slice(0, size) + '…' : s }
const text = content => typeof content === 'string' ? content
  : (content ?? []).map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? `[tool_result ${text(block.content)}]`
    : block.type === 'tool_use' ? `[tool_use ${block.name} ${clip(JSON.stringify(block.input), 160)}]` : `[${block.type}]`).join(' ')
const log = (t0, value) => console.log(JSON.stringify({ ms: Date.now() - t0, ...value }))
const TASK_EVENTS = /^(task_|background_tasks_changed|status|informational|notification)/

/**
 * `closeAfterFirstResult` mirrors Graviton before this change: input closes at the first `result`.
 * Otherwise input stays open while non-ambient background tasks run, then closes after a quiet spell.
 */
async function scenario(label, { prompt, ultracode, closeAfterFirstResult }) {
  console.log(`\n=== ${label} ===`)
  const t0 = Date.now()
  const inbox = [{ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: randomUUID(), session_id: '' }]
  let wake = () => {}
  let closed = false
  async function* prompts() {
    while (!closed) {
      if (!inbox.length) { await new Promise(resolve => { wake = resolve }); continue }
      yield inbox.shift()
    }
  }
  const closeInput = () => { if (!closed) log(t0, { input: 'closed' }); closed = true; wake() }
  const controller = new AbortController()
  const timer = setTimeout(() => { log(t0, { timeout: true }); controller.abort() }, Number(process.env.CLAUDE_WORKFLOW_TIMEOUT_MS || 420_000))
  const q = query({ prompt: prompts(), options: {
    cwd, pathToClaudeCodeExecutable: binary, model: process.env.CLAUDE_WORKFLOW_MODEL || 'claude-sonnet-5-5',
    settingSources: [], strictMcpConfig: true, mcpServers: {},
    settings: { disableAllHooks: true, ...(ultracode ? { ultracode: true } : {}) },
    permissionMode: 'default', permissionPrompts: 'host', includePartialMessages: true, env, abortController: controller,
    canUseTool: async (name, input) => {
      const allowed = READ_ONLY.has(name) || (name === 'Bash' && /^\s*(sleep|echo)\b/.test(String(input?.command ?? '')))
      log(t0, { canUseTool: name, allowed })
      return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Read-only probe' }
    },
  } })
  let liveTasks = []
  let results = 0
  let idleTimer
  const settle = () => {
    clearTimeout(idleTimer)
    if (!liveTasks.length) idleTimer = setTimeout(closeInput, 20_000)
  }
  try {
    for await (const event of q) {
      if (event.type === 'stream_event' || event.type === 'rate_limit_event') continue
      if (event.type === 'system' && event.subtype === 'init') {
        log(t0, { init: { model: event.model, permissionMode: event.permissionMode, workflow: event.tools?.includes('Workflow'),
          agent: event.tools?.includes('Agent'), extra: Object.keys(event).filter(key => /ultra|workflow|effort/i.test(key)) } })
        continue
      }
      if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
        liveTasks = event.tasks.filter(task => !task.ambient)
        log(t0, { background: event.tasks.map(task => ({ id: task.task_id, type: task.task_type, ambient: task.ambient, desc: clip(task.description, 80) })) })
        if (results && !closeAfterFirstResult) settle()
        continue
      }
      if (event.type === 'system' && TASK_EVENTS.test(event.subtype)) {
        const { type, session_id, uuid, ...rest } = event
        log(t0, { system: clip(JSON.stringify(rest), 600) })
        continue
      }
      if (event.type === 'system') continue
      if (event.type === 'assistant' || event.type === 'user') {
        log(t0, { [event.type]: clip(text(event.message.content), 400), parent: event.parent_tool_use_id ?? undefined,
          synthetic: event.isSynthetic || undefined, replay: event.isReplay || undefined })
        continue
      }
      if (event.type === 'result') {
        results += 1
        log(t0, { result: event.subtype, isError: event.is_error, numTurns: event.num_turns, text: clip(event.result, 300), liveTasks: liveTasks.length })
        if (closeAfterFirstResult) closeInput()
        else settle()
        continue
      }
      if (event.type === 'command_lifecycle') { log(t0, { lifecycle: event.state }); continue }
      if (event.type === 'tool_progress') continue
      log(t0, { other: event.type, subtype: event.subtype })
    }
  } catch (error) {
    log(t0, { streamEnded: clip(error?.message, 300) })
  } finally { clearTimeout(idleTimer); clearTimeout(timer); closeInput(); q.close() }
}

const ask = 'Use the Workflow tool to run a tiny workflow of exactly two agents in parallel: the first agent replies with only the word RED, ' +
  'the second with only the word BLUE. The agents must not use any tools. When the workflow finishes, reply with both words and nothing else.'
// Long enough that the first `result` (and any input close) lands well before the agents finish.
const slow = 'Use the Workflow tool to run a tiny workflow of exactly two agents in parallel. The first agent must use Bash to run ' +
  '`sleep 25 && echo RED` and reply with its output; the second the same with `sleep 25 && echo BLUE`. ' +
  'When the workflow finishes, reply with both words and nothing else.'
try {
  const only = process.env.CLAUDE_WORKFLOW_SCENARIO
  if (!only || only === 'open') await scenario('A: ultracode setting, input kept open while background tasks run', { prompt: ask, ultracode: true })
  if (!only || only === 'closed') await scenario('B: ultracode setting, input closed at the first result', { prompt: ask, ultracode: true, closeAfterFirstResult: true })
  if (!only || only === 'keyword') await scenario('C: no setting, "ultracode" keyword in the prompt', { prompt: `ultracode ${ask}` })
  if (only === 'slow-closed') await scenario('D: slow workflow, input closed at the first result', { prompt: slow, ultracode: true, closeAfterFirstResult: true })
  if (only === 'slow-open') await scenario('E: slow workflow, input kept open', { prompt: slow, ultracode: true })
} finally {
  await rm(cwd, { recursive: true, force: true })
}
