import { describe, expect, it, vi } from 'vitest'
import { ToolInvocationRepo } from '../toolInvocationRepo.js'

function harness() {
  const rows = new Map<string, any>()
  const statements = {
    insertToolInvocation: {
      run: vi.fn((id, conversationId, lineageId, runId, parentId, toolCallId, messageId, toolName, startedAt, createdAt, updatedAt) => {
        rows.set(id, {
          id, conversation_id: conversationId, lineage_id: lineageId, run_id: runId,
          parent_tool_invocation_id: parentId, tool_call_id: toolCallId,
          assistant_message_id: messageId, tool_name: toolName, status: 'running',
          started_at: startedAt, ended_at: null, duration_ms: null, error: null,
          created_at: createdAt, updated_at: updatedAt,
        })
      }),
    },
    finishToolInvocation: {
      run: vi.fn((status, endedAt, durationMs, error, updatedAt, id) => {
        const row = rows.get(id)
        if (row?.status === 'running') Object.assign(row, { status, ended_at: endedAt, duration_ms: durationMs, error, updated_at: updatedAt })
      }),
    },
    getToolInvocationById: { get: vi.fn((id: string) => rows.get(id)) },
    listToolInvocationsByLineage: { all: vi.fn((lineageId: string) => [...rows.values()].filter(row => row.lineage_id === lineageId)) },
  }
  return { repo: new ToolInvocationRepo({ statements }), statements }
}

describe('ToolInvocationRepo', () => {
  it('creates a metadata-only running ownership record with a server UUID', () => {
    const { repo, statements } = harness()
    const row = repo.create({
      conversationId: 'c1', lineageId: 'lin1', runId: 'stream1', toolCallId: 'provider-call',
      assistantMessageId: 'm1', toolName: 'bash', parentToolInvocationId: 'parent',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row).toMatchObject({ status: 'running', lineage_id: 'lin1', run_id: 'stream1', tool_call_id: 'provider-call', tool_name: 'bash', parent_tool_invocation_id: 'parent' })
    expect(statements.insertToolInvocation.run.mock.calls[0]).not.toContain(expect.stringContaining('secret'))
  })

  it('finishes once with duration and a bounded error', () => {
    const { repo, statements } = harness()
    repo.create({ id: 'inv1', conversationId: 'c1', lineageId: 'lin1', toolCallId: 'call1', assistantMessageId: 'm1', toolName: 'bash', startedAt: '2026-01-01T00:00:00.000Z' })
    const row = repo.finish('inv1', { status: 'failed', error: 'x'.repeat(3000), endedAt: '2026-01-01T00:00:01.250Z' })
    expect(row).toMatchObject({ status: 'failed', duration_ms: 1250 })
    expect(row?.error).toHaveLength(512)
    repo.finish('inv1', { status: 'completed', endedAt: '2026-01-01T00:00:02.000Z' })
    expect(statements.finishToolInvocation.run).toHaveBeenCalledTimes(1)
  })
})
