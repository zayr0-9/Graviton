import { CONTEXT_INJECTION_KIND } from '../../../shared/contextInjection.js'
import { FULL_ACCESS_NOTIFICATION_KIND } from '../../../shared/accessNotifications.js'

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
        THEN COALESCE(json_extract(meta, '$.kind') IN ('${CONTEXT_INJECTION_KIND}', '${FULL_ACCESS_NOTIFICATION_KIND}'), 0)
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

// Refresh the affected conversation, not just the changed row: changing a
// generated ancestor's metadata/parent can change eligibility of its children.
const refreshSearchConversationSql = (conversationId: string, condition: string = '1 = 1') => `
  DELETE FROM top_level_user_message_search
  WHERE ${condition} AND message_id IN (SELECT id FROM messages WHERE conversation_id = ${conversationId});
  INSERT INTO top_level_user_message_search (message_id, content, plain_text_content, note)
  SELECT id, COALESCE(content, ''), COALESCE(plain_text_content, ''), COALESCE(note, '')
  FROM (
    ${buildTopLevelUserMessagesCte(`conversation_id = ${conversationId} AND ${condition}`)}
    SELECT m.* FROM messages m
    JOIN human_top_level_user_message_ids candidate ON candidate.id = m.id
  );
`

/** Replace legacy root-only triggers and backfill existing hover-visible prompts. */
export const TOP_LEVEL_USER_MESSAGE_SEARCH_INDEX_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS top_level_user_message_search USING fts5(
    message_id UNINDEXED,
    content,
    plain_text_content,
    note,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  DROP TRIGGER IF EXISTS top_level_user_message_search_insert;
  DROP TRIGGER IF EXISTS top_level_user_message_search_update;
  DROP TRIGGER IF EXISTS top_level_user_message_search_delete;

  CREATE TRIGGER top_level_user_message_search_insert AFTER INSERT ON messages
  BEGIN
    ${refreshSearchConversationSql('NEW.conversation_id')}
  END;

  CREATE TRIGGER top_level_user_message_search_update
  AFTER UPDATE OF id, conversation_id, parent_id, role, meta, content, plain_text_content, note ON messages
  WHEN NEW.role = 'user' OR OLD.role = 'user'
    OR NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.parent_id IS NOT OLD.parent_id OR NEW.role IS NOT OLD.role
  BEGIN
    DELETE FROM top_level_user_message_search WHERE message_id = OLD.id;
    ${refreshSearchConversationSql('OLD.conversation_id')}
    ${refreshSearchConversationSql('NEW.conversation_id', 'NEW.conversation_id IS NOT OLD.conversation_id')}
  END;

  CREATE TRIGGER top_level_user_message_search_delete AFTER DELETE ON messages
  BEGIN
    DELETE FROM top_level_user_message_search WHERE message_id = OLD.id;
    ${refreshSearchConversationSql('OLD.conversation_id')}
  END;

  DELETE FROM top_level_user_message_search;
  INSERT INTO top_level_user_message_search (message_id, content, plain_text_content, note)
  SELECT id, COALESCE(content, ''), COALESCE(plain_text_content, ''), COALESCE(note, '')
  FROM (
    ${buildTopLevelUserMessagesCte('1 = 1')}
    SELECT m.* FROM messages m
    JOIN human_top_level_user_message_ids candidate ON candidate.id = m.id
  );
`
