import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { CLAUDE_SESSION_SCHEMA } from '../../persistence/claudeSessionRepo.js'
import { CLAUDE_TRANSFERRED_SOURCE_MESSAGE } from '../../../../../../shared/claudeTransfer.js'
import { MessageRepo } from '../../persistence/messageRepo.js'
import { LineageRepo } from '../../persistence/lineageRepo.js'
import { normalizeHostExecutionPreferences } from '../../../../../../shared/hostExecutionPreferences.js'
import { DecisionBroker } from '../decisionBroker.js'
import { RunAdmissionService } from '../runAdmissionService.js'
import { RunSessionRegistry } from '../runSessionRegistry.js'
import { OperationReceiptRepo, OPERATION_RECEIPT_SCHEMA } from '../../persistence/operationReceiptRepo.js'
import {
  ChatOrchestrator,
  linkPreparedAttachmentsToMessage,
  shouldRejectSourceLineageMismatch,
} from '../chatOrchestrator.js'

let BetterSqlite3Ctor: (new (filename: string) => Database.Database) | null = null
let FullAccessSqliteCtor: (new (filename: string) => Database.Database) | null = null

try {
  const sqliteModule = await import('better-sqlite3')
  const candidate = sqliteModule.default as new (filename: string) => Database.Database
  const probe = new candidate(':memory:')
  probe.close()
  BetterSqlite3Ctor = candidate
} catch {
  // Match topLevelUserMessages.test.ts: use real Node SQLite when the installed
  // addon targets Electron. Savepoints preserve the repos' nested transactions.
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    FullAccessSqliteCtor = class {
      private db: any
      private savepoint = 0
      constructor(filename: string) { this.db = new DatabaseSync(filename) }
      prepare(sql: string) { return this.db.prepare(sql) }
      exec(sql: string) { return this.db.exec(sql) }
      close() { this.db.close() }
      transaction<T>(run: () => T): () => T {
        return () => {
          const name = `test_${this.savepoint++}`
          this.db.exec(`SAVEPOINT ${name}`)
          try {
            const result = run()
            this.db.exec(`RELEASE ${name}`)
            return result
          } catch (error) {
            this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
            throw error
          }
        }
      }
    } as unknown as new (filename: string) => Database.Database
  } catch { FullAccessSqliteCtor = null }
}
FullAccessSqliteCtor ??= BetterSqlite3Ctor

const describeIfSqlite = BetterSqlite3Ctor ? describe : describe.skip

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      user_id TEXT,
      context TEXT,
      system_prompt TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      title TEXT,
      model_name TEXT,
      system_prompt TEXT,
      conversation_context TEXT,
      research_note TEXT,
      cwd TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      lineage_id TEXT,
      children_ids TEXT,
      role TEXT,
      content TEXT,
      plain_text_content TEXT,
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      model_name TEXT,
      note TEXT,
      note_color TEXT,
      ex_agent_session_id TEXT,
      ex_agent_type TEXT,
      content_blocks TEXT,
      created_at TEXT,
      meta TEXT
    );

    CREATE TABLE lineages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_lineage_id TEXT,
      forked_from_message_id TEXT, root_message_id TEXT, head_message_id TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE fork_operations (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_lineage_id TEXT,
      target_lineage_id TEXT NOT NULL, source_message_id TEXT, materialized_message_id TEXT,
      operation TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY,
      file_path TEXT,
      mime_type TEXT,
      sha256 TEXT,
      created_at TEXT
    );

    CREATE TABLE message_attachment_links (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      created_at TEXT,
      UNIQUE(message_id, attachment_id)
    );
  `)
}

function createStatements(db: Database.Database): any {
  const invocations = new Map<string, any>()
  return {
    insertToolInvocation: { run: (id: string, conversation_id: string, lineage_id: string, run_id: string, parent_tool_invocation_id: string, tool_call_id: string, assistant_message_id: string, tool_name: string, started_at: string) => {
      invocations.set(id, { id, conversation_id, lineage_id, run_id, parent_tool_invocation_id, tool_call_id, assistant_message_id, tool_name, started_at, status: 'running' })
    } },
    getToolInvocationById: { get: (id: string) => invocations.get(id) },
    finishToolInvocation: { run: (status: string, ended_at: string, duration_ms: number, error: string, _updated: string, id: string) => {
      Object.assign(invocations.get(id), { status, ended_at, duration_ms, error })
    } },
    upsertConversation: db.prepare(`
      INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        model_name = excluded.model_name,
        system_prompt = excluded.system_prompt,
        conversation_context = excluded.conversation_context,
        research_note = excluded.research_note,
        cwd = excluded.cwd,
        storage_mode = excluded.storage_mode,
        updated_at = excluded.updated_at
    `),
    getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),

    upsertMessage: db.prepare(`
      INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        plain_text_content = excluded.plain_text_content,
        thinking_block = excluded.thinking_block,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        model_name = excluded.model_name,
        note = excluded.note,
        note_color = excluded.note_color,
        ex_agent_session_id = excluded.ex_agent_session_id,
        ex_agent_type = excluded.ex_agent_type,
        content_blocks = excluded.content_blocks
    `),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
    getAttachmentById: db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
    linkAttachment: db.prepare(`
      INSERT OR IGNORE INTO message_attachment_links (id, message_id, attachment_id, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getAttachmentsByMessageId: db.prepare(`
      SELECT ma.* FROM message_attachment_links mal
      JOIN message_attachments ma ON ma.id = mal.attachment_id
      WHERE mal.message_id = ? ORDER BY ma.created_at ASC
    `),
    insertLineage: db.prepare('INSERT INTO lineages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    getLineageById: db.prepare('SELECT * FROM lineages WHERE id = ?'),
    listLineagesByConversation: db.prepare('SELECT * FROM lineages WHERE conversation_id = ? ORDER BY created_at, id'),
    resolveLineageByMessage: db.prepare('SELECT l.* FROM messages m JOIN lineages l ON l.id = m.lineage_id WHERE m.id = ?'),
    resolveAncestorLineageByMessage: db.prepare(`WITH RECURSIVE ancestors(id, parent_id, lineage_id, depth) AS (
      SELECT id, parent_id, lineage_id, 0 FROM messages WHERE id = ? UNION ALL
      SELECT m.id, m.parent_id, m.lineage_id, a.depth + 1 FROM messages m JOIN ancestors a ON m.id = a.parent_id WHERE a.depth < 100
    ) SELECT l.* FROM ancestors a JOIN lineages l ON l.id = a.lineage_id ORDER BY a.depth LIMIT 1`),
    attachMessageToLineage: db.prepare('UPDATE messages SET lineage_id = ? WHERE id = ? AND conversation_id = (SELECT conversation_id FROM lineages WHERE id = ?) AND (lineage_id IS NULL OR lineage_id = ?)'),
    advanceLineage: db.prepare('UPDATE lineages SET root_message_id = COALESCE(root_message_id, ?), head_message_id = ?, status = ?, updated_at = ? WHERE id = ?'),
    insertForkOperation: db.prepare('INSERT INTO fork_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    getForkOperationById: db.prepare('SELECT * FROM fork_operations WHERE id = ?'),
    materializeForkOperation: db.prepare("UPDATE fork_operations SET materialized_message_id = ?, status = 'materialized', updated_at = ? WHERE id = ? AND status = 'pending'"),
    attachStreamingRunToLineage: { run: () => {} },
    upsertStreamingRun: { run: () => {} },
    getStreamingRunById: { get: () => null },
    updateStreamingRun: { run: () => {} },
  }
}

class FakeProviderRouter {
  public calls: any[] = []
  private readonly queuedOutputs: any[] = []

  enqueue(output: any): void {
    this.queuedOutputs.push(output)
  }

  async generate(_provider: string, input: any): Promise<any> {
    this.calls.push(input)
    if (this.queuedOutputs.length > 0) {
      const next = this.queuedOutputs.shift()
      if (next instanceof Error) throw next
      return next
    }
    return { content: `assistant:${input.userContent}` }
  }
}

describe('prepared attachment linking', () => {
  it('deduplicates IDs, links them to the server-assigned message, and returns metadata', () => {
    const rows = new Map([
      ['att-1', { id: 'att-1', file_path: '/tmp/one.png' }],
      ['att-2', { id: 'att-2', file_path: '/tmp/two.png' }],
    ])
    const links: any[][] = []
    const statements = {
      getAttachmentById: { get: (id: string) => rows.get(id) },
      linkAttachment: { run: (...args: any[]) => links.push(args) },
    }

    const linked = linkPreparedAttachmentsToMessage(statements, 'message-1', [
      { attachmentId: 'att-1' },
      { attachment_id: 'att-1' },
      { attachmentId: 'att-2' },
    ])

    expect(linked).toEqual([rows.get('att-1'), rows.get('att-2')])
    expect(links).toHaveLength(2)
    expect(links.map(([, messageId, attachmentId]) => [messageId, attachmentId])).toEqual([
      ['message-1', 'att-1'],
      ['message-1', 'att-2'],
    ])
  })
})

describe('source lineage membership validation', () => {
  it('allows an inferred creation owner whose moving head is on a sibling path', () => {
    expect(shouldRejectSourceLineageMismatch(null, false)).toBe(false)
    expect(shouldRejectSourceLineageMismatch(undefined, false)).toBe(false)
  })

  it('still rejects a mismatched lineage explicitly asserted by the client', () => {
    expect(shouldRejectSourceLineageMismatch('lineage-c', false)).toBe(true)
    expect(shouldRejectSourceLineageMismatch('lineage-c', true)).toBe(false)
  })
})

;(FullAccessSqliteCtor ? describe : describe.skip)('ChatOrchestrator Full access notifications', () => {
  let db: Database.Database
  let statements: any
  let messageRepo: MessageRepo
  let providerRouter: FakeProviderRouter
  let orchestrator: ChatOrchestrator
  let testDirectory: string

  beforeEach(() => {
    if (!FullAccessSqliteCtor) throw new Error('SQLite is unavailable in this runtime')

    testDirectory = mkdtempSync(path.join(os.tmpdir(), 'chat-image-lifecycle-'))
    mkdirSync(path.join(testDirectory, 'user_images'))
    db = new FullAccessSqliteCtor(path.join(testDirectory, 'chat.db'))
    createSchema(db)
    statements = createStatements(db)

    const now = new Date().toISOString()
    statements.upsertConversation.run('c1', null, 'u1', 'Conversation', 'gpt-5.1-codex-mini', null, null, null, null, 'local', now, now)

    messageRepo = new MessageRepo({ db, statements })
    providerRouter = new FakeProviderRouter()
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
    if (testDirectory) rmSync(testDirectory, { recursive: true, force: true })
  })

  it('fences real constructor admission during cloud deletion and releases it afterward', async () => {
    const { withMessageDeletionLock } = await import('../../persistence/deleteMessages.js')
    const source = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'source' })
    await withMessageDeletionLock(db, [source.id], async () => {
      expect(() => orchestrator.validateExecutionSelection({ operation: 'send', conversationId: 'c1',
        provider: 'openaichatgpt', modelName: 'test', content: 'next', parentId: source.id } as any)).toThrow('deletion is in progress')
    })
    expect(() => orchestrator.validateExecutionSelection({ operation: 'send', conversationId: 'c1',
      provider: 'openaichatgpt', modelName: 'test', content: 'next', parentId: source.id } as any)).not.toThrow()
  })

  it('forks an explicit branch send from the lineage head instead of appending in place', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const claudeSessions = { run: vi.fn(async (input: any) => {
      const message = input.sink.persistAssistantMessage({ conversationId: input.request.conversationId,
        parentId: input.parentId, modelName: input.request.modelName, content: 'reply', meta: { claude: { sessionId: 's' } } })
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(message.id, 's', `uuid-${message.id}`, testDirectory)
      return message
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const base: any = { operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5',
      content: 'hello', rootPath: testDirectory, operationMode: 'plan' }
    const events: any[] = []
    await orchestrator.runMessage(base, event => events.push(event))
    const head = events.find(event => event.type === 'complete')
    const branchEvents: any[] = []
    await orchestrator.runMessage({ ...base, parentId: head.message.id, lineageId: head.lineageId, isBranch: true, content: 'explain' },
      event => branchEvents.push(event))
    const branchLineage = branchEvents.find(event => event.type === 'complete').lineageId
    expect(branchLineage).not.toBe(head.lineageId)
    expect((db.prepare('SELECT head_message_id FROM lineages WHERE id=?').get(head.lineageId) as any).head_message_id).toBe(head.message.id)
  })

  it('dispatches Claude outside the Graviton loop, locks provider and preserves historical fork placement', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const calls: any[] = []
    const claudeSessions = { run: vi.fn(async (input: any) => {
      calls.push(input)
      const message = input.sink.persistAssistantMessage({ conversationId: input.request.conversationId,
        parentId: input.parentId, modelName: input.request.modelName, content: `Claude ${calls.length}`,
        meta: { claude: { sessionId: 's', messageUuid: `uuid-${calls.length}` } } })
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(message.id, 's', `uuid-${calls.length}`, testDirectory)
      input.emit({ type: 'assistant_message_persisted', message, lineageId: input.lineageId })
      return message
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const events: any[] = []
    const base: any = { operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5',
      content: 'hello', rootPath: testDirectory, operationMode: 'plan' }
    await orchestrator.runMessage(base, event => events.push(event))
    const first = events.find(event => event.type === 'complete').message
    expect(providerRouter.calls).toHaveLength(0)
    expect(events.filter(event => event.type === 'user_message_persisted')).toHaveLength(1)
    expect(events.some(event => event.type === 'operation_mode_changed' || event.type === 'context_injection_persisted')).toBe(false)
    await expect(orchestrator.runMessage({ ...base, parentId: first.id, modelName: 'different' }, () => {})).rejects.toThrow('supported Claude model')
    await expect(orchestrator.runMessage({ ...base, parentId: first.id, provider: 'openaichatgpt' }, () => {})).rejects.toThrow('fixed provider')
    await orchestrator.runMessage({ ...base, parentId: first.id, content: 'continue' }, () => {})
    await orchestrator.runMessage({ ...base, operation: 'branch', messageId: first.id, content: 'fork', operationMode: 'execute' }, () => {})
    expect(calls[2]).toMatchObject({ sourceMessageId: first.id, fork: true })
    // No mode-notification rows: each Claude user row records its own turn's mode.
    const metaOf = (row: any) => typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta
    expect(metaOf(events.find(event => event.type === 'user_message_persisted').message).operationMode).toBe('plan')
    expect(metaOf(statements.getMessageById.get(calls[2].parentId)).operationMode).toBe('execute')
    expect(statements.getMessageById.get(calls[2].parentId).parent_id).toBe(first.id)
    expect(calls[2].lineageId).not.toBe(calls[0].lineageId)
    const originalUser = events.find(event => event.type === 'user_message_persisted').message
    await orchestrator.runMessage({ ...base, operation: 'edit-branch', messageId: originalUser.id, content: 'edited root' }, () => {})
    expect(calls[3]).toMatchObject({ sourceMessageId: null, fork: true })
    await orchestrator.runMessage({ ...base, operation: 'repeat', parentId: originalUser.id }, () => {})
    expect(calls[4]).toMatchObject({ sourceMessageId: null, fork: true, request: { content: 'hello' } })
    expect(calls[4].parentId).toBe(originalUser.id)
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any
    const partial = messageRepo.createMessage({ conversationId: 'c1', parentId: first.id, role: 'assistant', content: 'partial', meta: { modelSelection: { provider: 'claudecode', model: base.modelName }, claude: { partial: true } } })
    const afterPartial = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n
    expect(afterPartial).toBe(count.n + 1)
    await expect(orchestrator.runMessage({ ...base, parentId: partial.id }, () => {})).rejects.toThrow('nothing to continue from')
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(afterPartial)
    const currentHead = db.prepare('SELECT head_message_id FROM lineages WHERE id=?').get(calls[0].lineageId) as any
    db.prepare("UPDATE claude_branch_sessions SET state='running' WHERE lineage_id=?").run(calls[0].lineageId)
    await expect(orchestrator.runMessage({ ...base, parentId: currentHead.head_message_id, lineageId: calls[0].lineageId }, () => {})).rejects.toThrow('still running')
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(afterPartial)
    // An interrupted head with a checkpoint continues in place; the session service forks natively.
    db.prepare("UPDATE claude_branch_sessions SET state='interrupted' WHERE lineage_id=?").run(calls[0].lineageId)
    await orchestrator.runMessage({ ...base, parentId: currentHead.head_message_id, lineageId: calls[0].lineageId, content: 'after sleep' }, () => {})
    expect(calls[5]).toMatchObject({ lineageId: calls[0].lineageId, sourceMessageId: currentHead.head_message_id, fork: false })
    await orchestrator.runMessage({ ...base, retrigger: true, parentId: first.id, lineageId: calls[0].lineageId, content: 'retry stopped input' }, () => {})
    expect(calls[6].lineageId).not.toBe(calls[0].lineageId)
    expect(calls[6].sourceMessageId).toBe(first.id)
    // The model is not part of the lock: the same native lineage continues under another Claude model.
    const head = (db.prepare('SELECT head_message_id FROM lineages WHERE id=?').get(calls[0].lineageId) as any).head_message_id
    await orchestrator.runMessage({ ...base, parentId: head, lineageId: calls[0].lineageId, modelName: 'claude-opus-5-5', content: 'switch model' }, () => {})
    expect(calls[7]).toMatchObject({ lineageId: calls[0].lineageId, sourceMessageId: head, request: { modelName: 'claude-opus-5-5' } })
    expect(db.prepare('SELECT model FROM claude_branch_sessions WHERE lineage_id=?').get(calls[0].lineageId)).toEqual({ model: 'claude-opus-5-5' })
  })

  it('hands queued input to a live Claude session and persists it where Claude starts it', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const cancels: Array<boolean | null> = [null, false, true]
    const claudeSessions = { run: vi.fn(async (input: any) => {
      const queue = input.queuedInput
      let woke = 0
      queue.subscribe(() => { woke++ })
      queue.bindCancel(async () => cancels.shift()!)
      const persist = (parentId: string, content: string) => {
        const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId, modelName: input.request.modelName, content,
          meta: { claude: { sessionId: 's' } } })
        input.emit({ type: 'assistant_message_persisted', message, lineageId: input.lineageId })
        return message
      }
      const toolTurn = persist(input.parentId, 'running a tool')
      expect(() => orchestrator.submitQueuedMessage('c1', 'claude-q', { requestId: 'slash', content: '/review' })).toThrow('slash commands')
      // Claude runs are always restricted, so a stale Full access flag is dropped rather than refused.
      orchestrator.submitQueuedMessage('c1', 'claude-q', { requestId: 'q1', content: 'also check tests', fullAccess: true,
        selectedFiles: [{ path: 'a.ts', contents: 'x' }] as any })
      // Starting with a path is prose to Claude Code, not a slash command.
      orchestrator.submitQueuedMessage('c1', 'claude-q', { requestId: 'q2', content: '/Users/me/notes.md never mind' })
      expect(woke).toBe(2)
      expect(await queue.prepareNext()).toEqual({ requestId: 'q1', prompt: 'also check tests\n\nSelected file context:\nFile: a.ts\nx', images: [] })
      // Not offered yet: cancelled locally. Already started: refused. Held by Claude: withdrawn by Claude.
      expect((await orchestrator.cancelQueuedMessage('c1', 'claude-q', 'q2')).items.find(item => item.requestId === 'q2')?.status).toBe('cancelled')
      await expect(orchestrator.cancelQueuedMessage('c1', 'claude-q', 'q1')).rejects.toThrow('already started')
      expect(await queue.prepareNext()).toBeNull()
      expect(orchestrator.getMessageQueue('c1', 'claude-q').items.find(item => item.requestId === 'q1')?.status).toBe('queued')
      expect(queue.tryClose()).toBe(false)
      const user = queue.deliver('q1', toolTurn.id, { mode: 'execute', modeSwitch: null })
      expect(user).toMatchObject({ parent_id: toolTurn.id, role: 'user', content: 'also check tests' })
      const final = persist(user.id, 'done')
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(final.id, 's', 'uuid-final', testDirectory)
      expect(queue.tryClose()).toBe(true)
      return final
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const events: any[] = []
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5',
      content: 'hello', rootPath: testDirectory, streamId: 'claude-q' } as any, event => events.push(event))
    const queued = events.filter(event => event.type === 'queued_user_message_persisted')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ requestId: 'q1', streamId: 'claude-q' })
    expect(orchestrator.getMessageQueue('c1', 'claude-q').items.map(item => [item.requestId, item.status]))
      .toEqual([['q1', 'delivered'], ['q2', 'cancelled']])
    const complete = events.find(event => event.type === 'complete')
    expect((db.prepare('SELECT head_message_id FROM lineages WHERE id=?').get(complete.lineageId) as any).head_message_id).toBe(complete.message.id)
    expect(statements.getMessageById.get(complete.message.id).parent_id).toBe(queued[0].message.id)
  })

  it('switches a live Claude run between Chat and Agent mode and records each switch where Claude read it', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const claudeSessions = { run: vi.fn(async (input: any) => {
      const queue = input.queuedInput
      let woke = 0
      queue.subscribe(() => { woke++ })
      queue.bindCancel(async () => null)
      const persist = (parentId: string, content: string) => {
        const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId, modelName: input.request.modelName, content,
          meta: { claude: { sessionId: 's' } } })
        input.emit({ type: 'assistant_message_persisted', message, lineageId: input.lineageId })
        return message
      }
      const toolTurn = persist(input.parentId, 'running a tool')
      // The route flips the shared control at once (the session's edit guard reads it) and wakes the session.
      const accepted = orchestrator.changeOperationMode({ conversationId: 'c1', mode: 'plan', requestId: 'm1', streamId: 'claude-mode' })
      expect(accepted).toMatchObject({ status: 'pending', mode: 'plan', revision: 1 })
      expect(input.modeControl.mode).toBe('plan')
      expect(woke).toBe(1)
      // Claude read the switch on its own at the tool boundary.
      const modeRow = queue.recordModeSwitch({ mode: 'plan', previousMode: 'execute', revision: 1, content: 'switched to Chat' }, toolTurn.id)
      expect(modeRow).toMatchObject({ parent_id: toolTurn.id, role: 'user', content: 'switched to Chat' })
      expect(input.modeControl.hasPending).toBe(false)
      // A later switch rides on a queued message: mode row first, then the user row recording its mode.
      orchestrator.changeOperationMode({ conversationId: 'c1', mode: 'execute', requestId: 'm2', streamId: 'claude-mode' })
      orchestrator.submitQueuedMessage('c1', 'claude-mode', { requestId: 'q1', content: 'now edit it' })
      expect(await queue.prepareNext()).toMatchObject({ requestId: 'q1', prompt: 'now edit it' })
      const user = queue.deliver('q1', modeRow.id, { mode: 'execute',
        modeSwitch: { mode: 'execute', previousMode: 'plan', revision: 2, content: 'switched to Agent' } })
      const agentRow = statements.getMessageById.get(user.parent_id)
      expect(agentRow).toMatchObject({ parent_id: modeRow.id, role: 'user', content: 'switched to Agent' })
      expect(JSON.parse(user.meta)).toMatchObject({ operationMode: 'execute' })
      const final = persist(user.id, 'done')
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(final.id, 's', 'uuid-final', testDirectory)
      queue.tryClose()
      return final
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const events: any[] = []
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5',
      content: 'hello', rootPath: testDirectory, streamId: 'claude-mode', operationMode: 'execute' } as any, event => events.push(event))
    const changes = events.filter(event => event.type === 'operation_mode_changed')
    expect(changes.map(event => [event.mode, event.revision, JSON.parse(event.message.meta).kind])).toEqual([
      ['plan', 1, 'operation_mode_change'], ['execute', 2, 'operation_mode_change']])
    expect(() => orchestrator.changeOperationMode({ conversationId: 'c1', mode: 'plan', requestId: 'm3', streamId: 'claude-mode' }))
      .toThrow('no longer active')
    // A message queued after the run ends starts its successor in the mode the run ended in.
    const next = orchestrator.submitQueuedMessage('c1', 'claude-mode', { requestId: 'q2', content: 'after the run' })
    expect(next.restart).toMatchObject({ operationMode: 'execute', content: 'after the run' })
  })

  it('accepts a live Claude mode switch during native compaction', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    let accepted: unknown
    const claudeSessions = { run: vi.fn(async (input: any) => {
      accepted = orchestrator.changeOperationMode({ conversationId: 'c1', mode: 'plan', requestId: 'm1', streamId: 'claude-compact-mode' })
      expect(input.modeControl.mode).toBe('plan')
      return input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId, modelName: input.request.modelName,
        content: 'summary', meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 's' } } })
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5',
      content: '/compact', manualCompaction: true, rootPath: testDirectory, streamId: 'claude-compact-mode', operationMode: 'execute' } as any, () => {})
    expect(accepted).toMatchObject({ status: 'pending', mode: 'plan' })
  })

  it('queues a live mode switch during manual compaction and records it after the summary', async () => {
    const events: any[] = []
    vi.spyOn(providerRouter, 'generate').mockImplementation(async () => {
      expect(orchestrator.changeOperationMode({ conversationId: 'c1', mode: 'plan', requestId: 'm1', streamId: 'manual-mode' }))
        .toMatchObject({ status: 'pending', mode: 'plan' })
      return { content: 'Committed summary' }
    })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', content: '/compact', provider: 'openaichatgpt',
      modelName: 'test', streamId: 'manual-mode', manualCompaction: true, operationMode: 'execute' }, event => events.push(event))
    const completedIndex = events.findIndex(event => event.type === 'context_compaction' && event.status === 'completed')
    // The run may first announce its initial mode; the switch is the Chat row.
    const changed = events.findIndex(event => event.type === 'operation_mode_changed' && event.mode === 'plan')
    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(changed).toBeGreaterThan(completedIndex)
    expect(events[changed]).toMatchObject({ streamId: 'manual-mode' })
    expect(JSON.parse(events[changed].message.meta)).toMatchObject({ kind: 'operation_mode_change', mode: 'plan' })
  })

  it('refuses queued input during a Claude compaction run', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    let refusal: unknown
    const claudeSessions = { run: vi.fn(async (input: any) => {
      expect(input.queuedInput).toBeUndefined()
      try { orchestrator.submitQueuedMessage('c1', 'claude-compact', { requestId: 'q', content: 'after' }) } catch (error) { refusal = error }
      return input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId, modelName: input.request.modelName,
        content: 'summary', meta: { kind: 'compaction_summary', claude: { sessionId: 's' } } })
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const first: any[] = []
    const base: any = { operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-haiku-5-5', rootPath: testDirectory }
    claudeSessions.run.mockImplementationOnce(async (input: any) => {
      const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId, modelName: input.request.modelName,
        content: 'reply', meta: { claude: { sessionId: 's' } } })
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(message.id, 's', 'uuid-1', testDirectory)
      return message
    })
    await orchestrator.runMessage({ ...base, content: 'hello' }, event => first.push(event))
    const head = first.find(event => event.type === 'complete')
    await orchestrator.runMessage({ ...base, content: '/compact', manualCompaction: true, parentId: head.message.id,
      lineageId: head.lineageId, streamId: 'claude-compact' }, () => {}).catch(() => {})
    expect(String(refusal)).toContain('compacting')
  })

  it('runs Claude Stop once after durable output with the real turn anchor for send, branch, edit and repeat', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const events: any[] = []
    const inputs: any[] = []
    const hooks: any[] = []
    const hookRunner = vi.fn(async (req: any) => {
      if (req.event !== 'Stop') return { matched: false, hookCount: 0 }
      expect(events.at(-1)?.type).toBe('assistant_message_persisted')
      expect(statements.getMessageById.get(req.messageId).content).toBe('final answer')
      hooks.push({ ...req, ...req.resolveLineage() })
      return { matched: true, hookCount: 1, launchedAsyncHookCount: 1 }
    })
    const claudeSessions = { run: vi.fn(async (input: any) => {
      inputs.push(input)
      const intermediate = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        modelName: input.request.modelName, content: 'using tools' })
      const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: intermediate.id,
        modelName: input.request.modelName, content: 'final answer',
        meta: { claude: { sessionId: 'native', messageUuid: `uuid-${inputs.length}` } } })
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(message.id, 'native', `uuid-${inputs.length}`, testDirectory)
      input.emit({ type: 'assistant_message_persisted', message, lineageId: input.lineageId })
      return message
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      decisionBroker: new DecisionBroker(), hookRunner, claudeSessions: claudeSessions as any })
    const base: any = { operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5',
      content: 'hello', rootPath: testDirectory, hooksEnabled: true, localApiBase: 'http://127.0.0.1:3002/api' }
    await orchestrator.runMessage(base, event => events.push(event))
    const first = events.find(event => event.type === 'complete').message
    const userId = inputs[0].parentId
    await orchestrator.runMessage({ ...base, operation: 'branch', messageId: first.id, content: 'fork' }, event => events.push(event))
    await orchestrator.runMessage({ ...base, operation: 'edit-branch', messageId: userId, content: 'edited' }, event => events.push(event))
    await orchestrator.runMessage({ ...base, operation: 'repeat', parentId: userId, content: '' }, event => events.push(event))
    // SessionStart only where a new native session starts: the first send and editing the root prompt.
    expect(hookRunner.mock.calls.map(([req]: any[]) => req.event)).toEqual(['UserPromptSubmit', 'SessionStart', 'Stop',
      'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'SessionStart', 'Stop', 'Stop'])
    expect(inputs.every(input => input.hookSession)).toBe(true)
    hooks.forEach((req, index) => {
      expect(req).toMatchObject({ conversationId: 'c1', cwd: testDirectory, provider: 'claudecode', model: base.modelName,
        operation: ['send', 'branch', 'edit-branch', 'repeat'][index], lastAssistantMessage: 'final answer',
        lookup: { localApiBase: base.localApiBase }, turn: { lastUserMessageId: inputs[index].parentId, lastAssistantMessageId: req.messageId } })
      expect(req.parentId).not.toBe(req.turn.lastUserMessageId)
      expect(req.lineage.ancestorIds).toContain(req.turn.lastUserMessageId)
      expect(req.lineage.ancestorIds.at(-1)).toBe(req.messageId)
      expect(req.streamId).toBe(inputs[index].request.streamId)
    })
    expect(providerRouter.calls).toHaveLength(0)
    expect(events.filter(event => event.type === 'complete')).toHaveLength(4)
  })

  it.each(['disabled', 'no-runner', 'no-broker', 'failed', 'aborted', 'compact', 'hook-failed', 'hook-blocked'])('handles Claude Stop gating and %s without duplicate native execution', async scenario => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const controller = new AbortController()
    const hookRunner = vi.fn(async (req: any) => {
      if (req.event !== 'Stop') return { matched: false, hookCount: 0 }
      if (scenario === 'hook-failed') throw new Error('hook discovery unavailable')
      return { matched: true, hookCount: 1, blocked: scenario === 'hook-blocked' }
    })
    const claudeSessions = { run: vi.fn(async (input: any) => {
      const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        modelName: input.request.modelName, content: 'answer' })
      if (scenario === 'failed') throw new Error('native failure')
      if (scenario === 'aborted') controller.abort()
      return message
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      decisionBroker: scenario === 'no-broker' ? undefined : new DecisionBroker(),
      hookRunner: scenario === 'no-runner' ? undefined : hookRunner, claudeSessions: claudeSessions as any })
    const events: any[] = []
    const run = orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode',
      modelName: 'claude-sonnet-5-5', content: 'hello', rootPath: testDirectory,
      hooksEnabled: scenario !== 'disabled', manualCompaction: scenario === 'compact' }, event => events.push(event), controller.signal)
    if (scenario === 'failed') await expect(run).rejects.toThrow('native failure')
    else await run
    expect(hookRunner.mock.calls.filter(([req]: any[]) => req.event === 'Stop')).toHaveLength(scenario.startsWith('hook-') ? 1 : 0)
    if (scenario === 'compact') expect(hookRunner).not.toHaveBeenCalled()
    expect(claudeSessions.run).toHaveBeenCalledOnce()
    if (scenario.startsWith('hook-')) {
      expect(events.some(event => event.type === 'notice' && event.code === 'hook_failed')).toBe(true)
      expect(events.filter(event => event.type === 'complete')).toHaveLength(1)
    }
  })

  it('expands a /skill and hook context into the Claude prompt and the persisted user message', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    mkdirSync(path.join(testDirectory, '.ygg', 'skills', 'greet-native'), { recursive: true })
    writeFileSync(path.join(testDirectory, '.ygg', 'skills', 'greet-native', 'SKILL.md'),
      '---\nname: greet-native\ndescription: Greets\n---\nSay hello to $ARGUMENTS.\n')
    const hookRunner = vi.fn(async (req: any) => req.event === 'UserPromptSubmit'
      ? { matched: true, hookCount: 1, additionalContext: 'prompt hook context' }
      : { matched: false, hookCount: 0 })
    const claudeSessions = { run: vi.fn(async (input: any) => input.sink.persistAssistantMessage({ conversationId: 'c1',
      parentId: input.parentId, modelName: input.request.modelName, content: 'hi' })),
      // Claude's own lookup: a plugin command is routed, built-ins such as /init are not.
      nativeCommand: vi.fn(async (_cwd: string, content: string) => content.startsWith('/acme:deploy')
        ? { name: 'acme:deploy', args: 'staging', description: 'Deploys the app (plugin)' } : null) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      decisionBroker: new DecisionBroker(), hookRunner, claudeSessions: claudeSessions as any })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5',
      content: '/greet-native world', rootPath: testDirectory, hooksEnabled: true }, () => {})
    // Graviton expanded this skill itself; Claude's lookup is never consulted.
    expect(claudeSessions.nativeCommand).not.toHaveBeenCalled()
    const prompt: string = claudeSessions.run.mock.calls[0][0].request.content
    expect(prompt.startsWith('<system-reminder>')).toBe(true)
    expect(prompt).toContain('Say hello to world.')
    expect(prompt).toContain('prompt hook context')
    expect(prompt.endsWith('\n\n/greet-native world')).toBe(true)
    const user = statements.getMessageById.get(claudeSessions.run.mock.calls[0][0].parentId)
    expect(user.content).toBe('/greet-native world')
    const blocks = JSON.parse(user.content_blocks)
    expect(blocks.map((block: any) => [block.type, block.reason])).toEqual([['context_injection', 'skill'], ['context_injection', 'hook']])

    db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(user.id, 'native', 'u1', testDirectory)
    await orchestrator.runMessage({ operation: 'repeat', conversationId: 'c1', parentId: user.id, provider: 'claudecode',
      modelName: 'claude-sonnet-5-5', content: '', rootPath: testDirectory, hooksEnabled: true }, () => {})
    const repeated: string = claudeSessions.run.mock.calls[1][0].request.content
    expect(repeated).toContain('Say hello to world.')
    expect(repeated.endsWith('\n\n/greet-native world')).toBe(true)

    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n
    const events: any[] = []
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5',
      content: '/init', rootPath: testDirectory, hooksEnabled: true }, event => events.push(event)).catch(() => {})
    expect(events.some(event => event.type === 'error' && /native slash commands/.test(event.error ?? event.message ?? ''))).toBe(true)
    // Retrying the same text cannot succeed, so the refusal names the command and offers no Retry.
    const refusal = events.find(event => event.type === 'error')
    expect(refusal.envelope).toMatchObject({ code: 'bad_request', recoverability: 'user_action' })
    expect(refusal.envelope.userMessage).toContain('/init')
    expect(refusal.envelope.action).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(before)
    expect(claudeSessions.run).toHaveBeenCalledTimes(2)

    // A Claude skill or custom command Graviton cannot expand leads the prompt so Claude expands it.
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5',
      content: '/acme:deploy staging', rootPath: testDirectory, hooksEnabled: true }, () => {})
    const native = claudeSessions.run.mock.calls[2][0]
    expect(native.nativeCommand).toBe(true)
    expect(native.request.content.startsWith('/acme:deploy staging\n\n<system-reminder>')).toBe(true)
    expect(native.request.content).toContain('prompt hook context')
    expect(native.request.content).not.toContain('Deploys the app')
    const nativeUser = statements.getMessageById.get(native.parentId)
    expect(JSON.parse(nativeUser.content_blocks).map((block: any) => [block.reason, block.origin ?? null])).toEqual([['skill', 'claude'], ['hook', null]])

    // A message that starts with a path is prose to Claude Code: no command lookup and no refusal.
    claudeSessions.nativeCommand.mockClear()
    const pathPrompt = '/Users/me/plan.md\n\nport the tools'
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5',
      content: pathPrompt, rootPath: testDirectory, hooksEnabled: true }, () => {})
    expect(claudeSessions.nativeCommand).not.toHaveBeenCalled()
    const prose = claudeSessions.run.mock.calls[3][0]
    expect(prose.nativeCommand).toBeFalsy()
    expect(prose.request.content.endsWith(pathPrompt)).toBe(true)
    expect(statements.getMessageById.get(prose.parentId).content).toBe(pathPrompt)
  })

  it.each([undefined, true, false])('initializes Claude approval from the accepted toolAutoApprove=%s setting', async toolAutoApprove => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const broker = new DecisionBroker()
    const claudeSessions = { run: vi.fn(async (input: any) => {
      expect(broker.isAutoApproveAll(input.request.streamId)).toBe(toolAutoApprove !== false)
      if (toolAutoApprove === false) {
        const pending = broker.requestDecision({ streamId: input.request.streamId, toolCallId: 'native-tool', kind: 'permission' })
        expect(broker.resolve(input.request.streamId, 'native-tool', 'allow_always')).toBe(true)
        await expect(pending).resolves.toBe('allow_always')
      }
      return input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        modelName: input.request.modelName, content: 'native answer' })
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      decisionBroker: broker, claudeSessions: claudeSessions as any })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', provider: 'claudecode',
      modelName: 'claude-sonnet-5-5', content: 'hello', streamId: 'approval-stream', rootPath: testDirectory, toolAutoApprove }, () => {})
    expect(claudeSessions.run).toHaveBeenCalledOnce()
  })

  it('carries Claude Allow all across completed runs and host reconstruction through actual admission, retaining explicit Ask', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    db.exec(OPERATION_RECEIPT_SCHEMA)
    let broker = new DecisionBroker()
    const sessions = new RunSessionRegistry()
    const policies: boolean[] = []
    const answers: any[] = []
    const events: any[] = []
    const claudeSessions = { run: vi.fn(async (input: any) => {
      const streamId = input.request.streamId
      policies.push(broker.isAutoApproveAll(streamId))
      if (policies.length === 1) {
        // An assistant tool row can already exist when the permission is answered.
        input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
          modelName: input.request.modelName, content: 'using tool' })
        const pending = broker.requestDecision({ streamId, toolCallId: 'write', kind: 'permission' })
        expect(broker.resolve(streamId, 'write', 'allow_always')).toBe(true)
        await expect(pending).resolves.toBe('allow_always')
      }
      const message = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        modelName: input.request.modelName, content: 'done', meta: { claude: { sessionId: 'native' } } })
      db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(message.id, 'native', `uuid-${answers.length}`, testDirectory)
      answers.push(message)
      return message
    }) }
    const createAdmission = () => {
      orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, decisionBroker: broker, claudeSessions: claudeSessions as any })
      const receipts = new OperationReceiptRepo(db)
      return new RunAdmissionService({ epoch: 'e', receipts, sessions, orchestrator,
        executionDefaults: () => normalizeHostExecutionPreferences({ toolAutoApprove: false }) })
    }
    try {
      let admission = createAdmission()
      const base: any = { operation: 'send', conversationId: 'c1', provider: 'claudecode', modelName: 'claude-sonnet-5-5', rootPath: testDirectory, content: 'work' }
      admission.admit({ ...base, operationId: 'first', streamId: 'first', toolAutoApprove: false }, 'e')
      await vi.waitFor(() => expect(sessions.get('first')?.isTerminal()).toBe(true))
      expect(sessions.get('first')?.effectiveConfiguration?.toolAutoApprove).toBe(true)
      expect(JSON.parse(messageRepo.get(answers[0].id).meta).toolAutoApprove).toBe(true)
      expect(sessions.get('first')?.attach({ send: frame => events.push(frame.event), end: () => {} })).toMatchObject({ status: 'replayed-terminal' })
      expect(events.some(event => event.type === 'tool_approval_changed')).toBe(true)
      // Recreate all runtime approval state; only persisted ancestry remains.
      broker = new DecisionBroker()
      admission = createAdmission()
      admission.admit({ ...base, operationId: 'second', streamId: 'second', parentId: answers[0].id }, 'e')
      await vi.waitFor(() => expect(sessions.get('second')?.isTerminal()).toBe(true))
      admission.admit({ ...base, operationId: 'third', streamId: 'third', parentId: answers[1].id, toolAutoApprove: false }, 'e')
      await vi.waitFor(() => expect(sessions.get('third')?.isTerminal()).toBe(true))
      const summary = messageRepo.createMessage({ conversationId: 'c1', parentId: answers[0].id, role: 'assistant', content: 'portable',
        meta: { kind: 'compaction_summary', state: 'committed', toolAutoApprove: true } })
      expect(orchestrator.resolveToolApproval({ ...base, operation: 'branch', messageId: summary.id })).toBeUndefined()
      expect(policies).toEqual([false, true, false])
      expect(JSON.parse(messageRepo.get(answers[2].id).meta).toolAutoApprove).toBe(false)
    } finally { sessions.disposeAll() }
  })

  it('starts clean provider branches in both directions without carrying old scaffolding or mutating the source', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    writeFileSync(path.join(testDirectory, 'AGENTS.md'), 'Fresh workspace instructions')
    const oldContext = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user',
      content: 'STALE launch instructions', meta: { kind: 'context_injection', files: [path.join(testDirectory, 'AGENTS.md')] } })
    const original = messageRepo.createMessage({ conversationId: 'c1', parentId: oldContext.id, role: 'user',
      content: 'original prompt', meta: { modelSelection: { provider: 'openaichatgpt', model: 'test' } } })
    const sourceLineage = new LineageRepo({ db, statements }).createRoot({ conversationId: 'c1', rootMessageId: original.id })
    const nativeCalls: any[] = []
    const claudeSessions = { run: vi.fn(async (input: any) => {
      nativeCalls.push(input)
      return input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        content: 'Claude answer', modelName: input.request.modelName, meta: { claude: { sessionId: 'native' } } })
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    vi.spyOn(orchestrator as any, 'loadHostSkills').mockResolvedValue([])
    const base: any = { operation: 'edit-branch', conversationId: 'c1', messageId: original.id, lineageId: sourceLineage.id,
      provider: 'claudecode', modelName: 'claude-sonnet-5-5', content: 'new native prompt', rootPath: testDirectory, autoMemoryEnabled: false }
    // An accepted source run must not reserve a separate fresh edit's provider.
    ;(orchestrator as any).inputRuns.set('source-pending', { terminal: false, request: { ...base, operation: 'send', provider: 'openaichatgpt' }, queue: {} })
    const nativeEvents: any[] = []
    await orchestrator.runMessage(base, event => nativeEvents.push(event))
    const nativeUser = nativeEvents.find(event => event.type === 'user_message_persisted').message
    expect(nativeUser.parent_id).toBeNull()
    expect(nativeEvents.filter(event => event.type === 'user_message_persisted')).toHaveLength(1)
    expect(nativeCalls[0]).toMatchObject({ sourceMessageId: null, fork: true, request: { content: 'new native prompt' } })
    expect(providerRouter.calls).toHaveLength(0)
    expect(nativeUser.lineage_id).not.toBe(sourceLineage.id)
    expect(statements.getLineageById.get(sourceLineage.id)).toMatchObject({ head_message_id: original.id })
    expect(statements.getMessageById.get(original.id)).toMatchObject({ parent_id: oldContext.id, content: 'original prompt' })
    const nativeSessionBefore = db.prepare('SELECT * FROM claude_branch_sessions WHERE lineage_id=?').get(nativeUser.lineage_id)
    ;(orchestrator as any).inputRuns.delete('source-pending')
    ;(orchestrator as any).inputRuns.set('fresh-pending', { terminal: false, request: base, queue: {} })
    expect(() => orchestrator.validateExecutionSelection({ ...base, operation: 'send', parentId: original.id,
      provider: 'openaichatgpt', modelName: 'test' })).not.toThrow()
    ;(orchestrator as any).inputRuns.delete('fresh-pending')
    const normalEvents: any[] = []
    await orchestrator.runMessage({ ...base, messageId: nativeUser.id, lineageId: nativeUser.lineage_id,
      provider: 'openaichatgpt', modelName: 'test', content: 'back to normal' }, event => normalEvents.push(event))
    const normalUser = normalEvents.filter(event => event.type === 'user_message_persisted').map(event => event.message).find(row => row.content === 'back to normal')
    expect(normalUser.lineage_id).not.toBe(nativeUser.lineage_id)
    const newContext = statements.getMessageById.get(normalUser.parent_id)
    expect(JSON.parse(newContext.meta).kind).toBe('context_injection')
    expect(newContext.parent_id).toBeNull()
    expect(newContext.content).toContain('Fresh workspace instructions')
    expect(providerRouter.calls).toHaveLength(1)
    expect(JSON.stringify(providerRouter.calls[0])).not.toContain('STALE launch instructions')
    expect(JSON.stringify(providerRouter.calls[0])).not.toContain('Claude answer')
    expect(db.prepare('SELECT * FROM claude_branch_sessions WHERE lineage_id=?').get(nativeUser.lineage_id)).toEqual(nativeSessionBefore)
    expect(statements.getMessageById.get(nativeUser.id).parent_id).toBeNull()
    // Returning to the original first prompt can choose a different Claude model/session.
    await orchestrator.runMessage({ ...base, messageId: normalUser.id, lineageId: normalUser.lineage_id,
      modelName: 'claude-opus-5-5', content: 'native again' }, () => {})
    expect(nativeCalls[1].sourceMessageId).toBeNull()
    expect(nativeCalls[1].lineageId).not.toBe(nativeCalls[0].lineageId)
    expect(nativeCalls[1].request.modelName).toBe('claude-opus-5-5')
  })

  it('routes manual Claude compaction natively and rejects unmarked native slash commands before persistence', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    let captured: any
    const claudeSessions = { run: vi.fn(async (input: any) => {
      captured = input
      const row = input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId, modelName: input.request.modelName,
        content: 'native compact state', statisticsKind: 'compaction_summary', meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 'source-native' } } })
      input.emit({ type: 'context_compaction', status: 'completed', summaryMessage: row, parentMessageId: row.id,
        turn: 0, reportedTokens: 0, projectedTokens: 0, effectiveTokens: 0, contextLength: 0, thresholdPercent: 0 })
      return row
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    const source = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'assistant', content: 'native response',
      meta: { modelSelection: { provider: 'claudecode', model: 'claude-sonnet-5-5' } } })
    const lineage = new LineageRepo({ db, statements }).createRoot({ conversationId: 'c1', rootMessageId: source.id })
    db.prepare('INSERT INTO claude_branch_sessions VALUES (?, ?, ?, ?, ?, ?)').run(lineage.id, 'c1', 'claude-sonnet-5-5', testDirectory, 'source-native', 'ready')
    db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(source.id, 'source-native', 'a', testDirectory)
    const base: any = { operation: 'send', conversationId: 'c1', parentId: source.id, lineageId: lineage.id,
      provider: 'claudecode', modelName: 'claude-sonnet-5-5', content: '/compact', rootPath: testDirectory }
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n
    expect(() => orchestrator.validateExecutionSelection({ ...base, content: '/compact focus' })).toThrow('slash commands')
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(before)
    const events: any[] = []
    await orchestrator.runMessage({ ...base, manualCompaction: true }, event => events.push(event))
    expect(captured.request).toMatchObject({ manualCompaction: true, content: '/compact', provider: 'claudecode' })
    expect(captured.sourceMessageId).toBe(source.id)
    expect(providerRouter.calls).toHaveLength(0)
    const summary = events.find(event => event.type === 'complete').message
    expect(JSON.parse(summary.meta)).toMatchObject({ kind: 'compaction_summary', state: 'committed' })
    expect(() => orchestrator.validateExecutionSelection({ ...base, parentId: summary.id, content: 'followup' })).not.toThrow()
  })

  it('starts a fresh Claude session from a summary copied from another chat, and refuses other copied rows', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const claudeSessions = { run: vi.fn(async (input: any) => input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
      modelName: input.request.modelName, content: 'fresh answer', meta: { claude: { sessionId: 'fresh-native' } } })) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    vi.spyOn(orchestrator as any, 'loadHostSkills').mockResolvedValue([])
    // What New Chat From Here writes: Claude metadata without checkpoints, no lineage, no native session.
    const claude = { provider: 'claudecode', model: 'claude-opus-5-5' }
    const answer = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'assistant', content: 'OLD RAW ANSWER',
      meta: { modelSelection: claude, claude: { sessionId: 'source-native', messageUuid: 'u' }, transfer: { sourceMessageId: 'a', sourceConversationId: 'src' } } })
    const summary = messageRepo.createMessage({ conversationId: 'c1', parentId: answer.id, role: 'assistant', content: 'Portable task state',
      meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 'source-native' }, transfer: { sourceMessageId: 's', sourceConversationId: 'src' } } })
    const base = { operation: 'send' as const, conversationId: 'c1', provider: 'claudecode', modelName: 'claude-opus-5-5', rootPath: testDirectory }

    expect(() => orchestrator.validateExecutionSelection({ ...base, parentId: summary.id, content: 'continue here' })).not.toThrow()
    // An earlier run on this lineage was cut back to the summary but left its session row behind.
    const lineage = new LineageRepo({ db, statements }).createRoot({ conversationId: 'c1', rootMessageId: answer.id })
    new LineageRepo({ db, statements }).appendMessage(lineage.id, summary.id)
    db.prepare('INSERT INTO claude_branch_sessions VALUES (?, ?, ?, ?, ?, ?)').run(lineage.id, 'c1', 'claude-opus-5-5', testDirectory, 'stale-native', 'ready')
    const events: any[] = []
    await orchestrator.runMessage({ ...base, parentId: summary.id, lineageId: lineage.id, content: 'continue here' }, event => events.push(event))
    expect(events.find(event => event.type === 'error')).toBeUndefined()
    const call = claudeSessions.run.mock.calls[0][0]
    expect(call.sourceMessageId).toBeNull()
    expect(call.lineageId).not.toBe(lineage.id)
    expect(call.request.content).toContain('Portable task state')
    expect(call.request.content).toContain('continue here')
    expect(call.request.content).not.toContain('OLD RAW ANSWER')
    const user = events.find(event => event.type === 'user_message_persisted').message
    expect(user.parent_id).toBe(summary.id)
    expect(JSON.parse(user.meta).executionHandoff.summaryMessageId).toBe(summary.id)

    // Context copied after the summary is skipped: the new turn hangs off the summary itself.
    const trailer = messageRepo.createMessage({ conversationId: 'c1', parentId: summary.id, role: 'user', content: 'restored context',
      meta: { kind: 'context_injection', transfer: { sourceMessageId: 'ctx' } } })
    const trailerEvents: any[] = []
    await orchestrator.runMessage({ ...base, parentId: trailer.id, content: 'from the trailer' }, event => trailerEvents.push(event))
    expect(trailerEvents.find(event => event.type === 'error')).toBeUndefined()
    expect(trailerEvents.find(event => event.type === 'user_message_persisted' && event.message.content === 'from the trailer').message.parent_id).toBe(summary.id)
    expect(claudeSessions.run.mock.calls[1][0].sourceMessageId).toBeNull()

    // A copied response has no checkpoint: say so instead of claiming the turn never finished.
    expect(() => orchestrator.validateExecutionSelection({ ...base, operation: 'branch', messageId: answer.id, parentId: null, content: 'from the old answer' }))
      .toThrow(CLAUDE_TRANSFERRED_SOURCE_MESSAGE)
  })

  it('hands off committed summaries in both directions and preserves source sessions and history', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    const calls: any[] = []
    const claudeSessions = { run: vi.fn(async (input: any) => {
      calls.push(input)
      return input.sink.persistAssistantMessage({ conversationId: 'c1', parentId: input.parentId,
        modelName: input.request.modelName, content: 'native answer', meta: { claude: { sessionId: 'new-native' } } })
    }) }
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any, claudeSessions: claudeSessions as any })
    vi.spyOn(orchestrator as any, 'loadHostSkills').mockResolvedValue([])
    const source = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'SECRET OLD RAW HISTORY',
      meta: { modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } } })
    const summary = messageRepo.createMessage({ conversationId: 'c1', parentId: source.id, role: 'assistant', content: 'Portable task state',
      meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 'source-native' }, modelSelection: { provider: 'claudecode', model: 'claude-opus-5-5' } } })
    const lineage = new LineageRepo({ db, statements }).createRoot({ conversationId: 'c1', rootMessageId: source.id })
    new LineageRepo({ db, statements }).appendMessage(lineage.id, summary.id)
    db.prepare('INSERT INTO claude_branch_sessions VALUES (?, ?, ?, ?, ?, ?)').run(lineage.id, 'c1', 'claude-opus-5-5', testDirectory, 'source-native', 'ready')
    const originalSession = db.prepare('SELECT * FROM claude_branch_sessions WHERE lineage_id=?').get(lineage.id)
    const events: any[] = []
    await orchestrator.runMessage({ operation: 'branch', conversationId: 'c1', messageId: summary.id, lineageId: lineage.id,
      provider: 'openaichatgpt', modelName: 'test', content: 'continue outside Claude', rootPath: testDirectory }, event => events.push(event))
    expect(JSON.stringify(providerRouter.calls)).toContain('Portable task state')
    expect(JSON.stringify(providerRouter.calls)).not.toContain('SECRET OLD RAW HISTORY')
    const handoff = events.find(event => event.type === 'user_message_persisted' && event.message.content === 'continue outside Claude').message
    expect(JSON.parse(handoff.meta).executionHandoff.summaryMessageId).toBe(summary.id)
    expect(handoff.lineage_id).not.toBe(lineage.id)
    // Subsequent sends resolve only the new execution's identity, not the old Claude ancestors.
    const final = events.find(event => event.type === 'complete').message
    expect(() => orchestrator.validateExecutionSelection({ operation: 'send', conversationId: 'c1', parentId: final.id,
      lineageId: handoff.lineage_id, provider: 'openaichatgpt', modelName: 'test', content: 'follow up' })).not.toThrow()
    const normalSummary = messageRepo.createMessage({ conversationId: 'c1', parentId: final.id, role: 'assistant', content: 'Second portable state',
      meta: { kind: 'compaction_summary', state: 'committed' } })
    new LineageRepo({ db, statements }).appendMessage(handoff.lineage_id, normalSummary.id)
    await orchestrator.runMessage({ operation: 'branch', conversationId: 'c1', messageId: normalSummary.id, lineageId: handoff.lineage_id,
      provider: 'claudecode', modelName: 'claude-sonnet-5-5', content: 'back to Claude', rootPath: testDirectory }, () => {})
    expect(calls[0].sourceMessageId).toBeNull()
    expect(calls[0].request.content).toContain('Second portable state')
    expect(calls[0].request.content).toContain('back to Claude')
    expect(calls[0].request.content).not.toContain('SECRET OLD RAW HISTORY')
    expect(calls[0].lineageId).not.toBe(lineage.id)
    const redoEvents: any[] = []
    await orchestrator.runMessage({ operation: 'edit-branch', conversationId: 'c1', messageId: handoff.id, lineageId: handoff.lineage_id,
      provider: 'openaichatgpt', modelName: 'test', content: 'edited handoff', rootPath: testDirectory }, event => redoEvents.push(event))
    const redo = redoEvents.find(event => event.type === 'user_message_persisted' && event.message.content === 'edited handoff').message
    expect(JSON.parse(redo.meta).executionHandoff.summaryMessageId).toBe(summary.id)
    expect(JSON.stringify(providerRouter.calls.at(-1))).not.toContain('SECRET OLD RAW HISTORY')
    const nativeUser = statements.getMessageById.get(calls[0].parentId)
    await orchestrator.runMessage({ operation: 'repeat', conversationId: 'c1', parentId: nativeUser.id, lineageId: calls[0].lineageId,
      provider: 'claudecode', modelName: 'claude-sonnet-5-5', content: '', rootPath: testDirectory }, () => {})
    expect(calls[1].sourceMessageId).toBeNull()
    expect(calls[1].request.content).toContain('Second portable state')
    expect(calls[1].request.content).toContain('back to Claude')
    expect(calls[1].lineageId).not.toBe(calls[0].lineageId)
    expect(db.prepare('SELECT * FROM claude_branch_sessions WHERE lineage_id=?').get(lineage.id)).toEqual(originalSession)
    expect(statements.getLineageById.get(lineage.id).head_message_id).toBe(summary.id)
    // An ordinary send at the source summary is not a handoff.
    expect(() => orchestrator.validateExecutionSelection({ operation: 'send', conversationId: 'c1', parentId: summary.id,
      lineageId: lineage.id, provider: 'openaichatgpt', modelName: 'test', content: 'no implicit switch' })).toThrow('fixed provider')
  })

  it('refuses cross-provider mid-history edits, hidden tool/summary ancestors and ordinary continuations before persistence', async () => {
    db.exec(CLAUDE_SESSION_SCHEMA)
    for (const ancestor of [
      { role: 'assistant', content: '', meta: {} },
      { role: 'system', content: 'summary', meta: { kind: 'compaction_summary', state: 'committed' } },
      { role: 'user', content: 'earlier user', meta: {} },
    ]) {
      const prior = messageRepo.createMessage({ conversationId: 'c1', parentId: null, ...ancestor })
      const prompt = messageRepo.createMessage({ conversationId: 'c1', parentId: prior.id, role: 'user', content: 'not a fresh root',
        meta: { modelSelection: { provider: 'openaichatgpt', model: 'test' } } })
      const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n
      await expect(orchestrator.runMessage({ operation: 'edit-branch', conversationId: 'c1', messageId: prompt.id,
        provider: 'claudecode', modelName: 'claude-sonnet-5-5', content: 'no import', rootPath: testDirectory }, () => {})).rejects.toThrow('existing provider history')
      expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(before)
    }
    const native = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'native root',
      meta: { modelSelection: { provider: 'claudecode', model: 'claude-sonnet-5-5' } } })
    const later = messageRepo.createMessage({ conversationId: 'c1', parentId: native.id, role: 'user', content: 'later prompt' })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n
    for (const request of [
      { operation: 'edit-branch', messageId: later.id },
      { operation: 'branch', messageId: native.id },
      { operation: 'send', parentId: native.id },
    ]) {
      await expect(orchestrator.runMessage({ ...request, conversationId: 'c1', provider: 'openaichatgpt', modelName: 'test', content: 'no switch' } as any, () => {})).rejects.toThrow('fixed provider')
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(before)
  })

  it.each([true, false])('persists Fast mode %s on user and assistant rows', async fastMode => {
    const events: any[] = []
    await orchestrator.runMessage({
      operation: 'send', conversationId: 'c1', content: 'hello', provider: 'openaichatgpt',
      modelName: 'test', streamId: 'fast-run', serviceTier: fastMode ? 'priority' : undefined,
    }, event => events.push(event))
    const user = events.find(event => event.type === 'user_message_persisted').message
    const assistant = events.find(event => event.type === 'complete').message
    for (const row of [user, assistant]) {
      const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta
      expect(meta.fastMode).toBe(fastMode)
      expect(meta.modelSelection).toEqual({ provider: 'openaichatgpt', model: 'test' })
    }
  })

  it('accepts FIFO follow-ups during manual compaction and delivers only after summary commit', async () => {
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      toolExecutor: async () => 'Read result' })
    const events: any[] = []
    let call = 0
    vi.spyOn(providerRouter, 'generate').mockImplementation(async (_provider, input) => {
      call++
      if (call <= 2) {
        const requestId = `q${call}`
        const accepted = orchestrator.submitQueuedMessage('c1', 'manual', { requestId, content: `Follow-up ${call}` })
        expect(accepted.snapshot?.items.find(item => item.requestId === requestId)?.status).toBe('queued')
        expect(events.some(event => event.type === 'queued_user_message_persisted')).toBe(false)
        expect(input.history.some((row: any) => row.content?.startsWith('Follow-up'))).toBe(false)
        if (call === 1) return { content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: {} }] }
        return { content: 'Committed summary' }
      }
      expect(input.history[0].meta).toContain('compaction_summary')
      expect(input.history.filter((row: any) => row.content?.startsWith('Follow-up')).map((row: any) => row.content))
        .toEqual(['Follow-up 1', 'Follow-up 2'])
      return { content: 'Follow-ups answered' }
    })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', content: '/compact',
      provider: 'openaichatgpt', modelName: 'test', streamId: 'manual', manualCompaction: true }, event => events.push(event))
    expect(call).toBe(3)
    const completedIndex = events.findIndex(event => event.type === 'context_compaction' && event.status === 'completed')
    const queued = events.filter(event => event.type === 'queued_user_message_persisted')
    expect(queued).toHaveLength(2)
    for (const event of queued) {
      expect(events.indexOf(event)).toBeGreaterThan(completedIndex)
      expect(JSON.parse(event.message.meta || '{}').kind).not.toBe('compaction_instruction')
    }
    expect(queued[1].message.parent_id).toBe(queued[0].message.id)
    expect(events.find(event => event.type === 'complete').message.content).toBe('Follow-ups answered')
    expect(orchestrator.getMessageQueue('c1', 'manual').items.map(item => item.status)).toEqual(['delivered', 'delivered'])

    const successor = orchestrator.submitQueuedMessage('c1', 'manual', { requestId: 'late', content: 'One more follow-up' })
    expect(successor.restart).toMatchObject({ content: 'One more follow-up', manualCompaction: false })
    const nextEvents: any[] = []
    providerRouter.generate = async () => ({ content: 'Late follow-up answered' })
    await orchestrator.runMessage(successor.restart!, event => nextEvents.push(event))
    expect(nextEvents.some(event => event.type === 'context_compaction')).toBe(false)
    expect(nextEvents.find(event => event.type === 'user_message_persisted').message.content).toBe('One more follow-up')
  })

  it('requires acknowledgement of the active access policy before accepting queued input', async () => {
    const events: any[] = []
    let call = 0
    vi.spyOn(providerRouter, 'generate').mockImplementation(async () => {
      expect((orchestrator as any).inputRuns.get('active').request.fullAccess).toBe(false)
      if (++call === 1) {
        expect(() => orchestrator.submitQueuedMessage('c1', 'active', { requestId: 'elevated', content: 'keep draft',
          fullAccess: true, fullAccessNotificationId: 'toggle-queued' })).toThrow('access policy')
        orchestrator.submitQueuedMessage('c1', 'active', { requestId: 'acknowledged', content: 'follow up', fullAccess: false })
      }
      return { content: 'answer' }
    })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', content: 'original',
      provider: 'openaichatgpt', modelName: 'test', streamId: 'active', fullAccess: false }, event => events.push(event))
    expect(call).toBe(2)
    expect(events.filter(event => event.type === 'queued_user_message_persisted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user_message_persisted' && JSON.parse(event.message.meta || '{}').kind === 'full_access_change')).toHaveLength(0)
  })

  it('persists request throughput before completion and isolates consecutive runs', async () => {
    const runs = new Map<string, any>()
    statements.getStreamingRunById = { get: (id: string) => runs.get(id) }
    statements.upsertStreamingRun = { run: (...values: any[]) => {
      runs.set(values[0], { status: values[7], metadata_json: values[18], started_at: values[19] })
    } }
    statements.updateStreamingRun = { run: (...values: any[]) => {
      Object.assign(runs.get(values[10]), { status: values[0], metadata_json: values[6] })
    } }
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const generate = vi.spyOn(providerRouter, 'generate').mockImplementation(async () => {
      now += 2000
      return { content: 'done', raw: { usage: { output_tokens: 100 } } }
    })
    try {
      for (const streamId of ['throughput-1', 'throughput-2']) {
        let completed = false
        await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', content: 'hello',
          provider: 'openaichatgpt', modelName: 'test', streamId }, event => {
          if (event.type !== 'complete') return
          completed = true
          const row = runs.get(streamId)
          expect(row.status).toBe('completed')
          const metadata = JSON.parse(row.metadata_json)
          expect(metadata.runResponseCount).toBe(1)
          expect(metadata.runStatistics.version).toBe(1)
          expect(metadata.modelThroughput).toMatchObject({ outputTokens: 100, requestDurationMs: 2000,
            requests: 1, measuredRequests: 1, coverage: 'complete' })
        })
        expect(completed).toBe(true)
      }
    } finally {
      clock.mockRestore()
      generate.mockRestore()
    }
  })

  it.each(['send', 'branch', 'edit-branch'] as const)('persists the deferred Full access notice after new input for %s', async operation => {
    const original = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'original' })
    const events: any[] = []
    await orchestrator.runMessage({
      operation, conversationId: 'c1', parentId: original.id, messageId: original.id,
      content: 'new input', provider: 'openaichatgpt', modelName: 'test',
      fullAccess: true, fullAccessNotificationId: 'toggle-1',
    }, event => events.push(event))
    const rows = statements.getMessagesByConversationId.all('c1') as any[]
    const notice = rows.find(row => JSON.parse(row.meta || '{}').kind === 'full_access_change')
    const user = rows.find(row => row.content === 'new input')
    expect(notice?.role).toBe('user')
    expect(user.parent_id).toBe(operation === 'edit-branch' ? null : original.id)
    expect(notice.parent_id).toBe(user.id)
    expect(notice.lineage_id).toBe(user.lineage_id)
    const lineages = new LineageRepo({ db, statements })
    const countBefore = lineages.list('c1').length
    lineages.reconcileLegacyConversation('c1')
    expect(lineages.list('c1')).toHaveLength(countBefore)
    expect(notice.content).toContain('<system-reminder>')
    expect(notice.content).toContain('already-running run')
    const persisted = events.filter(event => event.type === 'user_message_persisted')
    expect(persisted.map(event => event.message.id)).toEqual([user.id, notice.id])
    expect(events.find(event => event.type === 'started').parentId).toBe(user.id)
    const modelHistory = providerRouter.calls[0].history
    expect(modelHistory.findIndex((row: any) => row.id === notice.id)).toBeGreaterThan(modelHistory.findIndex((row: any) => row.id === user.id))
    expect(rows.find(row => JSON.parse(row.meta || '{}').kind === 'operation_mode_change')?.parent_id).toBe(notice.id)
    expect(JSON.stringify(providerRouter.calls)).toContain('Full access enabled for this new run')
    expect(events.at(-1).type).toBe('complete')
  })

  it('deduplicates a committed toggle when its first SSE acknowledgement was lost', async () => {
    const request = { operation: 'send' as const, conversationId: 'c1', parentId: null,
      content: 'first', provider: 'openaichatgpt', modelName: 'test',
      fullAccess: true, fullAccessNotificationId: 'toggle-retry' }
    await expect(orchestrator.runMessage(request, event => {
      if (event.type === 'started') throw new Error('disconnected after commit')
    })).rejects.toThrow('disconnected after commit')
    const notice = messageRepo.findFullAccessNotification('c1', 'toggle-retry')
    expect(notice).toBeTruthy()
    const events: any[] = []
    await orchestrator.runMessage({ ...request, content: 'second' }, event => events.push(event))
    const notices = (statements.getMessagesByConversationId.all('c1') as any[])
      .filter(row => JSON.parse(row.meta || '{}').kind === 'full_access_change')
    expect(notices).toHaveLength(1)
    expect(events.filter(event => event.type === 'user_message_persisted').at(-1).message.id).toBe(notice.id)
    expect(messageRepo.findFullAccessNotification('other-conversation', 'toggle-retry')).toBeNull()
  })

  it.each([
    { fullAccess: false, fullAccessNotificationId: 'toggle-1' },
    { fullAccess: true },
  ])('does not announce without an enabled pending human toggle: %j', async access => {
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', parentId: null,
      content: 'input', provider: 'openaichatgpt', modelName: 'test', ...access }, () => {})
    const rows = statements.getMessagesByConversationId.all('c1') as any[]
    expect(rows.some(row => JSON.parse(row.meta || '{}').kind === 'full_access_change')).toBe(false)
  })

})

describeIfSqlite('ChatOrchestrator continuation semantics', () => {
  let db: Database.Database
  let statements: any
  let messageRepo: MessageRepo
  let providerRouter: FakeProviderRouter
  let orchestrator: ChatOrchestrator
  let testDirectory: string

  beforeEach(() => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    testDirectory = mkdtempSync(path.join(os.tmpdir(), 'chat-image-lifecycle-'))
    mkdirSync(path.join(testDirectory, 'user_images'))
    db = new BetterSqlite3Ctor(path.join(testDirectory, 'chat.db'))
    createSchema(db)
    statements = createStatements(db)

    const now = new Date().toISOString()
    statements.upsertConversation.run('c1', null, 'u1', 'Conversation', 'gpt-5.1-codex-mini', null, null, null, null, 'local', now, now)

    messageRepo = new MessageRepo({ db, statements })
    providerRouter = new FakeProviderRouter()
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
    if (testDirectory) rmSync(testDirectory, { recursive: true, force: true })
  })

  it('send creates user then assistant', async () => {
    const events: any[] = []
    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      event => events.push(event)
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const user = messages.find(m => m.role === 'user')
    const assistant = messages.find(m => m.role === 'assistant')

    expect(user).toBeTruthy()
    expect(assistant).toBeTruthy()
    const modeRow = messages.find(m => m.id === assistant.parent_id)
    expect(JSON.parse(modeRow.meta).kind).toBe('operation_mode_change')
    expect(modeRow.parent_id).toBe(user.id)
    expect(events.some(evt => evt.type === 'user_message_persisted')).toBe(true)
    expect(events[events.length - 1].type).toBe('complete')
  })

  it('persists automated watcher input on the live safe tail and in a completed-run successor', async () => {
    const events: any[] = []
    let release: (() => void) | undefined
    let lineageId = ''
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', streamId: 'watch-origin',
      content: 'benchmark task', provider: 'openaichatgpt', modelName: 'test' }, event => {
      events.push(event)
      if (event.type === 'started') lineageId = event.lineageId!
      if (event.type === 'assistant_message_persisted' && !release) {
        release = orchestrator.retainWatch({ conversationId: 'c1', lineageId, streamId: 'watch-origin', messageId: event.message.id })
        orchestrator.submitWatchMessage('c1', lineageId, 'watch-origin', {
          requestId: 'watcher:live', content: 'Watcher completion: live',
          watcherCompletion: { handle: 'live', originMessageId: event.message.id },
        })
      }
    })
    const queued = events.find(event => event.type === 'queued_user_message_persisted')
    expect(queued.message.role).toBe('user')
    expect(JSON.parse(statements.getMessageById.get(queued.message.id).meta)).toMatchObject({ kind: 'watcher_completion', handle: 'live' })
    expect(providerRouter.calls).toHaveLength(2)
    const result = orchestrator.submitWatchMessage('c1', lineageId, 'watch-origin', {
      requestId: 'watcher:idle', content: 'Watcher completion: idle',
      watcherCompletion: { handle: 'idle', originMessageId: queued.message.id },
    })
    expect(result.restart?.lineageId).toBe(lineageId)
    const successorEvents: any[] = []
    await orchestrator.runMessage(result.restart!, event => successorEvents.push(event))
    const nextUser = successorEvents.find(event => event.type === 'user_message_persisted').message
    expect(nextUser.parent_id).toBe(result.restart!.parentId)
    expect(JSON.parse(statements.getMessageById.get(nextUser.id).meta)).toMatchObject({ kind: 'watcher_completion', handle: 'idle' })
    expect(successorEvents.find(event => event.type === 'started').lineageId).toBe(lineageId)
    release?.()
  })

  it('links prepared image attachments before emitting the persisted user message', async () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO message_attachments (id, file_path, mime_type, sha256, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('att-1', path.join(testDirectory, 'user_images/image.png'), 'image/png', createHash('sha256').update('a').digest('hex'), now)
    writeFileSync(path.join(testDirectory, 'user_images/image.png'), 'a')

    const events: any[] = []
    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'describe this image',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        attachmentsBase64: [
          {
            dataUrl: 'data:image/png;base64,YQ==',
            attachmentId: 'att-1',
            filePath: '/tmp/image.png',
          },
        ],
      },
      event => events.push(event)
    )

    const persisted = events.find(event => event.type === 'user_message_persisted')
    expect(persisted?.message).toMatchObject({
      attachments_count: 1,
      has_attachments: true,
      attachments: [expect.objectContaining({ id: 'att-1' })],
    })
    expect(statements.getAttachmentsByMessageId.all(persisted.message.id)).toEqual([
      expect.objectContaining({ id: 'att-1' }),
    ])
  })

  it.each(['send', 'branch', 'edit-branch'] as const)('retains %s images through tool continuation, reload, repeat, and sibling isolation', async operation => {
    const image = Buffer.from('durable-image')
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`
    const filename = path.join(testDirectory, 'user_images/image.png')
    writeFileSync(filename, image)
    db.prepare('INSERT INTO message_attachments (id, file_path, mime_type, sha256, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('image-a', filename, 'image/png', createHash('sha256').update(image).digest('hex'), new Date().toISOString())
    const source = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'source' })
    providerRouter.enqueue({ content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: {} }] })
    providerRouter.enqueue({ content: 'image understood' })
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any,
      toolExecutor: async () => ({ content: 'done' }) })
    const events: any[] = []
    await orchestrator.runMessage({ operation, conversationId: 'c1', content: 'inspect',
      messageId: operation === 'send' ? undefined : source.id,
      parentId: operation === 'send' ? source.id : undefined,
      provider: 'openaichatgpt', modelName: 'test', autoCompactionEnabled: false,
      attachmentsBase64: [{ attachmentId: 'image-a', dataUrl }],
    }, event => events.push(event))
    const user = events.find(event => event.type === 'user_message_persisted').message
    expect(providerRouter.calls).toHaveLength(2)
    for (const call of providerRouter.calls) {
      expect(call.history.find((row: any) => row.id === user.id).attachments).toEqual([{ dataUrl }])
      expect(call.turnContext.attachmentsBase64).toBeNull()
    }
    expect(JSON.stringify(events)).not.toContain(dataUrl)
    const last = events.find(event => event.type === 'complete').message
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', parentId: last.id,
      content: 'look again', provider: 'openaichatgpt', modelName: 'test' }, () => {})
    expect(providerRouter.calls.at(-1).history.find((row: any) => row.id === user.id).artifacts).toEqual([dataUrl])
    await orchestrator.runMessage({ operation: 'repeat', conversationId: 'c1', messageId: user.id,
      provider: 'openaichatgpt', modelName: 'test' }, () => {})
    expect(providerRouter.calls.at(-1).history.find((row: any) => row.id === user.id).artifacts).toEqual([dataUrl])
    await orchestrator.runMessage({ operation: 'branch', conversationId: 'c1', messageId: source.id,
      content: 'unrelated sibling', provider: 'openaichatgpt', modelName: 'test' }, () => {})
    expect(providerRouter.calls.at(-1).history.some((row: any) => row.artifacts?.length)).toBe(false)
  })

  it('hydrates queued ID-only images before acceptance and retains them in a later request', async () => {
    const image = Buffer.from('queued-image')
    const filename = path.join(testDirectory, 'user_images/queued.png')
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`
    writeFileSync(filename, image)
    db.prepare('INSERT INTO message_attachments (id, file_path, mime_type, sha256, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('queued-image', filename, 'image/png', createHash('sha256').update(image).digest('hex'), new Date().toISOString())
    const events: any[] = []
    let queued = false
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', streamId: 'queued-images',
      content: 'start', provider: 'openaichatgpt', modelName: 'test' }, event => {
      events.push(event)
      if (event.type === 'assistant_message_persisted' && !queued) {
        queued = true
        orchestrator.submitQueuedMessage('c1', 'queued-images', { requestId: 'image-q', content: 'inspect queued',
          attachmentsBase64: [{ attachmentId: 'queued-image' }] })
      }
    })
    const row = events.find(event => event.type === 'queued_user_message_persisted').message
    expect(row.attachments).toEqual([expect.objectContaining({ id: 'queued-image' })])
    expect(providerRouter.calls.at(-1).history.find((item: any) => item.id === row.id).artifacts).toEqual([dataUrl])
    const last = events.find(event => event.type === 'complete').message
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
    await orchestrator.runMessage({ operation: 'send', conversationId: 'c1', parentId: last.id,
      content: 'again', provider: 'openaichatgpt', modelName: 'test' }, () => {})
    expect(providerRouter.calls.at(-1).history.find((item: any) => item.id === row.id).artifacts).toEqual([dataUrl])
  })

  it('rejects unprepared images before acknowledging or persisting the user row', async () => {
    const events: any[] = []
    await expect(orchestrator.runMessage({ operation: 'send', conversationId: 'c1', content: 'inspect',
      provider: 'openaichatgpt', modelName: 'test', attachmentsBase64: [{ dataUrl: 'data:image/png;base64,YQ==' }],
    }, event => events.push(event))).rejects.toThrow('must be prepared')
    expect(events.some(event => event.type === 'user_message_persisted')).toBe(false)
    expect(providerRouter.calls).toHaveLength(0)
  })

  it('replays only the latest compaction summary and subsequent branch messages', async () => {
    const rootUser = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'old context that must not be replayed',
      modelName: 'gpt-5.1-codex-mini',
    })
    const oldAssistant = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: rootUser.id,
      role: 'assistant',
      content: 'old assistant context that must not be replayed',
      modelName: 'gpt-5.1-codex-mini',
    })
    const summary = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: oldAssistant.id,
      role: 'system',
      content: 'Following is summary of the session, you have to resume the work.\n\nCompacted context.',
      modelName: 'gpt-5.1-codex-mini',
      note: '__auto_compaction_summary__',
    })

    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: summary.id,
        content: 'continue from the summary',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const replay = providerRouter.calls[0].history
    expect(replay[0].id).toBe(summary.id)
    expect(replay.some((message: any) => message.content === 'continue from the summary')).toBe(true)
    expect(JSON.parse(replay.at(-1).meta).kind).toBe('operation_mode_change')
    expect(providerRouter.calls[0].history[0].note).toBe('__auto_compaction_summary__')
  })

  it('turns post-retry OpenAI provider errors into a persisted assistant response', async () => {
    // Main chat retries transient errors twice. Keep every attempt failing;
    // otherwise this fixture's fallback succeeds on the first retry.
    for (let attempt = 0; attempt < 3; attempt++) providerRouter.enqueue(
      new Error(
        'ChatGPT backend request failed (429): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":1782168563}}'
      )
    )

    const events: any[] = []
    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.4-mini',
      },
      event => events.push(event)
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const user = messages.find((msg: any) => msg.role === 'user')
    const assistants = messages.filter((msg: any) => msg.role === 'assistant')
    // The row carrying the classified failure — identified by its ErrorBlock, not by
    // position, so this holds whether or not the loop also persisted a partial/prose row.
    const errorRow = assistants.find((msg: any) => String(msg.content_blocks ?? '').includes('"type":"error"'))

    expect(user).toBeTruthy()
    expect(errorRow).toBeTruthy()
    // R1(c): the error row hangs off the D1 partial when the loop wrote one, and off the
    // user turn when it did not. Either way it is a descendant of this turn.
    const partialIds = assistants.filter((msg: any) => msg.id !== errorRow.id).map((msg: any) => msg.id)
    const modeIds = messages.filter((msg: any) => JSON.parse(msg.meta || '{}').kind === 'operation_mode_change').map((msg: any) => msg.id)
    expect([user.id, ...modeIds, ...partialIds]).toContain(errorRow.parent_id)
    expect(events.some(evt => evt.type === 'assistant_message_persisted' && evt.message.id === errorRow.id)).toBe(true)
    expect(events.some(evt => evt.type === 'error')).toBe(false)
    // CHANGED DELIBERATELY (was `message: { id: <prose row> }`). `complete.message` is
    // what sseProjection rebuilds `currentPath` from (streamCompleted updatePath:true),
    // so naming the error row's PARENT truncated the error row off the rendered path —
    // it existed in SQLite and was never drawn. The terminal frame names the error row.
    expect(events[events.length - 1]).toMatchObject({
      type: 'complete',
      providerError: true,
      message: { id: errorRow.id },
    })
    // R2 (one bubble per failure): the row IS the surface, so the badged completion no
    // longer carries an `envelope` for the renderer to record a second time.
    expect((events[events.length - 1] as any).envelope).toBeUndefined()
  })

  it('repeat regenerates assistant without creating new user', async () => {
    const user = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'original question',
      modelName: 'gpt-5.1-codex-mini',
    })
    const originalAssistant = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: user.id,
      role: 'assistant',
      content: 'old answer',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'repeat',
        conversationId: 'c1',
        parentId: null,
        messageId: originalAssistant.id,
        content: '',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const users = messages.filter(m => m.role === 'user' && JSON.parse(m.meta || '{}').kind !== 'operation_mode_change')
    const assistants = messages.filter(m => m.role === 'assistant')
    const newestAssistant = assistants[assistants.length - 1]

    expect(users).toHaveLength(1)
    expect(assistants.length).toBe(2)
    const modeRow = messages.find(m => m.id === newestAssistant.parent_id)
    expect(JSON.parse(modeRow.meta).kind).toBe('operation_mode_change')
    expect(modeRow.parent_id).toBe(user.id)
    expect(providerRouter.calls[0].userContent).toBe('original question')
  })

  it('branch creates child user off message and assistant under that branch', async () => {
    const rootUser = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'root',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'branch',
        conversationId: 'c1',
        parentId: null,
        messageId: rootUser.id,
        content: 'new branch prompt',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const branchedUser = messages.find(m => m.role === 'user' && m.content === 'new branch prompt')
    const modeRow = messages.find(m => m.parent_id === branchedUser.id && JSON.parse(m.meta || '{}').kind === 'operation_mode_change')
    const branchedAssistant = messages.find(m => m.role === 'assistant' && m.parent_id === modeRow?.id)

    expect(branchedUser.parent_id).toBe(rootUser.id)
    expect(branchedAssistant).toBeTruthy()
  })

  it('edit-branch creates sibling user and assistant', async () => {
    const originalUser = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'old user text',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'edit-branch',
        conversationId: 'c1',
        parentId: null,
        messageId: originalUser.id,
        content: 'edited user text',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const editedUser = messages.find(m => m.role === 'user' && m.content === 'edited user text')
    const modeRow = messages.find(m => m.parent_id === editedUser.id && JSON.parse(m.meta || '{}').kind === 'operation_mode_change')
    const editedAssistant = messages.find(m => m.role === 'assistant' && m.parent_id === modeRow?.id)

    expect(editedUser.parent_id).toBeNull()
    expect(editedAssistant).toBeTruthy()
  })

  it('runs tool loop server-side: assistant tool call -> tool result -> continued assistant', async () => {
    providerRouter.enqueue({
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'read_file',
          input: { path: 'README.md' },
        },
      ],
    })

    providerRouter.enqueue({
      content: 'Final answer after tool.',
      contentBlocks: [{ type: 'text', content: 'Final answer after tool.' }],
    })

    const orchestratorWithTools = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      toolExecutor: async toolCall => {
        if (toolCall.name === 'read_file') {
          return 'README file contents'
        }
        throw new Error(`Unexpected tool: ${toolCall.name}`)
      },
    })

    const events: any[] = []
    await orchestratorWithTools.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'Read README and summarize',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        tools: [
          {
            name: 'read_file',
            description: 'Read file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      },
      event => events.push(event)
    )

    expect(providerRouter.calls).toHaveLength(2)
    expect(providerRouter.calls[0].tools?.[0]?.name).toBe('read_file')
    expect(providerRouter.calls[1].history.some((entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call-1')).toBe(
      true
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const assistantMessages = messages.filter(m => m.role === 'assistant')
    expect(assistantMessages.length).toBe(2)

    const firstAssistant = assistantMessages[0]
    const firstAssistantBlocks = JSON.parse(firstAssistant.content_blocks || '[]') as any[]
    expect(firstAssistantBlocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'call-1')).toBe(true)

    // Calls live only in the blocks; the legacy tool_calls column is no longer written.
    expect(JSON.parse(firstAssistant.tool_calls ?? 'null')).toBeNull()
    expect(firstAssistantBlocks.some(block => block.type === 'tool_use' && block.id === 'call-1')).toBe(true)
    expect(firstAssistantBlocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'call-1')?.content).toContain('README file contents')

    const finalAssistant = assistantMessages[1]
    expect(finalAssistant.content).toBe('Final answer after tool.')

    expect(events.some(evt => evt.type === 'chunk' && evt.part === 'tool_call')).toBe(true)
    expect(events.some(evt => evt.type === 'chunk' && evt.part === 'tool_result')).toBe(true)
    expect(events.some(evt => evt.type === 'tool_execution' && evt.status === 'started' && evt.toolCallId === 'call-1')).toBe(
      true
    )
    expect(
      events.some(evt => evt.type === 'tool_execution' && evt.status === 'completed' && evt.toolCallId === 'call-1')
    ).toBe(true)

    const turnEvents = events.filter(evt => evt.type === 'tool_loop')
    expect(turnEvents.some((evt: any) => evt.status === 'turn_started' && evt.turn === 1)).toBe(true)
    expect(turnEvents.some((evt: any) => evt.status === 'turn_completed' && evt.turn === 1 && evt.continued === true)).toBe(
      true
    )
    expect(turnEvents.some((evt: any) => evt.status === 'turn_completed' && evt.turn === 2 && evt.continued === false)).toBe(
      true
    )

    expect(events[events.length - 1].type).toBe('complete')
  })

  it('uses server default tools provider when request omits tools', async () => {
    providerRouter.enqueue({ content: 'No tools needed.' })

    const orchestratorWithDefaultTools = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      defaultToolsProvider: () => [
        {
          name: 'read_file',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    })

    await orchestratorWithDefaultTools.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello with fallback tools',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const latestCall = providerRouter.calls[providerRouter.calls.length - 1]
    expect(latestCall.tools?.[0]?.name).toBe('read_file')
  })
})


describeIfSqlite('ChatOrchestrator prompt resolution', () => {
  let db: Database.Database
  let statements: any
  let providerRouter: FakeProviderRouter
  let orchestrator: ChatOrchestrator

  beforeEach(() => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    statements = createStatements(db)
    providerRouter = new FakeProviderRouter()
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  it('uses sqlite project and conversation prompts for provider instructions', async () => {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO projects (id, name, user_id, context, system_prompt, storage_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('p1', 'Project', 'u1', 'Project context', 'Project prompt from sqlite', 'local', now, now)

    statements.upsertConversation.run(
      'c-prompts',
      'p1',
      'u1',
      'Conversation',
      'gpt-5.5',
      'Conversation prompt from sqlite',
      'Conversation context from sqlite',
      null,
      null,
      'local',
      now,
      now
    )

    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c-prompts',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.5',
      },
      () => {}
    )

    const providerInput = providerRouter.calls[0]
    expect(providerInput.systemPrompt).toContain('Agent Prompt: Chat and Agent modes')
    expect(providerInput.systemPrompt).toContain('Project prompt from sqlite')
    expect(providerInput.systemPrompt).toContain('Conversation prompt from sqlite')
    expect(providerInput.systemPrompt.indexOf('Agent Prompt: Chat and Agent modes')).toBeLessThan(
      providerInput.systemPrompt.indexOf('Project prompt from sqlite')
    )
    expect(providerInput.turnContext.conversationContext).toBe('Conversation context from sqlite')
    expect(providerInput.turnContext.projectContext).toBe('Project context')
  })

  it('uses renderer-selected Agent and subagent baselines without appending bundled defaults', async () => {
    const now = new Date().toISOString()
    statements.upsertConversation.run('c-custom-prompt', null, 'u1', 'Conversation', 'gpt-5.5', null, null, null, null, 'local', now, now)

    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c-custom-prompt',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.5',
        operationModePrompt: 'Custom Agent baseline',
        agentModePrompt: 'Custom Agent baseline',
        subagentModePrompt: 'Custom Subagent baseline',
      },
      () => {}
    )

    expect(providerRouter.calls[0].systemPrompt).toContain('Custom Agent baseline')
    expect(providerRouter.calls[0].systemPrompt).not.toContain('Agent Prompt: Chat and Agent modes')
  })

  it('uses chat mode prompts for plan mode requests', async () => {
    const now = new Date().toISOString()
    statements.upsertConversation.run('c-plan', null, 'u1', 'Conversation', 'gpt-5.5', null, null, null, null, 'local', now, now)

    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c-plan',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.5',
        operationMode: 'plan',
      },
      () => {}
    )

    expect(providerRouter.calls[0].systemPrompt).toContain('Agent Prompt: Chat and Agent modes')
  })

  it('falls back to a non-empty instruction when prompts are disabled and no sqlite prompts exist', async () => {
    const now = new Date().toISOString()
    statements.upsertConversation.run('c-empty', null, 'u1', 'Conversation', 'gpt-5.5', null, null, null, null, 'local', now, now)

    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c-empty',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.5',
        includeOperationModePrompt: false,
      },
      () => {}
    )

    expect(providerRouter.calls[0].systemPrompt).toBe('You are ChatGPT.')
  })
})

describeIfSqlite('ChatOrchestrator plan mode tool policy', () => {
  let db: Database.Database
  let statements: any
  let providerRouter: FakeProviderRouter
  let orchestrator: ChatOrchestrator

  beforeEach(() => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    statements = createStatements(db)

    const now = new Date().toISOString()
    statements.upsertConversation.run('c-tools', null, 'u1', 'Conversation', 'gpt-5.5', null, null, null, null, 'local', now, now)

    providerRouter = new FakeProviderRouter()
    orchestrator = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      defaultToolsProvider: () => [
        { name: 'bash' },
        { name: 'powershell' },
        { name: 'edit_file' },
        { name: 'read_file' },
        { name: 'mcp__server__tool' },
      ],
    })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  it('filters default runtime tools for plan mode while keeping bash and powershell', async () => {
    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c-tools',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.5',
        operationMode: 'plan',
      },
      () => {}
    )

    const toolNames = (providerRouter.calls[0].tools || []).map((tool: any) => tool.name)
    expect(toolNames).toContain('bash')
    expect(toolNames).toContain('powershell')
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('edit_file') // Visible for an explicit mode-upgrade request; execution remains gated.
    expect(toolNames).not.toContain('mcp__server__tool')
  })
})
