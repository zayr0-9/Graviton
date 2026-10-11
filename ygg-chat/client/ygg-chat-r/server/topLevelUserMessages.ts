import { CONTEXT_INJECTION_KIND } from '../../../shared/contextInjection.js'
import { FULL_ACCESS_NOTIFICATION_KIND } from '../../../shared/accessNotifications.js'

const GENERATED_ROOT_KINDS_SQL = `('${CONTEXT_INJECTION_KIND}', '${FULL_ACCESS_NOTIFICATION_KIND}')`

// A generated user row (launch context, access notice) is transparent at the root boundary.
// NULL-safe for WHEN/WHERE use: a missing kind yields NULL, which is falsy there.
const isGeneratedUserRowSql = (alias: string) =>
  `${alias}.role = 'user' AND json_valid(${alias}.meta) AND json_extract(${alias}.meta, '$.kind') IN ${GENERATED_ROOT_KINDS_SQL}`

/**
 * Human top-level prompts for sidebar previews and chat-history summaries.
 * Generated launch-context/access-notice user rows are transparent at the root boundary:
 * walk their children, but stop at ordinary messages so later turns stay excluded.
 * Keep the compact response shape and original IDs; never change the stored tree.
 */
// scopePredicate is internal SQL only; pass runtime values through bound parameters.
export const buildTopLevelUserMessagesCte = (scopePredicate: string = 'conversation_id = ?') => `
  WITH RECURSIVE
  scoped_messages AS (
    SELECT id, conversation_id, parent_id, role,
      CASE WHEN role = 'user' AND json_valid(meta)
        THEN COALESCE(json_extract(meta, '$.kind') IN ${GENERATED_ROOT_KINDS_SQL}, 0)
        ELSE 0
      END AS is_context_injection
    FROM messages
    WHERE ${scopePredicate}
  ),
  preview_candidates AS (
    SELECT * FROM scoped_messages WHERE parent_id IS NULL
    UNION
    SELECT child.*
    FROM scoped_messages child
    JOIN preview_candidates parent ON child.parent_id = parent.id
    WHERE parent.is_context_injection = 1
      AND child.conversation_id = parent.conversation_id
  ),
  human_top_level_user_message_ids AS (
    SELECT id FROM preview_candidates
    WHERE role = 'user' AND is_context_injection = 0
  )
`

export const TOP_LEVEL_USER_MESSAGES_SQL = `
  ${buildTopLevelUserMessagesCte()}
  SELECT m.id, m.conversation_id, m.content, m.plain_text_content, m.note, m.note_color, m.created_at, m.role, m.parent_id, m.children_ids
  FROM messages m
  JOIN human_top_level_user_message_ids candidate ON candidate.id = m.id
  ORDER BY m.created_at ASC
`

// FTS rows are keyed by the message rowid: FTS5 cannot index an UNINDEXED column, so
// `WHERE message_id = ?` scans the whole index, while `WHERE rowid = ?` is a lookup.
// `messages` has a TEXT primary key, so its rowid is implicit; VACUUM may renumber
// such rowids, which is why rebuildSearchIndexes() exists (see MIGRATIONS.md, v5).
const indexRowsSql = (scopePredicate: string) => `
  SELECT m.rowid, m.id, COALESCE(m.content, ''), COALESCE(m.plain_text_content, ''), COALESCE(m.note, '')
  FROM messages m
  JOIN (
    ${buildTopLevelUserMessagesCte(scopePredicate)}
    SELECT id FROM human_top_level_user_message_ids
  ) candidate ON candidate.id = m.id
`

// Refresh the affected conversation, not just the changed row: changing a
// generated ancestor's metadata/parent can change eligibility of its children.
const refreshSearchConversationSql = (conversationId: string, condition: string = '1 = 1') => `
  DELETE FROM top_level_user_message_search
  WHERE ${condition} AND rowid IN (SELECT rowid FROM messages WHERE conversation_id = ${conversationId});
  INSERT OR REPLACE INTO top_level_user_message_search (rowid, message_id, content, plain_text_content, note)
  ${indexRowsSql(`conversation_id = ${conversationId} AND ${condition}`)};
`

export const TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES = [
  'top_level_user_message_search_insert',
  'top_level_user_message_search_update_text',
  'top_level_user_message_search_update_tree',
  'top_level_user_message_search_delete',
] as const

// Earlier generations used one update trigger; rebuilds drop it alongside the current names.
const LEGACY_TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES = ['top_level_user_message_search_update']

export const TOP_LEVEL_USER_MESSAGE_SEARCH_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS top_level_user_message_search USING fts5(
    message_id UNINDEXED,
    content,
    plain_text_content,
    note,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`

/**
 * Create-only trigger DDL (safe on every boot). Eligibility can only change for a user
 * row whose parent is a root or a generated row, so ordinary follow-up turns, assistant
 * and tool rows, streaming content updates, and children_ids maintenance cost nothing.
 * To change a trigger body, ship a migration that calls rebuildSearchIndexes().
 */
export const TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_insert
  AFTER INSERT ON messages
  WHEN NEW.role = 'user' AND (
    NEW.parent_id IS NULL
    OR EXISTS (SELECT 1 FROM messages p WHERE p.id = NEW.parent_id AND ${isGeneratedUserRowSql('p')})
  )
  BEGIN
    ${refreshSearchConversationSql('NEW.conversation_id')}
  END;

  CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_update_text
  AFTER UPDATE OF content, plain_text_content, note ON messages
  WHEN NEW.role = 'user'
  BEGIN
    UPDATE top_level_user_message_search
    SET content = COALESCE(NEW.content, ''),
        plain_text_content = COALESCE(NEW.plain_text_content, ''),
        note = COALESCE(NEW.note, '')
    WHERE rowid = NEW.rowid;
  END;

  CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_update_tree
  AFTER UPDATE OF id, conversation_id, parent_id, role, meta ON messages
  WHEN NEW.role = 'user' OR OLD.role = 'user'
  BEGIN
    ${refreshSearchConversationSql('OLD.conversation_id')}
    ${refreshSearchConversationSql('NEW.conversation_id', 'NEW.conversation_id IS NOT OLD.conversation_id')}
  END;

  CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_delete
  AFTER DELETE ON messages
  WHEN OLD.role = 'user'
  BEGIN
    DELETE FROM top_level_user_message_search WHERE rowid = OLD.rowid;
    ${refreshSearchConversationSql('OLD.conversation_id', `(${isGeneratedUserRowSql('OLD')})`)}
  END;
`

/** Boot-time schema: table + triggers, all IF NOT EXISTS. Never touches index rows. */
export const TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL = `
  ${TOP_LEVEL_USER_MESSAGE_SEARCH_TABLE_SQL}
  ${TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGERS_SQL}
`

/** One-time rebuild: replace every trigger generation and refill the index keyed by rowid. */
export const TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL = `
  ${TOP_LEVEL_USER_MESSAGE_SEARCH_TABLE_SQL}
  ${[...LEGACY_TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES, ...TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES]
    .map(name => `DROP TRIGGER IF EXISTS ${name};`)
    .join('\n  ')}
  DELETE FROM top_level_user_message_search;
  INSERT OR REPLACE INTO top_level_user_message_search (rowid, message_id, content, plain_text_content, note)
  ${indexRowsSql('1 = 1')};
  ${TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGERS_SQL}
`
