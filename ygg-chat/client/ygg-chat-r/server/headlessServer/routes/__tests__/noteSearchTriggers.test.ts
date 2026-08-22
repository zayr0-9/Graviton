import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

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
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      user_id TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      title TEXT,
      storage_mode TEXT NOT NULL DEFAULT 'local',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      children_ids TEXT DEFAULT '[]',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      plain_text_content TEXT,
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      model_name TEXT DEFAULT 'unknown',
      note TEXT,
      note_color TEXT,
      ex_agent_session_id TEXT,
      ex_agent_type TEXT,
      content_blocks TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE note_search_docs (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project_id TEXT,
      user_id TEXT NOT NULL,
      storage_mode TEXT NOT NULL DEFAULT 'local',
      conversation_title TEXT,
      note TEXT NOT NULL,
      message_created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      note_updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE note_search_embedding_state (
      message_id TEXT PRIMARY KEY,
      content_hash TEXT,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      embedding_updated_at TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending','ready','error','stale')),
      last_error TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `)
}

function installStaleBrokenTrigger(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER note_search_docs_from_messages_update
    AFTER UPDATE ON messages
    WHEN LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
    BEGIN
      INSERT INTO note_search_embedding_state (
        message_id,
        content_hash,
        embedding_status,
        last_error
      ) VALUES (
        NEW.id,
        NULL,
        'pending',
        NULL
      );
    END;
  `)
}

function installCurrentNoteSearchTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS note_search_docs_from_messages_insert;
    DROP TRIGGER IF EXISTS note_search_docs_from_messages_update;
    DROP TRIGGER IF EXISTS note_search_docs_from_messages_delete;
    DROP TRIGGER IF EXISTS note_search_docs_from_conversations_update;
  `)

  db.exec(`
    CREATE TRIGGER note_search_docs_from_messages_insert
    AFTER INSERT ON messages
    WHEN LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
    BEGIN
      INSERT INTO note_search_docs (
        message_id,
        conversation_id,
        project_id,
        user_id,
        storage_mode,
        conversation_title,
        note,
        message_created_at,
        note_updated_at
      )
      SELECT
        NEW.id,
        NEW.conversation_id,
        c.project_id,
        c.user_id,
        c.storage_mode,
        c.title,
        NEW.note,
        COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM conversations c
      WHERE c.id = NEW.conversation_id
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        project_id = excluded.project_id,
        user_id = excluded.user_id,
        storage_mode = excluded.storage_mode,
        conversation_title = excluded.conversation_title,
        note = excluded.note,
        message_created_at = excluded.message_created_at,
        note_updated_at = excluded.note_updated_at;

      INSERT INTO note_search_embedding_state (
        message_id,
        content_hash,
        embedding_model,
        embedding_dimensions,
        embedding_updated_at,
        embedding_status,
        last_error
      ) VALUES (
        NEW.id,
        NULL,
        NULL,
        NULL,
        NULL,
        'pending',
        NULL
      )
      ON CONFLICT(message_id) DO UPDATE SET
        content_hash = NULL,
        embedding_status = CASE
          WHEN note_search_embedding_state.embedding_status = 'ready' THEN 'stale'
          ELSE note_search_embedding_state.embedding_status
        END,
        last_error = NULL;
    END;

    CREATE TRIGGER note_search_docs_from_messages_update
    AFTER UPDATE ON messages
    WHEN COALESCE(OLD.note, '') IS NOT COALESCE(NEW.note, '')
    BEGIN
      DELETE FROM note_search_docs
      WHERE message_id = OLD.id
        AND LENGTH(TRIM(COALESCE(NEW.note, ''))) = 0;

      INSERT INTO note_search_docs (
        message_id,
        conversation_id,
        project_id,
        user_id,
        storage_mode,
        conversation_title,
        note,
        message_created_at,
        note_updated_at
      )
      SELECT
        NEW.id,
        NEW.conversation_id,
        c.project_id,
        c.user_id,
        c.storage_mode,
        c.title,
        NEW.note,
        COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM conversations c
      WHERE c.id = NEW.conversation_id
        AND LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        project_id = excluded.project_id,
        user_id = excluded.user_id,
        storage_mode = excluded.storage_mode,
        conversation_title = excluded.conversation_title,
        note = excluded.note,
        message_created_at = excluded.message_created_at,
        note_updated_at = excluded.note_updated_at;

      DELETE FROM note_search_embedding_state
      WHERE message_id = OLD.id
        AND LENGTH(TRIM(COALESCE(NEW.note, ''))) = 0;

      INSERT INTO note_search_embedding_state (
        message_id,
        content_hash,
        embedding_model,
        embedding_dimensions,
        embedding_updated_at,
        embedding_status,
        last_error
      )
      SELECT
        NEW.id,
        NULL,
        NULL,
        NULL,
        NULL,
        'pending',
        NULL
      WHERE LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
      ON CONFLICT(message_id) DO UPDATE SET
        content_hash = NULL,
        embedding_status = CASE
          WHEN COALESCE(OLD.note, '') IS COALESCE(NEW.note, '') THEN note_search_embedding_state.embedding_status
          WHEN note_search_embedding_state.embedding_status = 'ready' THEN 'stale'
          ELSE 'pending'
        END,
        last_error = NULL;
    END;

    CREATE TRIGGER note_search_docs_from_messages_delete
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM note_search_docs WHERE message_id = OLD.id;
      DELETE FROM note_search_embedding_state WHERE message_id = OLD.id;
    END;

    CREATE TRIGGER note_search_docs_from_conversations_update
    AFTER UPDATE ON conversations
    BEGIN
      UPDATE note_search_docs
      SET
        project_id = NEW.project_id,
        user_id = NEW.user_id,
        storage_mode = NEW.storage_mode,
        conversation_title = NEW.title,
        note_updated_at = CURRENT_TIMESTAMP
      WHERE conversation_id = NEW.id;
    END;
  `)
}

function createUpsertMessageStatement(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      plain_text_content = excluded.plain_text_content,
      thinking_block = excluded.thinking_block,
      tool_calls = excluded.tool_calls,
      tool_call_id = excluded.tool_call_id,
      note = excluded.note,
      note_color = excluded.note_color,
      content_blocks = excluded.content_blocks
  `)
}

describeIfSqlite('note search message triggers', () => {
  it('replaces stale trigger definitions and allows repeated sync of a noted message', () => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    const db = new BetterSqlite3Ctor(':memory:')
    try {
      createSchema(db)
      db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run('u1', 'u1', 'now')
      db.prepare('INSERT INTO conversations (id, project_id, user_id, title, storage_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('c1', null, 'u1', 'Conversation', 'local', 'now', 'now')

      installStaleBrokenTrigger(db)
      installCurrentNoteSearchTriggers(db)

      const upsertMessage = createUpsertMessageStatement(db)
      upsertMessage.run(
        'm1',
        'c1',
        null,
        '[]',
        'user',
        'hello',
        'hello',
        null,
        null,
        null,
        'unknown',
        'first note',
        null,
        null,
        null,
        null,
        '2026-06-17T00:00:00.000Z'
      )

      db.prepare(`
        UPDATE note_search_embedding_state
        SET embedding_status = 'ready', content_hash = 'old-hash', embedding_model = 'model-a', embedding_dimensions = 3
        WHERE message_id = ?
      `).run('m1')

      expect(() => {
        upsertMessage.run(
          'm1',
          'c1',
          null,
          '[]',
          'user',
          'hello again',
          'hello again',
          null,
          null,
          null,
          'unknown',
          'first note',
          null,
          null,
          null,
          null,
          '2026-06-17T00:00:00.000Z'
        )
      }).not.toThrow()

      const unchangedState = db.prepare('SELECT * FROM note_search_embedding_state WHERE message_id = ?').get('m1') as any
      expect(unchangedState.embedding_status).toBe('ready')
      expect(unchangedState.content_hash).toBe('old-hash')

      expect(() => {
        upsertMessage.run(
          'm1',
          'c1',
          null,
          '[]',
          'user',
          'hello again',
          'hello again',
          null,
          null,
          null,
          'unknown',
          'changed note',
          null,
          null,
          null,
          null,
          '2026-06-17T00:00:00.000Z'
        )
      }).not.toThrow()

      const changedState = db.prepare('SELECT * FROM note_search_embedding_state WHERE message_id = ?').get('m1') as any
      const doc = db.prepare('SELECT note FROM note_search_docs WHERE message_id = ?').get('m1') as any
      expect(changedState.embedding_status).toBe('stale')
      expect(changedState.content_hash).toBeNull()
      expect(doc.note).toBe('changed note')

      expect(() => {
        upsertMessage.run(
          'm1',
          'c1',
          null,
          '[]',
          'user',
          'hello again',
          'hello again',
          null,
          null,
          null,
          'unknown',
          null,
          null,
          null,
          null,
          null,
          '2026-06-17T00:00:00.000Z'
        )
      }).not.toThrow()

      const removedState = db.prepare('SELECT * FROM note_search_embedding_state WHERE message_id = ?').get('m1')
      const removedDoc = db.prepare('SELECT * FROM note_search_docs WHERE message_id = ?').get('m1')
      expect(removedState).toBeUndefined()
      expect(removedDoc).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
