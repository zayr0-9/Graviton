import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_CHANGE_SCHEMA } from '../../../clientChangeSchema.js'
import { ConversationRepo } from '../../persistence/conversationRepo.js'
import { LineageRepo } from '../../persistence/lineageRepo.js'
import { TRANSCRIPT_REVISION_SCHEMA, TranscriptRevisionRepo } from '../../persistence/transcriptRevisionRepo.js'
import { DecisionBroker } from '../decisionBroker.js'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { createTranscriptRevisionTool } from '../transcriptRevisionTool.js'
import type { HeadlessStreamEvent } from '../../../../../../shared/headlessApi.js'

let db: Database.Database
let revisions: TranscriptRevisionRepo
let broker: DecisionBroker
let emit: ReturnType<typeof vi.fn<(event: HeadlessStreamEvent) => void>>
let tool: ReturnType<typeof createTranscriptRevisionTool>
const args = { action: 'propose', messageId: 'shared', edits: [{ block: 0, before: 'old command', after: 'new command' }] }

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, parent_id TEXT, lineage_id TEXT, conversation_id TEXT NOT NULL,
    role TEXT, content TEXT, content_blocks TEXT, meta TEXT, created_at TEXT DEFAULT '2026-11-25T10:00:00Z');
    CREATE TABLE lineages (id TEXT PRIMARY KEY, head_message_id TEXT, conversation_id TEXT, status TEXT DEFAULT 'active');
    INSERT INTO lineages(id,head_message_id,conversation_id) VALUES
      ('a','new','chat'),('b','other','chat'),('foreign','foreign-answer','another');
    INSERT INTO messages(id,parent_id,lineage_id,conversation_id,role,content) VALUES
      ('root',NULL,'b','chat','user','Question'),
      ('shared','root','b','chat','assistant','Run the old command.'),
      ('summary','shared','a','chat','assistant','Do not change this summary.'),
      ('anchor','summary','a','chat','assistant','Later answer'),
      ('request','anchor','a','chat','user','/revise the first command'),
      ('new','request','a','chat','assistant','The current turn'),
      ('other','shared','b','chat','assistant','Sibling answer'),
      ('foreign-answer',NULL,'foreign','another','assistant','Foreign answer');
    UPDATE messages SET meta = '{"kind":"compaction_summary"}' WHERE id = 'summary';`)
  db.exec(CLIENT_CHANGE_SCHEMA)
  db.exec(TRANSCRIPT_REVISION_SCHEMA)
  const deps = { db, statements: { getMessageById: db.prepare('SELECT * FROM messages WHERE id=?'), getLineageById: db.prepare('SELECT * FROM lineages WHERE id=?') } }
  revisions = new TranscriptRevisionRepo(db)
  broker = new DecisionBroker()
  broker.initSession('stream', { autoApproveAll: true })
  emit = vi.fn()
  tool = createTranscriptRevisionTool({ conversationId: 'chat', lineageId: 'a', userMessageId: 'request',
    anchor: 'anchor', streamId: 'stream', messages: new ConversationRepo(deps), lineages: new LineageRepo(deps),
    revisions, broker, emit, runById: () => null })
})

afterEach(() => db.close())

describe('transcript revision tool', () => {
  it('targets old shared ancestors, not siblings, foreign text, synthetic rows or this run', async () => {
    const listed = await tool('list', { action: 'list' })
    expect(listed).toMatchObject({ modelContent: { replies: [{ messageId: 'anchor' }, { messageId: 'shared' }] } })
    for (const messageId of ['new', 'root', 'summary', 'other', 'foreign-answer']) {
      await expect(tool('read', { action: 'read', messageId })).rejects.toThrow('completed assistant reply')
    }
    const read = await tool('read', { action: 'read', messageId: 'shared' })
    expect(read).toMatchObject({ modelContent: { text: 'Run the old command.' }, persistedContent: { messageId: 'shared' } })
    expect(JSON.stringify((read as any).persistedContent)).not.toContain('old command')
  })

  it('requires an exact diff decision even under Allow all; applies only to the selected lineage and supports undo', async () => {
    const later = tool('patch', args)
    expect(revisions.list('a')).toEqual([])
    expect(broker.snapshot('stream').pending).toEqual([expect.objectContaining({ type: 'permission_required',
      transcriptRevision: expect.objectContaining({ messageId: 'shared', edits: args.edits }) })])
    expect(broker.resolve('stream', 'patch', 'allow_once')).toBe(false)
    broker.setAutoApproveAll('stream')
    expect(broker.hasPending('stream', 'patch')).toBe(true)
    expect(broker.resolve('wrong-stream', 'patch', 'approve_transcript_revision')).toBe(false)
    expect(broker.resolve('stream', 'patch', 'approve_transcript_revision')).toBe(true)
    await expect(later).resolves.toMatchObject({ applied: true, messageId: 'shared' })
    const [revision] = revisions.list('a')
    expect(revision.changes).toEqual([{ index: 0, original: 'Run the old command.', revised: 'Run the new command.' }])
    expect(revisions.list('b')).toEqual([])
    expect(db.prepare("SELECT content FROM messages WHERE id='shared'").pluck().get()).toBe('Run the old command.')
    expect(() => revisions.undo('chat', 'a', 'shared', revision.id + 1)).toThrow('revised elsewhere')
    revisions.undo('chat', 'a', 'shared', revision.id)
    expect(revisions.list('a')).toEqual([])
    expect(db.prepare('SELECT domain,entity_id,conversation_id FROM client_changes').all()).toEqual([
      { domain: 'transcript_revisions', entity_id: 'a', conversation_id: 'chat' },
      { domain: 'transcript_revisions', entity_id: 'a', conversation_id: 'chat' },
    ])
  })

  it('rejects stale original text and stale branch paths at approval time', async () => {
    const stale = tool('patch', args)
    db.exec("UPDATE messages SET content = 'Edited manually' WHERE id = 'shared'")
    broker.resolve('stream', 'patch', 'approve_transcript_revision')
    await expect(stale).rejects.toThrow('reply changed')
    db.exec("UPDATE lineages SET head_message_id = 'other' WHERE id = 'a'")
    await expect(tool('read', { action: 'read', messageId: 'shared' })).rejects.toThrow('original lineage')
    expect(revisions.list('a')).toEqual([])
  })

  it('rejects overlapping and ambiguous edits before prompting', async () => {
    await expect(tool('overlap', { ...args, edits: [...args.edits, { block: 0, before: 'command.', after: 'script.' }] })).rejects.toThrow('overlap')
    db.exec("UPDATE messages SET content = 'old command then old command' WHERE id = 'shared'")
    await expect(tool('ambiguous', args)).rejects.toThrow('exactly once')
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps the approval separate from ordinary tool approval and refuses calls outside /revise runs', async () => {
    const base = vi.fn()
    const call = { name: 'revise_transcript', arguments: args, id: 'proposal' }
    const plain = createChatPausingExecutor({ base, broker, streamId: 'stream', emit })
    await expect(plain(call, {} as any)).rejects.toThrow('/revise')
    expect(base).not.toHaveBeenCalled()
    const executor = createChatPausingExecutor({ base, broker, streamId: 'stream', emit, reviseTranscript: tool })
    const pending = executor(call, {} as any)
    expect(broker.resolve('stream', 'proposal', 'deny')).toBe(false)
    expect(broker.resolve('stream', 'proposal', 'decline_transcript_revision')).toBe(true)
    await expect(pending).rejects.toThrow('denied by user')
    await expect(executor({ ...call, id: 'again' }, {} as any)).rejects.toThrow('one revision')
    expect(revisions.list('a')).toEqual([])
  })

  it('does not apply on cancellation', async () => {
    const controller = new AbortController()
    const pending = tool('patch', args, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(broker.resolve('stream', 'patch', 'approve_transcript_revision')).toBe(false)
    expect(revisions.list('a')).toEqual([])
  })
})
