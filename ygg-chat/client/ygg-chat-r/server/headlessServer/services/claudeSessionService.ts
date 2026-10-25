import { claudeMessageMetadata } from '../../../../../shared/claudeProvider.js'
import { randomUUID } from 'node:crypto'
import { claudeProcessEnvironment, resolveClaudeExecutable } from './claudeProcessConfig.js'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { ClaudeSessionRepo } from '../persistence/claudeSessionRepo.js'
import type { MessageRepo } from '../persistence/messageRepo.js'
import type { MessageSink } from './messageSink.js'
import type { DecisionBroker, PermissionDecision } from './decisionBroker.js'

// Lazy import keeps the native CLI launcher out of renderer and ordinary provider startup.
export type ClaudeSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query' | 'forkSession' | 'getSessionMessages'>
const loadSdk = () => import('@anthropic-ai/claude-agent-sdk')
const textOf = (value: any): string => typeof value === 'string' ? value : JSON.stringify(value ?? '')

export class ClaudeSessionService {
  constructor(private deps: { sessions: ClaudeSessionRepo; messages: MessageRepo; broker?: DecisionBroker; sdk?: () => Promise<ClaudeSdk>; executable?: () => Promise<string> }) {}

  async run(input: {
    request: HeadlessMessageRequest; lineageId: string; userMessage: any; parentId: string | null
    sourceMessageId: string | null; fork: boolean; cwd: string; sink: MessageSink
    emit: (event: HeadlessStreamEvent) => void; signal?: AbortSignal
  }): Promise<any> {
    const { request, lineageId, emit, sink, signal, cwd } = input
    const sdk = await (this.deps.sdk ?? loadSdk)()
    const executable = await (this.deps.executable ?? resolveClaudeExecutable)()
    signal?.throwIfAborted()
    const stored = this.deps.sessions.branch(lineageId)
    let sessionId: string | undefined = stored?.session_id ?? undefined
    if (!input.fork && (stored?.state === 'uncertain' || stored?.state === 'running')) throw new Error('Claude session was interrupted. Fork from a completed Claude message before continuing.')
    if (input.sourceMessageId) {
      const checkpoint = this.deps.sessions.checkpoint(input.sourceMessageId)
      if (!checkpoint?.resumable) throw new Error('This node is not a completed Claude checkpoint. Choose a completed Claude response to fork or continue.')
      if (checkpoint.cwd !== cwd) throw new Error('Claude branch workspace is locked. Start a new conversation to change it.')
      // Verify the exact source is still available. Never silently start over.
      const transcript = await sdk.getSessionMessages(checkpoint.session_id, { dir: cwd })
      if (!transcript.some(message => message.uuid === checkpoint.message_uuid)) throw new Error('Claude session data is unavailable. The saved Graviton transcript remains readable.')
      if (input.fork || !sessionId || sessionId !== checkpoint.session_id || transcript.at(-1)?.uuid !== checkpoint.message_uuid) {
        const fork = await sdk.forkSession(checkpoint.session_id, { dir: cwd, upToMessageId: checkpoint.message_uuid })
        sessionId = fork.sessionId
      }
    } else if (sessionId) {
      throw new Error('Claude session has no matching checkpoint. Start a new conversation.')
    }
    this.deps.sessions.reserve(lineageId, request.conversationId, request.modelName, cwd)
    let recordedSession: string | undefined
    let observedSession = false
    let activeSession = sessionId
    let parent = input.parentId
    let finalMessage: any = null
    let completed = false
    let turn = 0
    let streamedText = ''
    let streamedReasoning = ''
    const toolOwners = new Map<string, { message: any; blocks: any[]; calls: any[] }>()
    const apiResponses = new Map<string, { message: any; blocks: any[]; calls: any[]; content: string }>()
    let lastUuid: string | null = null
    let currentApiId: string | null = null
    const abortController = new AbortController()
    const abort = () => abortController.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const promptUuid = randomUUID()
    const canUseTool: NonNullable<Options['canUseTool']> = async (name, args, context) => {
      if (abortController.signal.aborted || context.signal.aborted) return { behavior: 'deny', message: 'Run stopped', interrupt: true }
      if (name === 'ExitPlanMode') return { behavior: 'deny', message: 'Switch to Agent mode in Graviton between turns.' }
      // AskUserQuestion requires an answer protocol beyond permission; do not turn Approve into an invented answer.
      if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'Ask the user in your text response instead.' }
      if (!this.deps.broker) return { behavior: 'deny', message: 'Approval UI unavailable' }
      const id = context.toolUseID || randomUUID()
      const event = { type: 'permission_required' as const, streamId: request.streamId!, toolCallId: id, toolName: name, toolInput: args }
      const pending = this.deps.broker.requestDecision<PermissionDecision>({ streamId: request.streamId!, toolCallId: id,
        kind: 'permission', signal: context.signal, prompt: event })
      if (this.deps.broker.hasPending(request.streamId!, id)) emit(event)
      return await pending === 'deny' ? { behavior: 'deny', message: 'Denied by user' } : { behavior: 'allow', updatedInput: args }
    }
    const options: Options = {
      cwd, model: request.modelName, ...(sessionId ? { resume: sessionId } : {}),
      abortController, includePartialMessages: true, permissionMode: request.operationMode === 'plan' ? 'plan' : 'default',
      canUseTool, permissionPrompts: 'host', settingSources: [], strictMcpConfig: true, mcpServers: {},
      persistSession: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Do not inherit plugin/MCP/hook execution or Graviton's own tool prompt.
      settings: { disableAllHooks: true },
    }
    // Use the host's installed CLI rather than resolving a bundled native executable relative to an esbuild bundle.
    options.pathToClaudeCodeExecutable = executable
    options.env = claudeProcessEnvironment()
    const selectedFiles = (request.selectedFiles ?? []).map(file => `File: ${file.path}\n${file.contents}`).join('\n\n')
    const prompt = selectedFiles ? `${request.content}\n\nSelected file context:\n${selectedFiles}` : request.content
    let finishInput!: () => void
    const inputDone = new Promise<void>(resolve => { finishInput = resolve })
    const releaseInput = () => finishInput()
    abortController.signal.addEventListener('abort', releaseInput, { once: true })
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: promptUuid,
        session_id: sessionId ?? '' }
      await inputDone
    }
    let query: ReturnType<ClaudeSdk['query']> | undefined
    const persist = (content: string, blocks: any[], uuid?: string, partial = false) => {
      const row = sink.persistAssistantMessage({ conversationId: request.conversationId, parentId: parent,
        modelName: request.modelName, content, contentBlocks: blocks,
        meta: { claude: { sessionId: activeSession, messageUuid: uuid ?? null, checkpoint: false, partial } } })
      parent = row.id
      finalMessage = row
      if (uuid && activeSession) this.deps.sessions.record(row.id, activeSession, uuid, cwd, false)
      emit({ type: 'assistant_message_persisted', message: row, lineageId })
      return row
    }
    try {
      signal?.throwIfAborted()
      query = sdk.query({ prompt: prompts(), options })
      for await (const event of query) {
        signal?.throwIfAborted()
        if ('session_id' in event && event.session_id) {
          observedSession = true
          activeSession = event.session_id
          if (recordedSession !== activeSession) {
            this.deps.sessions.session(lineageId, activeSession, 'running')
            recordedSession = activeSession
          }
        }
        if ('parent_tool_use_id' in event && event.parent_tool_use_id) continue // child detail remains in Claude's native transcript
        if (event.type === 'stream_event') {
          const frame = event.event
          if (frame.type === 'message_start') {
            currentApiId = frame.message.id
            streamedText = ''; streamedReasoning = ''
            emit({ type: 'tool_loop', status: 'turn_started', turn: ++turn, maxTurns: 0 })
          }
          if (frame.type === 'content_block_start' && (frame.content_block.type === 'text' || frame.content_block.type === 'thinking')) {
            // The SDK emits one assistant envelope per completed block, not necessarily per API message.
            streamedText = ''; streamedReasoning = ''
          }
          if (frame.type === 'content_block_delta') {
            if (frame.delta.type === 'text_delta') { streamedText += frame.delta.text; emit({ type: 'chunk', part: 'text', delta: frame.delta.text }) }
            if (frame.delta.type === 'thinking_delta') { streamedReasoning += frame.delta.thinking; emit({ type: 'chunk', part: 'reasoning', delta: frame.delta.thinking }) }
          }
        } else if (event.type === 'assistant') {
          if (event.error) throw new Error(`Claude failed: ${event.error}`)
          const blocks: any[] = event.message.content.map((block, index) => {
            if (block.type === 'text') return { type: 'text', content: block.text, index }
            if (block.type === 'thinking') return { type: 'thinking', content: block.thinking, index }
            if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input, index }
            return { type: 'text', content: `[Claude ${block.type}]`, index }
          })
          const content = event.message.content.filter(block => block.type === 'text').map(block => (block as any).text).join('')
          const calls = event.message.content.filter(block => block.type === 'tool_use').map(block => ({ id: (block as any).id, name: (block as any).name, arguments: (block as any).input, status: 'executing' }))
          const responseKey = event.message.id || event.uuid
          let response = apiResponses.get(responseKey)
          let row: any
          if (response) {
            for (const block of blocks) response.blocks.push({ ...block, index: response.blocks.length })
            response.content += content
            response.calls.push(...calls)
            row = this.deps.messages.updateClaudeProjection(response.message.id, response.content, response.blocks,
              { ...claudeMessageMetadata(response.message.meta), claude: { sessionId: activeSession, messageUuid: event.uuid, checkpoint: false } })
            response.message = row
            finalMessage = row
            if (activeSession) this.deps.sessions.record(row.id, activeSession, event.uuid, cwd, false)
            emit({ type: 'assistant_message_persisted', message: row, lineageId })
          } else {
            row = persist(content, blocks, event.uuid)
            response = { message: row, blocks, calls, content }
            apiResponses.set(responseKey, response)
          }
          lastUuid = event.uuid
          streamedText = ''; streamedReasoning = ''
          for (const call of calls) {
            toolOwners.set(call.id, response)
            emit({ type: 'chunk', part: 'tool_call', toolCall: call })
            emit({ type: 'tool_execution', status: 'started', toolCallId: call.id, toolName: call.name })
          }
        } else if (event.type === 'user') {
          const blocks = Array.isArray(event.message.content) ? event.message.content : []
          for (const result of blocks) {
            if (result.type !== 'tool_result') continue
            const owner = toolOwners.get(result.tool_use_id)
            const content = textOf(result.content)
            if (owner) {
              owner.blocks.push({ type: 'tool_result', tool_use_id: result.tool_use_id, content, is_error: Boolean(result.is_error), index: owner.blocks.length })
              const call = owner.calls.find(call => call.id === result.tool_use_id)
              if (call) { call.status = 'complete'; call.result = content }
              const updated = sink.updateAssistantToolState(owner.message.id, { contentBlocks: owner.blocks, toolCalls: owner.calls })
              if (updated) emit({ type: 'assistant_message_persisted', message: updated, lineageId })
              emit({ type: 'tool_execution', status: result.is_error ? 'failed' : 'completed', toolCallId: result.tool_use_id, toolName: call?.name ?? 'Claude tool' })
            }
            emit({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: result.tool_use_id, content, is_error: Boolean(result.is_error) } })
          }
        } else if (event.type === 'result') {
          finishInput()
          if (event.is_error || event.subtype !== 'success') throw new Error(`Claude run failed: ${'errors' in event ? event.errors.join('; ') : event.subtype}`)
          completed = true
        }
      }
      if (!completed || !activeSession || !finalMessage || !lastUuid) throw new Error('Claude ended without a completed response')
      this.deps.sessions.record(finalMessage.id, activeSession, lastUuid, cwd, true)
      const finalResponse = [...apiResponses.values()].find(response => response.message.id === finalMessage.id)
      const finalBlocks = finalResponse?.blocks ?? (typeof finalMessage.content_blocks === 'string' ? JSON.parse(finalMessage.content_blocks) : finalMessage.content_blocks ?? finalMessage.contentBlocks ?? [])
      finalMessage = this.deps.messages.updateClaudeProjection(finalMessage.id, finalMessage.content, finalBlocks,
        { ...claudeMessageMetadata(finalMessage.meta), claude: { sessionId: activeSession, messageUuid: lastUuid, checkpoint: true } })
      emit({ type: 'assistant_message_persisted', message: finalMessage, lineageId })
      this.deps.sessions.session(lineageId, activeSession, 'ready')
      return finalMessage
    } catch (error) {
      if (streamedText || streamedReasoning) {
        const blocks = [
          ...(streamedReasoning ? [{ type: 'thinking', content: streamedReasoning, index: 0 }] : []),
          ...(streamedText ? [{ type: 'text', content: streamedText, index: 1 }] : []),
        ]
        const response = currentApiId ? apiResponses.get(currentApiId) : undefined
        if (response) {
          for (const block of blocks) response.blocks.push({ ...block, index: response.blocks.length })
          finalMessage = this.deps.messages.updateClaudeProjection(response.message.id, response.content + streamedText, response.blocks,
            { ...claudeMessageMetadata(response.message.meta), claude: { sessionId: activeSession, checkpoint: false, partial: true } })
          emit({ type: 'assistant_message_persisted', message: finalMessage, lineageId })
        } else persist(streamedText, blocks, undefined, true)
      }
      if (activeSession && observedSession) this.deps.sessions.session(lineageId, activeSession, 'uncertain')
      throw error
    } finally {
      finishInput()
      abortController.signal.removeEventListener('abort', releaseInput)
      signal?.removeEventListener('abort', abort)
      query?.close()
    }
  }
}
