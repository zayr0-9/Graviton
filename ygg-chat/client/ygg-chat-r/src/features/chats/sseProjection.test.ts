import './__testSupport__/localStorageShim' // must run before chatSlice import (reads localStorage at init)
import { describe, it, expect } from 'vitest'
import { projectServerEvent, normalizeServerMessage, type ProjectionContext } from './sseProjection'
import { chatSliceActions } from './chatSlice'

const ctx: ProjectionContext = { streamId: 'stream-1', conversationId: 'conv-1' }
const types = (actions: { type: string }[]) => actions.map(a => a.type)

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
  })

  it('passes through already-parsed values', () => {
    const m = normalizeServerMessage({ id: 'm1', tool_calls: [{ id: 't1' }], content_blocks: [{ type: 'text' }] }) as any
    expect(m.tool_calls[0].id).toBe('t1')
    expect(m.content_blocks[0].type).toBe('text')
  })
})

describe('projectServerEvent', () => {
  it('started seeds branch anchors from the server parentId', () => {
    const a = projectServerEvent({ type: 'started', parentId: 'p1' }, ctx)
    expect(types(a)).toEqual([chatSliceActions.streamLineageUpdated.type])
    expect((a[0].payload as any)).toMatchObject({
      streamId: 'stream-1',
      rootMessageId: 'p1',
      branchAnchorMessageId: 'p1',
      currentBranchAnchorMessageId: 'p1',
    })
  })

  it('started with no parentId is a no-op', () => {
    expect(projectServerEvent({ type: 'started', parentId: null }, ctx)).toEqual([])
  })

  it('user_message_persisted => messageAdded, messageBranchCreated, streamLineageUpdated (in order)', () => {
    const a = projectServerEvent(
      { type: 'user_message_persisted', message: { id: 'u1', role: 'user', content: 'hey', conversation_id: 'conv-1' } },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamLineageUpdated.type,
    ])
    expect((a[0].payload as any).id).toBe('u1')
    expect((a[1].payload as any).newMessage.id).toBe('u1')
    expect((a[2].payload as any).triggerUserMessageId).toBe('u1')
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

  it('terminal complete => messageAdded, messageBranchCreated, streamCompleted', () => {
    const a = projectServerEvent({ type: 'complete', message: { id: 'a2', role: 'assistant' } }, ctx)
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamCompleted.type,
    ])
    expect((a[2].payload as any)).toMatchObject({ streamId: 'stream-1', messageId: 'a2', updatePath: true })
  })

  it('error persists a partial assistant row but emits NO error chunk (thunk owns it)', () => {
    const withPartial = projectServerEvent({ type: 'error', error: 'boom', assistantMessage: { id: 'a3' } }, ctx)
    expect(types(withPartial)).toEqual([chatSliceActions.messageAdded.type])
    expect(projectServerEvent({ type: 'error', error: 'boom' }, ctx)).toEqual([])
  })

  it('tool_loop turn_started synthesizes a generation_started buffer clear; other statuses no-op', () => {
    const started = projectServerEvent({ type: 'tool_loop', status: 'turn_started', turn: 2, maxTurns: 100 }, ctx)
    expect((started[0].payload as any).chunk).toMatchObject({ type: 'generation_started', messageId: null })
    expect(projectServerEvent({ type: 'tool_loop', status: 'turn_completed', turn: 2, maxTurns: 100 }, ctx)).toEqual([])
  })

  it('free_generations_update maps to freeGenerationsUpdated', () => {
    const a = projectServerEvent({ type: 'free_generations_update', remaining: 41 }, ctx)
    expect(a[0].type).toBe(chatSliceActions.freeGenerationsUpdated.type)
    expect((a[0].payload as any)).toMatchObject({ remaining: 41, isFreeTier: true })
  })

  it('generation_limit_reached maps to freeTierLimitModalShown (Phase 4 cloud path modal)', () => {
    const a = projectServerEvent({ type: 'generation_limit_reached', message: 'Upgrade' }, ctx)
    expect(a).toHaveLength(1)
    expect(a[0].type).toBe(chatSliceActions.freeTierLimitModalShown.type)
  })

  it('projects a completed server compaction summary into the active branch', () => {
    const a = projectServerEvent(
      {
        type: 'context_compaction',
        status: 'completed',
        summaryMessage: { id: 'summary-1', role: 'system', note: '__auto_compaction_summary__', content: 'summary' },
      },
      ctx
    )
    expect(types(a)).toEqual([
      chatSliceActions.messageAdded.type,
      chatSliceActions.messageBranchCreated.type,
      chatSliceActions.streamLineageUpdated.type,
    ])
    expect((a[1].payload as any).newMessage.id).toBe('summary-1')
    expect((a[2].payload as any)).toMatchObject({ streamId: 'stream-1', branchAnchorMessageId: 'summary-1' })
  })

  it('does not project non-terminal compaction status events', () => {
    expect(projectServerEvent({ type: 'context_compaction', status: 'started' }, ctx)).toEqual([])
    expect(projectServerEvent({ type: 'context_compaction', status: 'failed' }, ctx)).toEqual([])
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
    for (const type of ['provider_routed', 'context_usage', 'tool_execution', 'tool_request', 'unknown_future_event']) {
      expect(projectServerEvent({ type }, ctx)).toEqual([])
    }
  })
})
