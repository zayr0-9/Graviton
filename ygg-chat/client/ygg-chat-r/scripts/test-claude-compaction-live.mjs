// Opt-in SDK compaction probe. Normal account usage; only a test-created workspace/session.
import { query, getSessionMessages, forkSession } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

if (process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1') throw new Error('Set CLAUDE_PROVIDER_LIVE_TEST=1 to opt into normal Claude usage')
const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-compact-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|TMPDIR|LANG|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/.test(key)))
const summaries = []
const options = { cwd, pathToClaudeCodeExecutable: process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude'),
  model: 'claude-haiku-5-5', tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {},
  settings: { disableAllHooks: true }, permissionMode: 'dontAsk', permissionPrompts: 'none', env,
  hooks: { PostCompact: [{ hooks: [async input => {
    summaries.push(input)
    console.log(JSON.stringify({ hook: input.hook_event_name, trigger: input.trigger, summaryChars: input.compact_summary?.length }))
    return {}
  }] }] } }
async function run(content, resume) {
  let session, result, lastAssistant, answer = ''
  let finish
  const done = new Promise(resolve => { finish = resolve })
  async function* prompts() { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } }; await done }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  const q = query({ prompt: prompts(), options: { ...options, ...(resume ? { resume } : {}), abortController: controller } })
  try {
    for await (const event of q) {
      if (event.session_id) session = event.session_id
      if (event.type === 'assistant') lastAssistant = event.uuid
      if (event.type === 'assistant') answer += event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (event.type === 'system' && ['status', 'compact_boundary'].includes(event.subtype)) console.log(JSON.stringify({ type: event.type, subtype: event.subtype, status: event.status, compact_result: event.compact_result }))
      if (event.type === 'result') { result = event; finish(); console.log(JSON.stringify({ type: 'result', subtype: event.subtype, is_error: event.is_error })) }
    }
  } finally { finish(); clearTimeout(timer); q.close() }
  assert.equal(result?.subtype, 'success', `Native command did not succeed: ${result?.subtype}`)
  return { session, answer, lastAssistant }
}
try {
  const first = await run('Remember the synthetic test token saffron-heron-73. The task is to preserve this token across compaction. Reply only ACK.')
  await run('Remember the later-only token future-marmot-94, which was not present in the first turn. Reply ACK.', first.session)
  await run('/compact Preserve the exact synthetic test token and task.', first.session)
  assert.equal(summaries.length, 1, 'Expected one PostCompact callback with external hooks disabled')
  assert.equal(summaries[0].trigger, 'manual')
  assert(summaries[0].compact_summary?.includes('saffron-heron-73'), 'Summary must preserve the synthetic token')
  const retained = await getSessionMessages(first.session, { dir: cwd })
  console.log(JSON.stringify({ preCompactionCheckpointRetained: retained.some(message => message.uuid === first.lastAssistant) }))
  const fork = await forkSession(first.session, { dir: cwd, upToMessageId: first.lastAssistant })
  const forkRows = await getSessionMessages(fork.sessionId, { dir: cwd, includeSystemMessages: true })
  assert(!JSON.stringify(forkRows).includes('future-marmot-94'), 'Historical fork must not contain later context')
  await assert.rejects(forkSession(first.session, { dir: cwd, upToMessageId: 'missing-checkpoint' }))
  const forked = await run('What synthetic test token did I ask you to remember? Reply only that token.', fork.sessionId)
  assert(forked.answer.includes('saffron-heron-73'), 'Historical pre-compaction fork must retain token')
  const after = await run('What synthetic test token did I ask you to remember? Reply only that token.', first.session)
  assert(after.answer.includes('saffron-heron-73'), 'Continuation must retain the token')
  console.log('PASS: native /compact, PostCompact text with external hooks disabled, and same-session continuation')
} finally { await rm(cwd, { recursive: true, force: true }) }
