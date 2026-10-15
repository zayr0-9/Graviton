import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MessageRepo } from '../../persistence/messageRepo.js'
import { SubagentRunRepo } from '../../persistence/subagentRunRepo.js'
import { isCommittedCompaction } from '../../../../../../shared/compaction.js'

const require = createRequire(import.meta.url)
function database() {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(':memory:')
  return { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), close: () => db.close(),
    transaction: (fn: () => unknown) => () => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } } }
}

describe('durable committed compaction', () => {
  it('atomically updates the existing main row and is idempotent', () => {
    const db = database()
    try {
      db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, content TEXT, plain_text_content TEXT, content_blocks TEXT, meta TEXT);
        INSERT INTO messages VALUES ('a', 'assistant', 'summary', 'summary', '[]', '{}')`)
      const repo = new MessageRepo({ db, statements: { getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?') } })
      const update = { content: 'summary + evidence', contentBlocks: [{ type: 'text', content: 'summary + evidence' }],
        meta: { kind: 'compaction_summary', state: 'committed', compactionId: 'u' } }
      const row = repo.finaliseCompaction('a', update)
      expect(isCommittedCompaction(row)).toBe(true)
      expect(row.plain_text_content).toBe(update.content)
      expect(repo.finaliseCompaction('a', { ...update, content: 'duplicate' }).content).toBe(update.content)
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(1)
    } finally { db.close() }
  })

  it('migrates old child rows and reloads committed child metadata without changing sequence', () => {
    const db = database()
    try {
      db.exec(`CREATE TABLE subagent_messages (id TEXT PRIMARY KEY, run_id TEXT, role TEXT, content TEXT, content_blocks TEXT, tool_calls TEXT, sequence INTEGER);
        INSERT INTO subagent_messages VALUES ('a', 'r', 'assistant', 'summary', '[]', '[]', 3)`)
      const source = readFileSync(new URL('../../../localServer.ts', import.meta.url), 'utf8')
      const start = source.indexOf('const SCHEMA_MIGRATIONS:')
      const end = source.indexOf('\n]\n', start) + 2
      const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const migrations = runInNewContext(`${code}; SCHEMA_MIGRATIONS`, {})
      const migration = migrations.find((entry: any) => entry.name === 'subagent_message_metadata')
      migration.up(db); migration.up(db)
      expect(db.prepare('SELECT meta FROM subagent_messages').get().meta).toBeNull()
      const repo = new SubagentRunRepo({ statements: {
        getSubagentMessagesByRunId: db.prepare('SELECT * FROM subagent_messages WHERE run_id = ? ORDER BY sequence'),
        finaliseSubagentCompaction: db.prepare('UPDATE subagent_messages SET content = ?, content_blocks = ?, meta = ? WHERE id = ? AND run_id = ?'),
      } })
      repo.finaliseCompaction('r', 'a', { content: 'summary + evidence', contentBlocks: [], meta: { kind: 'compaction_summary', state: 'committed' } })
      const row = repo.getMessages('r')[0]
      expect(isCommittedCompaction(row)).toBe(true)
      expect(row.sequence).toBe(3)
    } finally { db.close() }
  })
})
