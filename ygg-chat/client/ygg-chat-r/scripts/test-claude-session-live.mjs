// Opt-in native SDK smoke. Uses normal Claude account usage; only test-created sessions/workspace.
import { query, forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

if (process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1') throw new Error('Set CLAUDE_PROVIDER_LIVE_TEST=1 to opt into normal Claude usage')
const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-provider-'))
const binary = process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude')
const env = { ...process.env }
delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
const options = { cwd, pathToClaudeCodeExecutable: binary, model: 'claude-haiku-5-5',
  tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
  permissionMode: 'dontAsk', permissionPrompts: 'none', includePartialMessages: true, env }
const shape = event => ({ type: event.type, subtype: event.subtype, uuid: event.uuid,
  session: event.session_id, apiMessageId: event.message?.id, role: event.message?.role,
  blocks: Array.isArray(event.message?.content) ? event.message.content.map(block => block.type) : undefined,
  streamType: event.event?.type, error: event.error, isError: event.is_error })
async function run(prompt, extra = {}) {
  let session, lastAssistant, answer = '', result
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  let finishInput
  const inputDone = new Promise(resolve => { finishInput = resolve })
  async function* prompts() { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }; await inputDone }
  const q = query({ prompt: prompts(), options: { ...options, ...extra, abortController: controller } })
  try {
    for await (const event of q) {
      console.log(JSON.stringify(shape(event)))
      if (event.session_id) session = event.session_id
      if (event.type === 'assistant') { lastAssistant = event.uuid; answer += event.message.content.filter(block => block.type === 'text').map(block => block.text).join('') }
      if (event.type === 'result') { result = event; finishInput() }
    }
  } finally { finishInput(); clearTimeout(timer); q.close() }
  assert.equal(result?.subtype, 'success', JSON.stringify(result))
  return { session, lastAssistant, answer }
}
try {
  const first = await run('Remember this token: violet-badger-73. Reply only ACK.')
  const messages = await getSessionMessages(first.session, { dir: cwd })
  assert(messages.some(message => message.uuid === first.lastAssistant))
  const fork = await forkSession(first.session, { dir: cwd, upToMessageId: first.lastAssistant })
  const forkMessages = await getSessionMessages(fork.sessionId, { dir: cwd })
  console.log(JSON.stringify({ original: messages.map(message => ({ uuid: message.uuid, type: message.type })),
    fork: forkMessages.map(message => ({ uuid: message.uuid, type: message.type })) }))
  const second = await run('What token did I ask you to remember? Reply only that token.', { resume: fork.sessionId })
  assert(second.answer.includes('violet-badger-73'), second.answer)
  assert.equal((await getSessionMessages(first.session, { dir: cwd })).length, messages.length)
  await writeFile(path.join(cwd, 'fixture.txt'), 'Native tool fixture: amber-otter-42')
  const toolRun = await run('Use Read to read fixture.txt and report the token. Do not use other tools.', { tools: ['Read'],
    permissionMode: 'default', permissionPrompts: 'host', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) })
  assert(toolRun.answer.includes('amber-otter-42'), toolRun.answer)
  const toolMessages = await getSessionMessages(toolRun.session, { dir: cwd })
  assert(toolMessages.some(message => message.uuid === toolRun.lastAssistant))
  let approvalCalls = 0
  const denied = await run('Use Write to create denied.txt with contents hello. If denied, stop and say denied; do not try other tools.', { tools: ['Write'],
    permissionMode: 'default', permissionPrompts: 'host', canUseTool: async () => { approvalCalls++; return { behavior: 'deny', message: 'Denied by smoke test' } } })
  assert(approvalCalls > 0, 'Expected live canUseTool invocation during streaming query')
  await assert.rejects(access(path.join(cwd, 'denied.txt')))
  console.log('PASS: native SDK streaming input, historical fork, recall, independent source, native Read and denied Write approval')
} finally { await rm(cwd, { recursive: true, force: true }) }
