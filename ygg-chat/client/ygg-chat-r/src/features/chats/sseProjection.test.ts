import './__testSupport__/localStorageShim' // must run before chatSlice import (reads localStorage at init)
import { describe, it, expect } from 'vitest'
import {
  applyStreamProjectionPolicy,
  projectServerEvent,
  normalizeServerMessage,
  type ProjectionContext,
  type ServerStreamEvent,
} from './sseProjection'
import chatReducer, { chatSliceActions } from './chatSlice'

const ctx: ProjectionContext = { streamId: 'stream-1', conversationId: 'conv-1' }

/**
 * Build a deliberately PARTIAL event fixture.
 *
 * projectServerEvent reads only a few fields per event type, so most tests below
 * pass complete, type-checked literals. Use this helper ONLY where the fixture is
 * intentionally incomplete (it omits wire fields the projection never reads) or
 * intentionally invalid (the forward-compatibility case, which asserts that an
 * unrecognised `type` falls through to `default:`). Keeping the cast here rather
 * than widening ServerStreamEvent means every other fixture stays checked against
 * the real wire union.
 */
const partial = (event: Record<string, unknown>): ServerStreamEvent => event as unknown as ServerStreamEvent
const types = (actions: { type: string }[]) => actions.map(a => a.type)

/** The chunk carried by the Nth action, when that action is a streamChunkReceived. */
const chunkOf = (actions: { type: string; payload?: unknown }[], index = 0): any => (actions[index].payload as any).chunk
/** The single chatErrorRecorded record in a projection. */
const recordOf = (actions: { type: string; payload?: unknown }[]): any => {
  const found = actions.find(a => a.type === chatSliceActions.chatErrorRecorded.type)
  return found ? (found.payload as any) : undefined
}

describe('normalizeServerMessage', () => {
  it('parses JSON-string columns and fills renderer-only defaults', () => {
    const row = {
      id: 'm1',
      conversation_id: 'conv-1',
      parent_id: null,
      role: 'assistant',
      content: 'hi',
      children_ids: '[]',
      tool_calls: '[{"id":"t1","name":"read_file"}]',
      content_blocks: 'null',
      created_at: '2026-01-01',
      lineage_id: 'lineage-1',
    }
    const m = normalizeServerMessage(row) as any
    expect(Array.isArray(m.children_ids)).toBe(true)
    expect(Array.isArray(m.tool_calls)).toBe(true)
    expect(m.tool_calls[0].id).toBe('t1')
    expect(m.content_blocks).toBeNull()
    expect(m.artifacts).toEqual([])
    expect(m.pastedContext).toEqual([])
    expect(m.partial).toBe(false)
    expect(m.content_plain_text).toBe('hi')
    expect(m.model_name).toBe('unknown')
    expect(m.lineage_id).toBe('lineage-1')
  })

  it('passes through already-parsed values', () => {
    const m = normalizeServerMessage({ id: 'm1', tool_calls: [{ id: 't1' }], content_blocks: [{ type: 'text' }] }) as any
    expect(m.tool_calls[0].id).toBe('t1')
    expect(m.content_blocks[0].type).toBe('text')
  })

  it('preserves a persisted ErrorBlock through the JSON-string column', () => {
    const m = normalizeServerMessage({
      id: 'm1',
      content_blocks: JSON.stringify([
        { type: 'text', index: 0, text: 'partial' },
        {
          type: 'error',
          index: 1,
          envelope: { code: 'provider_timeout', userMessage: 'The model took too long.', recoverability: 'retryable' },
          excludeFromContext: true,
        },
      ]),
    }) as any
    expect(m.content_blocks).toHaveLength(2)
    expect(m.content_blocks[0]).toMatchObject({ type: 'text', text: 'partial' })
    expect(m.content_blocks[1]).toMatchObject({
      type: 'error',
      index: 1,
      excludeFromContext: true,
      envelope: { code: 'provider_timeout', userMessage: 'The model took too long.' },
    })
  })

  it('re-asserts excludeFromContext and completes a thin ErrorBlock envelope', () => {
    // A row written by an older build: the flag was lost in serialisation and the
    // envelope carries only a code. Both are load-bearing, so both are rebuilt.
    const m = normalizeServerMessage({
      id: 'm1',
      content_blocks: [{ type: 'error', envelope: { code: 'rate_limited' } }],
    }) as any
    const block = m.content_blocks[0]
    expect(block.excludeFromContext).toBe(true)
    expect(block.index).toBe(0)
    expect(block.envelope.code).toBe('rate_limited')
    expect(typeof block.envelope.userMessage).toBe('string')
    expect(block.envelope.userMessage.length).toBeGreaterThan(0)
    expect(block.envelope.recoverability).toBe('retryable')
  })

  it('falls an unrecognised ErrorBlock code back to renderable prose', () => {
    const m = normalizeServerMessage({
      id: 'm1',
      content_blocks: [{ type: 'error', index: 0, envelope: { code: 'code_from_a_newer_build' } }],
    }) as any
    expect(m.content_blocks[0].envelope.code).toBe('internal_error')
    expect(m.content_blocks[0].envelope.userMessage).toBeTruthy()
  })
})

describe('projectServerEvent', () => {
  it('started seeds branch anchors from the server parentId', () => {
    const a = projectServerEvent(partial({ type: 'started', parentId: 'p1' }), ctx)
    expect(types(a)).toEqual([chatSliceActions.streamLineageUpdated.type])
    expect((a[0].payload as any)).toMatchObject({
      streamId: 'stream-1',
      rootMessageId: 'p1',
      branchAnchorMessageId: 'p1',
      currentBranchAnchorMessageId: 'p1',
    })
  })

  it('started projects lineage identity even without a legacy parent anchor', () => {
    const a = projectServerEvent(partial({ type: 'started', parentId: null, lineageId: 'lineage-1' }), ctx)
    expect(types(a)).toEqual([chatSliceActions.streamLineageUpdated.type])
    expect(a[0].payload as any).toMatchObject({ streamId: 'stream-1', lineageId: 'lineage-1' })
  })

  it('started with neither parentId nor lineageId is a no-op', () => {
    expect(projectServerEvent(partial({ type: 'started', parentId: null }), ctx)).toEqual([])
  })

  it('user_message_persisted => messageAdded, messageBranchCreated, streamLineageUpdated (in order)', () => {
    const a = projectServerEvent(
      {
        type: 'user_message_persisted',
        lineageId: 'lineage-1',
        message: { id: 'u1', role: 'user', content: 'hey', conversation_id: 'conv-1', lineage_id: 'lineage-1' },
      },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamLineageUpdated.type,
    ])
    expect((a[0].payload as any).id).toBe('u1')
    expect((a[1].payload as any).newMessage.id).toBe('u1')
    expect((a[2].payload as any)).toMatchObject({ triggerUserMessageId: 'u1', lineageId: 'lineage-1' })
    expect((a[0].payload as any).lineage_id).toBe('lineage-1')
  })

  it('maps chunk parts to streamChunkReceived', () => {
    const text = projectServerEvent({ type: 'chunk', part: 'text', delta: 'ab' }, ctx)
    expect(text[0].type).toBe(chatSliceActions.streamChunkReceived.type)
    expect((text[0].payload as any).chunk).toMatchObject({ type: 'chunk', part: 'text', delta: 'ab' })

    const tc = projectServerEvent({ type: 'chunk', part: 'tool_call', toolCall: { id: 't1', name: 'x' } }, ctx)
    expect((tc[0].payload as any).chunk.toolCall).toMatchObject({ id: 't1', name: 'x', status: 'executing' })

    const tr = projectServerEvent({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: 't1', content: 'ok', is_error: 0 } }, ctx)
    expect((tr[0].payload as any).chunk.toolResult).toMatchObject({ tool_use_id: 't1', content: 'ok', is_error: false })
  })

  it('assistant_message_persisted closes a turn with a complete CHUNK (not streamCompleted)', () => {
    const a = projectServerEvent({ type: 'assistant_message_persisted', message: { id: 'a1', role: 'assistant' } }, ctx)
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamChunkReceived.type,
    ])
    expect((a[2].payload as any).chunk.type).toBe('complete')
  })

  it('assistant persisted projects lineage identity when supplied', () => {
    const a = projectServerEvent(
      { type: 'assistant_message_persisted', lineageId: 'lineage-1', message: { id: 'a1', role: 'assistant' } },
      ctx
    )
    expect(types(a)).toContain(chatSliceActions.streamLineageUpdated.type)
    expect((a[2].payload as any)).toMatchObject({ streamId: 'stream-1', lineageId: 'lineage-1' })
  })

  it('terminal complete => messageAdded, messageBranchCreated, streamCompleted', () => {
    const a = projectServerEvent(
      { type: 'complete', lineageId: 'lineage-1', message: { id: 'a2', role: 'assistant', lineage_id: 'lineage-1' } },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamLineageUpdated.type,
      chatSliceActions.streamCompleted.type,
      chatSliceActions.decisionRequestsClearedForStream.type,
    ])
    expect((a[2].payload as any)).toMatchObject({ streamId: 'stream-1', lineageId: 'lineage-1' })
    expect((a[3].payload as any)).toMatchObject({ streamId: 'stream-1', messageId: 'a2', updatePath: true })
    expect(a[4].payload).toBe('stream-1')
  })

  it('defaults terminal ownership to updatePath=true for primary sends', () => {
    const started = chatSliceActions.sendingStarted({ streamId: 'stream-1' })
    let state = chatReducer(undefined, started)
    expect(state.streaming.byId['stream-1'].streamType).toBe('primary')
    expect(state.streaming.primaryStreamId).toBe('stream-1')

    const complete = projectServerEvent({ type: 'complete', message: { id: 'a2', role: 'assistant' } }, ctx)
      .find(action => action.type === chatSliceActions.streamCompleted.type)!
    expect(complete.payload).toMatchObject({ streamId: 'stream-1', updatePath: true })
  })

  it('explicit branch/updatePath=false neither claims primary bookkeeping nor mutates currentPath', () => {
    let state = chatReducer(undefined, chatSliceActions.conversationPathSet(['existing']))
    state = chatReducer(
      state,
      chatSliceActions.sendingStarted({ streamId: 'stream-1', streamType: 'branch', conversationId: 'conv-1' })
    )
    expect(state.streaming.byId['stream-1'].streamType).toBe('branch')
    expect(state.streaming.primaryStreamId).toBeNull()
    expect(state.composition.sending).toBe(false)

    const projected = projectServerEvent({ type: 'complete', message: { id: 'a2', role: 'assistant' } }, ctx)
    for (const action of projected) {
      state = chatReducer(
        state,
        applyStreamProjectionPolicy(action, {
          streamId: 'stream-1',
          streamType: 'branch',
          updatePath: false,
        }) as any
      )
    }

    expect(state.conversation.currentPath).toEqual(['existing'])
    expect(state.streaming.primaryStreamId).toBeNull()
    expect(state.streaming.byId['stream-1'].streamType).toBe('branch')
  })

  it('terminal complete records the envelope when the server badged a provider error', () => {
    const a = projectServerEvent(
      {
        type: 'complete',
        message: { id: 'a2', role: 'assistant', parent_id: 'u1' },
        providerError: true,
        envelope: { code: 'provider_timeout', userMessage: 'The model took too long.', recoverability: 'retryable' },
      },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamCompleted.type,
      chatSliceActions.decisionRequestsClearedForStream.type,
      chatSliceActions.chatErrorRecorded.type,
    ])
    expect(recordOf(a)).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      parentMessageId: 'u1',
      dismissed: false,
      envelope: { code: 'provider_timeout', userMessage: 'The model took too long.' },
    })
  })

  it('a clean complete records nothing (a badged completion stays distinguishable)', () => {
    const a = projectServerEvent({ type: 'complete', message: { id: 'a2', role: 'assistant' } }, ctx)
    expect(types(a)).not.toContain(chatSliceActions.chatErrorRecorded.type)
  })

  // D1's partial text does NOT ride on the error frame — the loop persists it as its own
  // assistant row with its own `assistant_message_persisted` frame (see toolLoopService's
  // provider catch). The error frame carries only the classification.
  it('error with no persisted row records a tier-2 bubble carrying the classification', () => {
    const a = projectServerEvent(
      {
        type: 'error',
        error: 'Provider turn 7/400 exploded at lineage 9f3',
        lineageId: 'lineage-1',
        envelope: {
          code: 'provider_unavailable',
          userMessage: "I couldn't reach the model provider.",
          recoverability: 'retryable',
        },
      },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.decisionRequestsClearedForStream.type,
      chatSliceActions.chatErrorRecorded.type,
    ])
    expect(recordOf(a)).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      lineageId: 'lineage-1',
      envelope: { code: 'provider_unavailable', userMessage: "I couldn't reach the model provider." },
    })
    // IRON RULE: the raw loop text never becomes something a user reads.
    expect(recordOf(a).envelope.userMessage).not.toContain('turn 7/400')
  })

  // R2 — the tier-1/tier-2 discriminator. Without this the user gets TWO bubbles for one
  // failure: the server's persisted ErrorBlock row AND a renderer record beside it.
  it('error with persistedErrorMessageId records NOTHING (tier 1 already owns the bubble)', () => {
    const a = projectServerEvent(
      {
        type: 'error',
        error: 'boom',
        persistedErrorMessageId: 'err-row-1',
        envelope: {
          code: 'provider_unavailable',
          userMessage: "I couldn't reach the model provider.",
          recoverability: 'retryable',
        },
      },
      ctx
    )
    expect(types(a)).not.toContain(chatSliceActions.chatErrorRecorded.type)
  })

  // R3 — pressing Stop is a normal outcome. The orchestrator emits a terminal `error` frame
  // on abort so reconnecting clients stop hanging, but it must never draw a red bubble.
  it('a cancelled error frame clears only that stream decision state without drawing an error', () => {
    const a = projectServerEvent(
      {
        type: 'error',
        error: 'aborted',
        envelope: { code: 'cancelled', userMessage: 'This reply was cancelled.', recoverability: 'user_action' },
      },
      ctx
    )
    expect(types(a)).toEqual([chatSliceActions.decisionRequestsClearedForStream.type])
    expect(a[0].payload).toBe('stream-1')
  })

  it('error emits NO error chunk when terminal (the thunk catch owns that ordering)', () => {
    const a = projectServerEvent({ type: 'error', error: 'boom', envelope: undefined }, ctx)
    const chunks = a.filter(action => action.type === chatSliceActions.streamChunkReceived.type)
    expect(chunks).toEqual([])
  })

  it('error from a pre-envelope server still records a renderable envelope', () => {
    const a = projectServerEvent({ type: 'error', error: 'ECONNRESET' }, ctx)
    expect(types(a)).toEqual([
      chatSliceActions.decisionRequestsClearedForStream.type,
      chatSliceActions.chatErrorRecorded.type,
    ])
    const record = recordOf(a)
    expect(record.envelope.code).toBe('internal_error')
    expect(record.envelope.userMessage).toBeTruthy()
    // IRON RULE: raw text is never the rendered string; it lives in `detail`.
    expect(record.envelope.userMessage).not.toContain('ECONNRESET')
    expect(record.envelope.detail).toBe('ECONNRESET')
  })

  it('a non-terminal error is shown in order and does NOT tear the stream down', () => {
    const a = projectServerEvent(
      {
        type: 'error',
        error: 'transient upstream 503',
        terminal: false,
        envelope: { code: 'provider_unavailable', userMessage: 'Provider hiccup.', recoverability: 'retryable' },
      },
      ctx
    )
    expect(types(a)).toEqual([chatSliceActions.streamChunkReceived.type, chatSliceActions.chatErrorRecorded.type])
    // `terminal:false` is what stops the reducer clearing `active` / setting status.
    expect(chunkOf(a)).toMatchObject({ type: 'error', terminal: false })
    expect(chunkOf(a).errorEnvelope).toMatchObject({ code: 'provider_unavailable', userMessage: 'Provider hiccup.' })
    expect(chunkOf(a).error).toBe('transient upstream 503')
  })

  it('tool_loop turn_started synthesizes a generation_started buffer clear; turn_completed no-ops', () => {
    const started = projectServerEvent({ type: 'tool_loop', status: 'turn_started', turn: 2, maxTurns: 100 }, ctx)
    expect((started[0].payload as any).chunk).toMatchObject({ type: 'generation_started', messageId: null })
    expect(projectServerEvent({ type: 'tool_loop', status: 'turn_completed', turn: 2, maxTurns: 100 }, ctx)).toEqual([])
  })

  // `tool_loop` is the MACHINE-READABLE record of a silence; the server emits a separate
  // `notice` frame carrying the prose (see the `notice` case below, and the three emit sites
  // in toolLoopService). Deriving a second notice here from the same frame showed the user
  // one event as two lines — so these stay no-ops on purpose. The failure mode this guards
  // against is the opposite one: BOTH sides dropping their half, leaving a silent stall.
  it('tool_loop provider_retry is a no-op — the server owns the retry prose', () => {
    const a = projectServerEvent(
      { type: 'tool_loop', status: 'provider_retry', turn: 3, maxTurns: 100, attempt: 2, maxAttempts: 3 },
      ctx
    )
    expect(a).toEqual([])
  })

  it('tool_loop max_turns_reached is a no-op — the server owns that prose too', () => {
    const a = projectServerEvent({ type: 'tool_loop', status: 'max_turns_reached', turn: 100, maxTurns: 100 }, ctx)
    expect(a).toEqual([])
  })

  it('a failed tool_execution is visible in order and carries the tool name', () => {
    const a = projectServerEvent(
      {
        type: 'tool_execution',
        status: 'failed',
        toolCallId: 'tc1',
        toolName: 'read_file',
        error: 'ENOENT: no such file or directory',
      },
      ctx
    )
    expect(types(a)).toEqual([chatSliceActions.streamChunkReceived.type])
    const chunk = chunkOf(a)
    expect(chunk).toMatchObject({ type: 'error', terminal: false })
    expect(chunk.errorEnvelope.code).toBe('tool_failed')
    expect(chunk.errorEnvelope.userMessage).toBe('The read_file tool failed.')
    expect(chunk.errorEnvelope.detail).toBe('ENOENT: no such file or directory')
    // No "Try again" next to an in-loop failure the model recovers from itself.
    expect(chunk.errorEnvelope.action).toBeUndefined()
  })

  it('non-failed tool_execution statuses stay no-ops (already covered by tool chunks)', () => {
    for (const status of ['started', 'completed', 'aborted'] as const) {
      expect(projectServerEvent({ type: 'tool_execution', status, toolCallId: 'tc1', toolName: 'bash' }, ctx)).toEqual([])
    }
  })

  it('notice projects an in-order notice chunk with its counters', () => {
    const a = projectServerEvent(
      { type: 'notice', code: 'reconnecting', message: 'Reconnecting…', attempt: 1, maxAttempts: 5 },
      ctx
    )
    expect(types(a)).toEqual([chatSliceActions.streamChunkReceived.type])
    expect(chunkOf(a)).toMatchObject({
      type: 'notice',
      code: 'reconnecting',
      message: 'Reconnecting…',
      attempt: 1,
      maxAttempts: 5,
    })
    expect((a[0].payload as any).streamId).toBe('stream-1')
  })

  it('reauth_required projects a sign-in bubble, never a redirect (D2)', () => {
    const a = projectServerEvent({ type: 'reauth_required', message: 'JWT expired at 1738...' }, ctx)
    expect(types(a)).toEqual([chatSliceActions.chatErrorRecorded.type])
    const record = recordOf(a)
    expect(record.envelope.code).toBe('session_expired')
    expect(record.envelope.action).toMatchObject({ kind: 'sign_in' })
    expect(record.envelope.detail).toBe('JWT expired at 1738...')
    expect(record.envelope.userMessage).not.toContain('JWT')
  })

  it('reauth_required forces session_expired + sign_in even when the wire says otherwise', () => {
    const a = projectServerEvent(
      partial({
        type: 'reauth_required',
        envelope: {
          code: 'internal_error',
          userMessage: 'Your session expired.',
          recoverability: 'fatal',
          action: { kind: 'open_settings', label: 'Settings' },
        },
      }),
      ctx
    )
    const record = recordOf(a)
    expect(record.envelope.code).toBe('session_expired')
    expect(record.envelope.action).toMatchObject({ kind: 'sign_in' })
    // A server-supplied userMessage is still honoured — only the affordance is fixed.
    expect(record.envelope.userMessage).toBe('Your session expired.')
  })

  it('free_generations_update maps to freeGenerationsUpdated', () => {
    const a = projectServerEvent({ type: 'free_generations_update', remaining: 41 }, ctx)
    expect(a[0].type).toBe(chatSliceActions.freeGenerationsUpdated.type)
    expect((a[0].payload as any)).toMatchObject({ remaining: 41, isFreeTier: true })
  })

  it('generation_limit_reached projects a chat bubble, NOT the blocking modal (D3)', () => {
    const a = projectServerEvent({ type: 'generation_limit_reached', message: 'quota=0 plan=free' }, ctx)
    expect(types(a)).toEqual([chatSliceActions.chatErrorRecorded.type])
    expect(types(a)).not.toContain(chatSliceActions.freeTierLimitModalShown.type)
    const record = recordOf(a)
    expect(record).toMatchObject({ conversationId: 'conv-1', streamId: 'stream-1', dismissed: false })
    expect(record.envelope.code).toBe('free_tier_exhausted')
    expect(record.envelope.action).toMatchObject({ kind: 'upgrade' })
    expect(record.envelope.detail).toBe('quota=0 plan=free')
    expect(record.envelope.userMessage).not.toContain('quota=0')
  })

  it('projects a completed server compaction summary into the active branch, after a notice', () => {
    const a = projectServerEvent(
      partial({
        type: 'context_compaction',
        status: 'completed',
        summaryMessage: { id: 'summary-1', role: 'system', note: '__auto_compaction_summary__', content: 'summary' },
      }),
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.streamChunkReceived.type,
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamLineageUpdated.type,
    ])
    expect(chunkOf(a)).toMatchObject({ type: 'notice', code: 'compacting' })
    expect((a[2].payload as any).newMessage.id).toBe('summary-1')
    expect((a[3].payload as any)).toMatchObject({ streamId: 'stream-1', branchAnchorMessageId: 'summary-1' })
  })

  // The server emits its own `notice{code:'compacting'}` beside this frame, so projecting a
  // second one here would explain the same pause twice. `completed` (below) IS ours — the
  // server sends nothing for it.
  it('compaction started is a no-op — the server announces the pause itself', () => {
    const a = projectServerEvent(partial({ type: 'context_compaction', status: 'started' }), ctx)
    expect(a).toEqual([])
  })

  it('compaction completed with no summary row still projects the notice', () => {
    const a = projectServerEvent(partial({ type: 'context_compaction', status: 'completed' }), ctx)
    expect(types(a)).toEqual([chatSliceActions.streamChunkReceived.type])
    expect(chunkOf(a)).toMatchObject({ type: 'notice', code: 'compacting' })
  })

  it('compaction failed projects a real, non-terminal error carrying its detail', () => {
    const a = projectServerEvent(
      partial({ type: 'context_compaction', status: 'failed', error: 'summariser returned empty' }),
      ctx
    )
    expect(types(a)).toEqual([chatSliceActions.streamChunkReceived.type])
    const chunk = chunkOf(a)
    expect(chunk).toMatchObject({ type: 'error', terminal: false })
    expect(chunk.errorEnvelope.code).toBe('compaction_failed')
    expect(chunk.errorEnvelope.action).toMatchObject({ kind: 'compact' })
    expect(chunk.errorEnvelope.detail).toBe('summariser returned empty')
  })

  it('compaction threshold_reached stays a no-op', () => {
    expect(projectServerEvent(partial({ type: 'context_compaction', status: 'threshold_reached' }), ctx)).toEqual([])
  })

  it('permission_required carries the correlation ids the resolver thunk needs for /resume', () => {
    const a = projectServerEvent({ type: 'permission_required', toolCallId: 'tc1', toolName: 'bash', toolInput: { cmd: 'ls' } }, ctx)
    expect(a[0].type).toBe(chatSliceActions.toolPermissionRequested.type)
    const p = a[0].payload as any
    expect(p.toolCall).toMatchObject({ id: 'tc1', name: 'bash', arguments: { cmd: 'ls' }, status: 'pending' })
    expect(p.streamId).toBe('stream-1')
    expect(p.toolCallId).toBe('tc1')
  })

  it('operation_mode_upgrade_required carries the tool and correlation ids', () => {
    const a = projectServerEvent(
      { type: 'operation_mode_upgrade_required', toolCallId: 'tc-upgrade', toolName: 'edit_file', toolInput: { path: 'a.ts' } },
      ctx
    )
    expect(a[0].type).toBe(chatSliceActions.operationModeUpgradeRequested.type)
    expect(a[0].payload as any).toMatchObject({
      streamId: 'stream-1',
      toolCallId: 'tc-upgrade',
      toolCall: { id: 'tc-upgrade', name: 'edit_file', arguments: { path: 'a.ts' } },
    })
  })

  it('clarify_required carries streamId + toolCallId', () => {
    const a = projectServerEvent({ type: 'clarify_required', toolCallId: 'tc2', toolName: 'plan_md', questions: [{ q: 'x' }] }, ctx)
    expect(a[0].type).toBe(chatSliceActions.planClarificationRequested.type)
    const p = a[0].payload as any
    expect(p).toMatchObject({ id: 'tc2', streamId: 'stream-1', toolCallId: 'tc2', questions: [{ q: 'x' }] })
  })

  it('no-op events return an empty action list', () => {
    for (const type of ['provider_routed', 'context_usage', 'tool_request', 'unknown_future_event']) {
      expect(projectServerEvent(partial({ type }), ctx)).toEqual([])
    }
  })

  it('never throws, whatever the wire sends', () => {
    const hostile: Record<string, unknown>[] = [
      { type: 'error' },
      { type: 'error', envelope: 'not-an-object' },
      { type: 'notice', code: 'retrying' },
      { type: 'tool_execution', status: 'failed' },
      { type: 'context_compaction', status: 'failed' },
      { type: 'reauth_required' },
      { type: 'generation_limit_reached' },
      { type: 'complete', message: null, envelope: null },
    ]
    for (const event of hostile) {
      expect(() => projectServerEvent(partial(event), ctx)).not.toThrow()
    }
  })
})
