import { TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL } from './topLevelUserMessages.js'

/**
 * Note search storage: `note_search_docs` (one row per noted message, denormalised with
 * the conversation's project/user/title), the embedding bookkeeping tables, and the
 * `note_search_fts` FTS5 index over the docs.
 *
 * Boot runs the *_SCHEMA_SQL constants only (all IF NOT EXISTS); the triggers keep
 * every table current. rebuildSearchIndexes() is the one-time repair/upgrade path used
 * by schema migration v5 (see MIGRATIONS.md). Change a trigger body only together with
 * a new migration that calls rebuildSearchIndexes(), because CREATE TRIGGER IF NOT
 * EXISTS never replaces an existing body.
 */

/** Minimal driver surface shared by better-sqlite3 and node:sqlite. */
export interface SearchIndexDatabase {
  exec(sql: string): unknown
}

export const NOTE_SEARCH_TRIGGER_NAMES = [
  'note_search_docs_fts_insert',
  'note_search_docs_fts_update',
  'note_search_docs_fts_delete',
  'note_search_docs_from_messages_insert',
  'note_search_docs_from_messages_update',
  'note_search_docs_from_messages_delete',
  'note_search_docs_from_conversations_update',
] as const

export const NOTE_SEARCH_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS note_search_docs (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    project_id TEXT,
    user_id TEXT NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('cloud','local')) DEFAULT 'local',
    conversation_title TEXT,
    note TEXT NOT NULL,
    message_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    note_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_note_search_docs_user_note_updated
    ON note_search_docs(user_id, note_updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_note_search_docs_user_project_note_updated
    ON note_search_docs(user_id, project_id, note_updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_note_search_docs_conversation_id
    ON note_search_docs(conversation_id);

  CREATE TABLE IF NOT EXISTS note_search_embedding_state (
    message_id TEXT PRIMARY KEY,
    content_hash TEXT,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    embedding_updated_at DATETIME,
    embedding_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (embedding_status IN ('pending','ready','error','stale')),
    last_error TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS note_search_vector_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    vector_table_name TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO note_search_vector_config (id, vector_table_name) VALUES (1, 'note_search_vec');
`

// Keyed by the note_search_docs rowid for the same reason as the top-level index:
// FTS5 deletes by an UNINDEXED column scan the whole index; deletes by rowid do not.
export const NOTE_SEARCH_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS note_search_fts USING fts5(
    message_id UNINDEXED,
    conversation_title,
    note,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`

export const NOTE_SEARCH_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_insert
  AFTER INSERT ON note_search_docs
  BEGIN
    INSERT OR REPLACE INTO note_search_fts (rowid, message_id, conversation_title, note)
    VALUES (NEW.rowid, NEW.message_id, COALESCE(NEW.conversation_title, ''), COALESCE(NEW.note, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_update
  AFTER UPDATE OF message_id, conversation_title, note ON note_search_docs
  BEGIN
    DELETE FROM note_search_fts WHERE rowid = OLD.rowid;
    INSERT OR REPLACE INTO note_search_fts (rowid, message_id, conversation_title, note)
    VALUES (NEW.rowid, NEW.message_id, COALESCE(NEW.conversation_title, ''), COALESCE(NEW.note, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_delete
  AFTER DELETE ON note_search_docs
  BEGIN
    DELETE FROM note_search_fts WHERE rowid = OLD.rowid;
  END;

  CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_insert
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

  CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_update
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

  CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_delete
  AFTER DELETE ON messages
  BEGIN
    DELETE FROM note_search_docs WHERE message_id = OLD.id;
    DELETE FROM note_search_embedding_state WHERE message_id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS note_search_docs_from_conversations_update
  AFTER UPDATE OF project_id, user_id, storage_mode, title ON conversations
  WHEN NEW.project_id IS NOT OLD.project_id
    OR NEW.user_id IS NOT OLD.user_id
    OR NEW.storage_mode IS NOT OLD.storage_mode
    OR NEW.title IS NOT OLD.title
  BEGIN
    UPDATE note_search_docs
    SET
      project_id = NEW.project_id,
      user_id = NEW.user_id,
      storage_mode = NEW.storage_mode,
      conversation_title = NEW.title
    WHERE conversation_id = NEW.id;
  END;
`

/** FTS table + triggers; boot runs this after the vector-table setup. */
export const NOTE_SEARCH_FTS_SQL = `
  ${NOTE_SEARCH_FTS_TABLE_SQL}
  ${NOTE_SEARCH_TRIGGERS_SQL}
`

/** Full boot-time note search schema, all IF NOT EXISTS. Never touches rows. */
export const NOTE_SEARCH_SCHEMA_SQL = `
  ${NOTE_SEARCH_TABLES_SQL}
  ${NOTE_SEARCH_FTS_SQL}
`

/**
 * One-time rebuild. Drops every trigger first so the doc sync does not run per-row FTS
 * deletes, brings note_search_docs in line with messages while keeping note_updated_at
 * for notes whose text did not change, refills the FTS index keyed by rowid, then
 * recreates the triggers.
 */
export const NOTE_SEARCH_REBUILD_SQL = `
  ${NOTE_SEARCH_TABLES_SQL}
  ${NOTE_SEARCH_FTS_TABLE_SQL}
  ${NOTE_SEARCH_TRIGGER_NAMES.map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n  ')}

  DELETE FROM note_search_docs
  WHERE message_id NOT IN (SELECT id FROM messages WHERE LENGTH(TRIM(COALESCE(note, ''))) > 0);

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
    m.id,
    m.conversation_id,
    c.project_id,
    c.user_id,
    c.storage_mode,
    c.title,
    m.note,
    COALESCE(m.created_at, CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
  FROM messages m
  INNER JOIN conversations c ON c.id = m.conversation_id
  WHERE LENGTH(TRIM(COALESCE(m.note, ''))) > 0
  ON CONFLICT(message_id) DO UPDATE SET
    conversation_id = excluded.conversation_id,
    project_id = excluded.project_id,
    user_id = excluded.user_id,
    storage_mode = excluded.storage_mode,
    conversation_title = excluded.conversation_title,
    note = excluded.note,
    message_created_at = excluded.message_created_at,
    note_updated_at = CASE
      WHEN note_search_docs.note IS excluded.note THEN note_search_docs.note_updated_at
      ELSE excluded.note_updated_at
    END;

  DELETE FROM note_search_embedding_state
  WHERE message_id NOT IN (SELECT message_id FROM note_search_docs);

  INSERT OR IGNORE INTO note_search_embedding_state (
    message_id,
    content_hash,
    embedding_model,
    embedding_dimensions,
    embedding_updated_at,
    embedding_status,
    last_error
  )
  SELECT d.message_id, NULL, NULL, NULL, NULL, 'pending', NULL
  FROM note_search_docs d;

  DELETE FROM note_search_fts;
  INSERT OR REPLACE INTO note_search_fts (rowid, message_id, conversation_title, note)
  SELECT d.rowid, d.message_id, COALESCE(d.conversation_title, ''), COALESCE(d.note, '')
  FROM note_search_docs d;

  ${NOTE_SEARCH_TRIGGERS_SQL}
`

/**
 * Rebuild both search indexes atomically (savepoint, so it also works inside a caller's
 * transaction). Idempotent: safe to run again after a crash before the migration stamp.
 * Requires `messages` and `conversations`; creates every search table it needs.
 */
export function rebuildSearchIndexes(database: SearchIndexDatabase): void {
  database.exec('SAVEPOINT search_index_rebuild')
  try {
    database.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL)
    database.exec(NOTE_SEARCH_REBUILD_SQL)
    database.exec('RELEASE search_index_rebuild')
  } catch (error) {
    database.exec('ROLLBACK TO search_index_rebuild')
    database.exec('RELEASE search_index_rebuild')
    throw error
  }
}
