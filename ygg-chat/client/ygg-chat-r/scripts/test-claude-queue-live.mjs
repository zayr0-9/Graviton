// Opt-in native SDK probe for queued user input. Uses normal Claude account usage; only test-created sessions/workspace.
// Shows how a message pushed during a running turn appears in the stream and in the native transcript.
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

if (process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1') throw new Error('Set CLAUDE_PROVIDER_LIVE_TEST=1 to opt into normal Claude usage')
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-queue-')))
const binary = process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude')
const env = { ...process.env }
delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
const options = { cwd, pathToClaudeCodeExecutable: binary, model: process.env.CLAUDE_QUEUE_MODEL || 'claude-haiku-5-5',
  tools: ['Bash'], settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
  permissionMode: 'default', permissionPrompts: 'host', includePartialMessages: true, env,
  canUseTool: async (_name, input) => /^\s*(sleep|echo)\b/.test(String(input?.command ?? ''))
    ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only sleep/echo allowed in this probe' } }
const text = content => typeof content === 'string' ? content
  : (content ?? []).map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? `[tool_result ${textOf(block.content)}]`
    : block.type === 'tool_use' ? `[tool_use ${block.name} ${JSON.stringify(block.input)}]` : `[${block.type}]`).join(' ')
const textOf = value => typeof value === 'string' ? value : text(value)
const clip = (value, size = 160) => { const s = String(value ?? '').replace(/\s+/g, ' '); return s.length > size ? s.slice(0, size) + '…' : s }
const shape = event => ({ type: event.type, subtype: event.subtype, uuid: event.uuid, isReplay: event.isReplay, isSynthetic: event.isSynthetic,
  priority: event.priority, parent: event.parent_tool_use_id ?? undefined, apiId: event.message?.id,
  text: event.message ? clip(text(event.message.content)) : undefined,
  ...(event.type === 'command_lifecycle' || (event.type === 'system' && ['status', 'informational'].includes(event.subtype)) ? { raw: clip(JSON.stringify(event), 400) } : {}),
  ...(event.type === 'result' ? { result: clip(event.result), numTurns: event.num_turns } : {}) })

async function scenario(label, { first, second, pushWhen, priority, cancelAfterMs }) {
  console.log(`\n=== ${label} ===`)
  const inbox = []
  let wake = () => {}
  let closed = false
  const push = message => { inbox.push(message); wake() }
  async function* prompts() {
    while (!closed) {
      if (!inbox.length) { await new Promise(resolve => { wake = resolve }); continue }
      yield inbox.shift()
    }
  }
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null,
    uuid: randomUUID(), session_id: '', ...extra })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const firstMsg = user(first)
  const secondMsg = user(second, priority ? { priority } : {})
  console.log(JSON.stringify({ sent: 'first', uuid: firstMsg.uuid }))
  push(firstMsg)
  const q = query({ prompt: prompts(), options: { ...options, abortController: controller } })
  let session, pushed = false
  // A queued message may start its own turn after a result, so input closes only after a quiet spell.
  let idle
  const closeInput = () => { closed = true; wake() }
  const sendSecond = () => {
    if (pushed) return
    pushed = true
    console.log(JSON.stringify({ sent: 'second', uuid: secondMsg.uuid, priority: priority ?? null, t: Date.now() }))
    push(secondMsg)
    if (cancelAfterMs != null) setTimeout(async () => {
      const cancelled = await q.cancelAsyncMessage(secondMsg.uuid).catch(error => `error: ${error?.message}`)
      console.log(JSON.stringify({ cancelAsyncMessage: cancelled, afterMs: cancelAfterMs, t: Date.now() }))
    }, cancelAfterMs)
  }
  try {
    for await (const event of q) {
      // The `completed` lifecycle frame follows each result; only a new turn cancels the close.
      if (event.type !== 'command_lifecycle' || event.state === 'started') clearTimeout(idle)
      if (pushWhen === 'text' && event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') sendSecond()
      if (event.type === 'stream_event' || event.type === 'rate_limit_event' || (event.type === 'system' && /^(task_|thinking_tokens|init|hook_)/.test(event.subtype))) continue
      console.log(JSON.stringify({ t: Date.now(), ...shape(event) }))
      if (event.session_id) session = event.session_id
      if (pushWhen === 'tool_use' && event.type === 'assistant' && event.message.content.some(block => block.type === 'tool_use')) sendSecond()
      if (event.type === 'result') {
        if (pushWhen === 'result' && !pushed) { sendSecond(); continue }
        idle = setTimeout(closeInput, 10_000)
      }
    }
  } catch (error) {
    console.log('stream ended with', clip(error?.message, 200))
  } finally { clearTimeout(idle); closeInput(); clearTimeout(timer); q.close() }
  let messages = []
  try { messages = await getSessionMessages(session, { dir: cwd }) } catch (error) { console.log('getSessionMessages failed:', clip(error?.message, 300)) }
  console.log('--- getSessionMessages')
  for (const m of messages) console.log(JSON.stringify({ type: m.type, uuid: m.uuid, parent: m.parent_tool_use_id ?? undefined,
    text: clip(text(m.message?.content), 200) }))
  const projects = path.join(os.homedir(), '.claude', 'projects')
  for (const dir of await readdir(projects)) {
    const file = path.join(projects, dir, `${session}.jsonl`)
    let raw
    try { raw = await readFile(file, 'utf8') } catch { continue }
    console.log('--- raw jsonl', file)
    for (const line of raw.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      console.log(JSON.stringify({ type: entry.type, uuid: entry.uuid, parentUuid: entry.parentUuid, promptId: entry.promptId,
        isMeta: entry.isMeta, origin: entry.origin, attachment: entry.attachment ? clip(JSON.stringify(entry.attachment), 300) : undefined,
        text: entry.message ? clip(text(entry.message.content), 200) : entry.content ? clip(entry.content) : undefined }))
    }
  }
  return { session, firstUuid: firstMsg.uuid, secondUuid: secondMsg.uuid }
}

const twoTools = 'Use Bash to run `sleep 4 && echo one`. After it finishes, use Bash to run `sleep 4 && echo two`. Then reply with DONE-A and nothing else.'
const late = 'Also include the word PURPLE in your reply.'
try {
  const only = process.env.CLAUDE_QUEUE_SCENARIO
  if (!only || only === 'next') await scenario('A: priority next, pushed during first tool', { first: twoTools, second: late, pushWhen: 'tool_use', priority: 'next' })
  if (!only || only === 'later') await scenario('B: priority later, pushed during first tool', { first: twoTools, second: late, pushWhen: 'tool_use', priority: 'later' })
  if (!only || only === 'text') await scenario('D: priority next, pushed while the final text streams (no tool boundary left)', { first: 'Write a 150-word story about a lighthouse. Do not use tools.', second: late, pushWhen: 'text', priority: 'next' })
  if (!only || only === 'cancel') {
    for (const [p, ms] of [['next', 300], ['later', 300], ['next', 0]]) {
      await scenario(`E: priority ${p}, cancelled ${ms} ms after push during first tool`, { first: twoTools, second: late, pushWhen: 'tool_use', priority: p, cancelAfterMs: ms })
    }
  }
  if (!only || only === 'after') await scenario('C: no priority, pushed after result', { first: twoTools, second: 'Reply with PURPLE and nothing else.', pushWhen: 'result' })
} finally {
  await rm(cwd, { recursive: true, force: true })
}
