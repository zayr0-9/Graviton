import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planMessageDeletion } from '../claudeMessageDeletion.js'
import { deleteMessagesWithLineageRepair } from '../deleteMessages.js'

const CLAUDE = JSON.stringify({ modelSelection: { provider: 'claudecode', model: 'm' } })
const CONTEXT = JSON.stringify({ kind: 'context_injection' })

describe('Claude message deletion planning', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      children_ids TEXT DEFAULT '[]', lineage_id TEXT, role TEXT, meta TEXT);
      CREATE TABLE lineages (id TEXT PRIMARY KEY, conversation_id TEXT, head_message_id TEXT, root_message_id TEXT,
        forked_from_message_id TEXT, status TEXT, updated_at TEXT);
      CREATE TABLE claude_branch_sessions (lineage_id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE claude_message_checkpoints (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, resumable INTEGER);`)
  })
  afterEach(() => db.close())
  const add = (id: string, parent: string | null, role: string, meta: string | null = CLAUDE) =>
    db.prepare('INSERT INTO messages (id, conversation_id, parent_id, role, meta, lineage_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'c', parent, role, meta, 'l')
  const checkpoint = (id: string) => db.prepare('INSERT INTO claude_message_checkpoints VALUES (?, 1)').run(id)

  it('leaves non-Claude deletions unchanged', () => {
    add('ctx', null, 'user', CONTEXT)
    add('u', 'ctx', 'user', null)
    expect(planMessageDeletion(db, ['u'])).toEqual(['u'])
  })

  it('removes launch scaffolding owned only by a deleted first prompt', () => {
    add('ctx', null, 'user', CONTEXT)
    add('u', 'ctx', 'user')
    add('a', 'u', 'assistant')
    expect(planMessageDeletion(db, ['u']).sort()).toEqual(['ctx', 'u'])
    // A second prompt sharing that scaffolding keeps it.
    add('u2', 'ctx', 'user')
    expect(planMessageDeletion(db, ['u'])).toEqual(['u'])
  })

  it('allows cuts at a completed response or beside a surviving sibling, and refuses the rest', () => {
    add('u', null, 'user')
    add('a', 'u', 'assistant')
    checkpoint('a')
    add('u2', 'a', 'user')
    add('tool', 'u2', 'assistant')
    add('queued', 'tool', 'user')
    expect(planMessageDeletion(db, ['u2'])).toEqual(['u2'])
    expect(() => planMessageDeletion(db, ['queued'])).toThrow(expect.objectContaining({ status: 409, code: 'claude_delete_refused' }))
    // The only response of a turn: deleting it would strand the prompt.
    expect(() => planMessageDeletion(db, ['tool'])).toThrow(expect.objectContaining({ code: 'claude_delete_refused' }))
    // A regenerated sibling remains, so its alternative can go.
    add('retry', 'u2', 'assistant')
    expect(planMessageDeletion(db, ['tool'])).toEqual(['tool'])
    // Descendants of a requested row are part of its cut, not separate ones.
    expect(planMessageDeletion(db, ['u2', 'tool', 'queued']).sort()).toEqual(['queued', 'tool', 'u2'])
  })

  it('refuses a cut that would leave the branch on a compaction summary', () => {
    add('u', null, 'user')
    add('summary', 'u', 'assistant', JSON.stringify({ ...JSON.parse(CLAUDE), kind: 'compaction_summary', state: 'committed' }))
    add('restored', 'summary', 'user', CONTEXT)
    add('next', 'restored', 'user')
    expect(() => planMessageDeletion(db, ['next'])).toThrow(expect.objectContaining({ code: 'claude_delete_refused' }))
  })

  it('resets the native session of a branch emptied by deletion', () => {
    add('u', null, 'user')
    db.exec(`INSERT INTO lineages VALUES ('l', 'c', 'u', 'u', NULL, 'active', 'before');
      INSERT INTO claude_branch_sessions VALUES ('l', 'session');`)
    deleteMessagesWithLineageRepair(db, planMessageDeletion(db, ['u']))
    expect(db.prepare('SELECT * FROM claude_branch_sessions').all()).toEqual([])
  })
})
