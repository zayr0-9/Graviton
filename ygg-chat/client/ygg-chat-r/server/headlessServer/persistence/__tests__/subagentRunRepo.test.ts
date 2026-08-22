import type Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { SubagentRunRepo } from '../subagentRunRepo.js'

let BetterSqlite3Ctor: (new (filename: string) => Database.Database) | null = null

try {
  const sqliteModule = await import('better-sqlite3')
  const candidate = sqliteModule.default as new (filename: string) => Database.Database
  const probe = new candidate(':memory:')
  probe.close()
  BetterSqlite3Ctor = candidate
} catch {
  BetterSqlite3Ctor = null
}

const describeIfSqlite = BetterSqlite3Ctor ? describe : describe.skip

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      lineage_id TEXT,
      parent_message_id TEXT NOT NULL,
      tool_call_id TEXT,
      prompt TEXT NOT NULL,
      provider TEXT,
      model_name TEXT,
      system_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      final_response TEXT,
      error TEXT,
      turns_used INTEGER DEFAULT 0,
      tool_calls_used INTEGER DEFAULT 0,
      handle TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_turn_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE subagent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
      content TEXT NOT NULL DEFAULT '',
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      content_blocks TEXT,
      sequence INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX idx_subagent_runs_handle ON subagent_runs(handle) WHERE handle IS NOT NULL;
  `)
}

function createStatements(db: Database.Database): any {
  return {
    upsertSubagentRun: db.prepare(`
      INSERT INTO subagent_runs (id, conversation_id, parent_message_id, tool_call_id, prompt, provider, model_name, system_prompt, status, final_response, error, turns_used, tool_calls_used, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        final_response = excluded.final_response,
        error = excluded.error,
        turns_used = excluded.turns_used,
        tool_calls_used = excluded.tool_calls_used,
        updated_at = excluded.updated_at
    `),
    attachSubagentRunToLineage: db.prepare('UPDATE subagent_runs SET lineage_id = ? WHERE id = ?'),
    updateSubagentRun: db.prepare(`
      UPDATE subagent_runs
      SET status = COALESCE(?, status),
          final_response = COALESCE(?, final_response),
          error = ?,
          turns_used = COALESCE(?, turns_used),
          tool_calls_used = COALESCE(?, tool_calls_used),
          updated_at = ?
      WHERE id = ?
    `),
    insertSubagentMessage: db.prepare(`
      INSERT INTO subagent_messages (id, run_id, role, content, thinking_block, tool_calls, tool_call_id, content_blocks, sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        thinking_block = excluded.thinking_block,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        content_blocks = excluded.content_blocks
    `),
    getSubagentRunsByConversationId: db.prepare('SELECT * FROM subagent_runs WHERE conversation_id = ? ORDER BY created_at ASC'),
    getSubagentRunsByParentMessageId: db.prepare('SELECT * FROM subagent_runs WHERE parent_message_id = ? ORDER BY created_at ASC'),
    getSubagentRunById: db.prepare('SELECT * FROM subagent_runs WHERE id = ?'),
    getSubagentRunByHandle: db.prepare('SELECT * FROM subagent_runs WHERE handle = ?'),
    getSubagentRunsByToolCallId: db.prepare('SELECT * FROM subagent_runs WHERE tool_call_id = ? ORDER BY created_at ASC'),
    getSubagentRunsByLineageId: db.prepare('SELECT * FROM subagent_runs WHERE lineage_id = ? ORDER BY created_at ASC'),
    getSubagentRunsByLineageAndStatus: db.prepare('SELECT * FROM subagent_runs WHERE lineage_id = ? AND status = ? ORDER BY created_at ASC'),
    attachSubagentRunHandle: db.prepare('UPDATE subagent_runs SET handle = ? WHERE id = ?'),
    reopenSubagentRun: db.prepare(`
      UPDATE subagent_runs
      SET status = 'running', error = NULL, attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND status IN ('error', 'aborted')
    `),
    getSubagentMessagesByRunId: db.prepare('SELECT * FROM subagent_messages WHERE run_id = ? ORDER BY sequence ASC, created_at ASC'),
    getNextSubagentMessageSequence: db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS nextSequence FROM subagent_messages WHERE run_id = ?'),
  }
}

describeIfSqlite('SubagentRunRepo', () => {
  let db: Database.Database
  let repo: SubagentRunRepo

  beforeEach(() => {
    if (!BetterSqlite3Ctor) throw new Error('better-sqlite3 unavailable')
    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    repo = new SubagentRunRepo({ statements: createStatements(db) })
  })

  afterEach(() => {
    db.close()
  })

  const makeRun = () =>
    repo.createRun({
      conversationId: 'c1',
      parentMessageId: 'p1',
      toolCallId: 'call-1',
      prompt: 'do the task',
      provider: 'openaichatgpt',
      modelName: 'gpt-5.6-sol',
      systemPrompt: 'be helpful',
    })

  it('creates a run with defaults', () => {
    const run = makeRun()
    expect(run.status).toBe('running')
    expect(run.turns_used).toBe(0)
    expect(run.tool_calls_used).toBe(0)
    expect(run.messages).toEqual([])
    expect(repo.getRunById(run.id)?.prompt).toBe('do the task')
  })

  it('attaches an inherited content lineage without changing the run id', () => {
    const run = repo.createRun({
      id: 'distinct-subagent-run',
      conversationId: 'c1',
      lineageId: 'content-lineage-1',
      parentMessageId: 'p1',
      prompt: 'do the task',
    })

    expect(run.id).toBe('distinct-subagent-run')
    expect(run.lineage_id).toBe('content-lineage-1')
  })

  it('appends messages with monotonic sequence and parses JSON columns', () => {
    const run = makeRun()
    repo.appendMessage(run.id, { role: 'user', content: 'hi' })
    repo.appendMessage(run.id, {
      role: 'assistant',
      content: 'answer',
      toolCalls: [{ id: 't1', name: 'read_file' }],
      contentBlocks: [{ type: 'text', content: 'answer' }],
    })

    const messages = repo.getMessages(run.id)
    expect(messages.map(m => m.sequence)).toEqual([0, 1])
    expect(messages[1].tool_calls).toEqual([{ id: 't1', name: 'read_file' }])
    expect(messages[1].content_blocks).toEqual([{ type: 'text', content: 'answer' }])
  })

  it('upserts a message by id and preserves content via updateMessageToolState', () => {
    const run = makeRun()
    const created = repo.appendMessage(run.id, { role: 'assistant', content: 'the answer' })

    const updated = repo.updateMessageToolState(run.id, created.id, {
      contentBlocks: [{ type: 'text', content: 'the answer' }, { type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
      toolCalls: [{ id: 'x', name: 'read_file', status: 'complete' }],
    })

    expect(updated).not.toBeNull()
    const messages = repo.getMessages(run.id)
    expect(messages).toHaveLength(1) // same row, not a new one
    expect(messages[0].content).toBe('the answer') // content preserved
    expect(messages[0].tool_calls).toEqual([{ id: 'x', name: 'read_file', status: 'complete' }])
    expect(messages[0].content_blocks).toHaveLength(2)
  })

  it('updates run status with COALESCE semantics', () => {
    const run = makeRun()
    repo.updateRun(run.id, { turnsUsed: 3 })
    // status omitted -> preserved as 'running'; final_response omitted -> preserved as null
    let row = repo.getRunById(run.id)
    expect(row?.status).toBe('running')
    expect(row?.turns_used).toBe(3)

    repo.updateRun(run.id, { status: 'completed', finalResponse: 'done', toolCallsUsed: 2 })
    row = repo.getRunById(run.id)
    expect(row?.status).toBe('completed')
    expect(row?.final_response).toBe('done')
    expect(row?.tool_calls_used).toBe(2)
    expect(row?.turns_used).toBe(3) // preserved
  })

  it('lists runs by conversation and parent with nested messages', () => {
    const run = makeRun()
    repo.appendMessage(run.id, { role: 'user', content: 'hi' })

    const byConversation = repo.listByConversation('c1')
    expect(byConversation).toHaveLength(1)
    expect(byConversation[0].messages).toHaveLength(1)

    const byParent = repo.listByParentMessage('p1')
    expect(byParent).toHaveLength(1)
    expect(byParent[0].id).toBe(run.id)
  })

  it('returns null updating an unknown message', () => {
    const run = makeRun()
    expect(repo.updateMessageToolState(run.id, 'missing', { contentBlocks: [], toolCalls: [] })).toBeNull()
  })

  it('mints a unique 6-digit handle resolvable via getRunByHandle', () => {
    const a = makeRun()
    const b = makeRun()
    expect(a.handle).toMatch(/^\d{6}$/)
    expect(b.handle).toMatch(/^\d{6}$/)
    expect(a.handle).not.toBe(b.handle)
    expect(a.attempt).toBe(0)
    expect(repo.getRunByHandle(a.handle!)?.id).toBe(a.id)
    expect(repo.getRunByHandle('000000')).toBeNull()
  })

  it('honors an explicit handle when supplied', () => {
    const run = repo.createRun({
      conversationId: 'c1',
      parentMessageId: 'p1',
      prompt: 'task',
      handle: '424242',
    })
    expect(run.handle).toBe('424242')
    expect(repo.getRunByHandle('424242')?.id).toBe(run.id)
  })

  it('lists runs by tool call with transcripts', () => {
    const run = makeRun() // tool_call_id 'call-1'
    repo.appendMessage(run.id, { role: 'user', content: 'hi' })
    repo.createRun({ conversationId: 'c1', parentMessageId: 'p1', toolCallId: 'call-2', prompt: 'other' })

    const byToolCall = repo.listByToolCall('call-1')
    expect(byToolCall).toHaveLength(1)
    expect(byToolCall[0].id).toBe(run.id)
    expect(byToolCall[0].messages).toHaveLength(1)
  })

  it('lists runs by lineage and by lineage+status (lightweight, no transcript)', () => {
    const running = repo.createRun({ conversationId: 'c1', lineageId: 'lin-A', parentMessageId: 'p1', prompt: 'a' })
    const failed = repo.createRun({ conversationId: 'c1', lineageId: 'lin-A', parentMessageId: 'p1', prompt: 'b' })
    repo.updateRun(failed.id, { status: 'error', error: 'boom' })
    // A parallel branch in the same conversation must NOT leak into lin-A's view.
    repo.createRun({ conversationId: 'c1', lineageId: 'lin-B', parentMessageId: 'p1', prompt: 'other-branch' })
    repo.appendMessage(running.id, { role: 'user', content: 'hi' })

    const all = repo.listByLineage('lin-A')
    expect(all.map(r => r.id).sort()).toEqual([running.id, failed.id].sort())
    expect(all.every(r => r.messages?.length === 0)).toBe(true) // lightweight

    const onlyRunning = repo.listByLineage('lin-A', 'running')
    expect(onlyRunning.map(r => r.id)).toEqual([running.id])
    expect(repo.listByLineage('lin-B')).toHaveLength(1)
  })

  it('reopenRun transitions error/aborted -> running, bumps attempt, and guards terminal/running', () => {
    const run = makeRun()

    // running -> cannot reopen (idempotency / not-yet-failed guard)
    expect(repo.reopenRun(run.id)).toBe(false)

    repo.updateRun(run.id, { status: 'error', error: 'boom' })
    expect(repo.reopenRun(run.id)).toBe(true)
    let row = repo.getRunById(run.id)
    expect(row?.status).toBe('running')
    expect(row?.error).toBeNull() // cleared on reopen
    expect(row?.attempt).toBe(1)

    // now running again -> reopen is a no-op
    expect(repo.reopenRun(run.id)).toBe(false)

    // completed -> never resumable
    repo.updateRun(run.id, { status: 'completed', finalResponse: 'done' })
    expect(repo.reopenRun(run.id)).toBe(false)
    expect(repo.getRunById(run.id)?.attempt).toBe(1) // unchanged
  })
})
